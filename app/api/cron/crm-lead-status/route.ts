import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { signPayload } from '@/lib/bot-hmac';
import {
  parseLeadStatusPage,
  toRow,
  mergeLatched,
  prossimoCursore,
  type CrmLeadStatus,
  type CrmLeadStatusRow,
} from '@/lib/crm-lead-status';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const DEFAULT_URL = 'https://crm-sales-fenice.vercel.app/api/bot/lead-status';
const CURSOR_KEY = 'crm_lead_status_cursor';
// Il primo giro parte da qui: il bot non ha lavorato niente prima.
const PRIMO_SINCE = '2026-06-01T00:00:00+02:00';
const LIMIT = 200;
// La funzione muore a 300s. Ci si ferma prima e si salva comunque il cursore: un run
// troncato da Vercel non scriverebbe niente e il giro dopo ripartirebbe da capo.
const BUDGET_MS = 240_000;
const MAX_PAGINE = 40;

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  if (req.headers.get('authorization') === `Bearer ${secret}`) return true;
  if (req.nextUrl.searchParams.get('secret') === secret) return true;
  return false;
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return new NextResponse('unauthorized', { status: 401 });

  const secret = process.env.BOT_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json({ ok: false, error: 'BOT_WEBHOOK_SECRET non impostato' }, { status: 503 });
  }

  const admin = getSupabaseAdmin();
  const url = process.env.CRM_LEAD_STATUS_URL ?? DEFAULT_URL;
  const started = Date.now();

  // Il cursore vive in `app_settings`: sopravvive ai deploy e non dipende dall'ultima
  // riga scritta, che potrebbe essere stata scartata.
  const { data: settings } = await admin
    .from('app_settings').select('value').eq('key', CURSOR_KEY).maybeSingle();
  const partenza = typeof settings?.value === 'string' ? settings.value : PRIMO_SINCE;
  // Un `since` forzato in query serve a rileggere una finestra passata senza toccare il
  // cursore salvato (`?since=...&dry=1` per provare senza scrivere).
  let since = req.nextUrl.searchParams.get('since') ?? partenza;
  const dry = req.nextUrl.searchParams.get('dry') === '1';

  let pagine = 0;
  let letti = 0;
  let scritti = 0;
  let scartate = 0;
  let bloccato = false;
  let errore: string | null = null;

  while (pagine < MAX_PAGINE && Date.now() - started < BUDGET_MS) {
    const rawBody = JSON.stringify({ since, limit: LIMIT });
    let json: unknown;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-bot-signature': signPayload(rawBody, secret) },
        body: rawBody,
      });
      if (!res.ok) {
        errore = `http_${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`;
        break;
      }
      json = await res.json();
    } catch (e) {
      errore = e instanceof Error ? e.message : 'errore di rete';
      break;
    }

    const parsed = parseLeadStatusPage(json);
    if (!parsed.ok) { errore = parsed.reason; break; }
    const page = parsed.page;
    pagine++;
    letti += page.leads.length;
    scartate += page.scartate;

    if (page.leads.length > 0 && !dry) {
      try {
        scritti += await salvaPagina(admin, page.leads);
      } catch (e) {
        errore = e instanceof Error ? e.message : 'scrittura fallita';
        break;
      }
    }

    const avanti = prossimoCursore(since, page);
    since = avanti.since;
    bloccato = avanti.bloccato;
    if (!avanti.continua) break;
  }

  // Il cursore si salva anche quando il giro si e' interrotto a meta': le pagine gia'
  // scritte sono scritte, e ripartire da prima significherebbe rileggerle ogni volta.
  if (!dry && since !== partenza) {
    await admin.from('app_settings').upsert(
      { key: CURSOR_KEY, value: since as never, updated_at: new Date().toISOString() },
      { onConflict: 'key' },
    );
  }

  await admin.from('event_log').insert({
    type: 'crm_lead_status',
    payload: { pagine, letti, scritti, scartate, since, bloccato, dry, errore } as never,
    message: errore
      ? `[bot-fissatore] stato lead dal CRM interrotto: ${errore} (${letti} letti, ${scritti} scritti)`
      : `[bot-fissatore] stato lead dal CRM: ${letti} letti, ${scritti} scritti in ${pagine} pagine`,
    level: errore ? 'error' : 'info',
  });

  return NextResponse.json({ ok: !errore, pagine, letti, scritti, scartate, since, bloccato, dry, errore });
}

/** Aggancia le conversazioni, applica il latch su presenza/vendita, scrive. */
async function salvaPagina(
  admin: ReturnType<typeof getSupabaseAdmin>,
  leads: CrmLeadStatus[],
): Promise<number> {
  const ids = leads.map((l) => l.leadId);

  const { data: convs } = await admin
    .from('conversations').select('id, crm_lead_id').in('crm_lead_id', ids);
  const perLead = new Map<string, number>();
  for (const c of (convs ?? []) as Array<{ id: number; crm_lead_id: string | null }>) {
    if (c.crm_lead_id) perLead.set(c.crm_lead_id, c.id);
  }

  const { data: esistenti } = await admin
    .from('crm_lead_status').select('lead_id, presented, presented_at, sold').in('lead_id', ids);
  const gia = new Map<string, { presented: boolean; presented_at: string | null; sold: boolean }>();
  for (const r of (esistenti ?? []) as Array<{ lead_id: string; presented: boolean; presented_at: string | null; sold: boolean }>) {
    gia.set(r.lead_id, { presented: r.presented, presented_at: r.presented_at, sold: r.sold });
  }

  const rows: CrmLeadStatusRow[] = leads.map((l) =>
    mergeLatched(gia.get(l.leadId) ?? null, toRow(l, perLead.get(l.leadId) ?? null)));

  const { error } = await admin.from('crm_lead_status').upsert(rows as never, { onConflict: 'lead_id' });
  if (error) throw new Error(error.message);
  return rows.length;
}
