import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { verifySignature } from '@/lib/bot-hmac';
import { toE164 } from '@/lib/phone';
import {
  MARGINE_CHAT_MS, convPrincipale, leggiRichiesta, riepilogoPerFunnel, statoLead,
  type ConvRiepilogo, type ConvRiga, type MsgRiga,
} from '@/lib/statistiche-bf';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Una richiesta firmata vale 5 minuti: oltre e' una replica, non una domanda nuova. */
const VALIDITA_MS = 5 * 60 * 1000;
const PAGINA = 1000;
const BLOCCO_IN = 150;

const CONV_COLS = 'id, crm_lead_id, lead_id, created_at, last_message_at, wa_number, mario_braccio, bot_outcome, bot_outcome_at, ai_status';

function blocchi<T>(a: T[], n = BLOCCO_IN): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n));
  return out;
}

/** Legge tutte le pagine di una select (PostgREST restituisce al massimo 1000 righe). */
async function tutte<T>(pagina: (da: number, a: number) => PromiseLike<{ data: T[] | null; error: unknown }>): Promise<T[]> {
  const out: T[] = [];
  for (let da = 0; ; da += PAGINA) {
    const { data, error } = await pagina(da, da + PAGINA - 1);
    if (error) throw error;
    out.push(...(data ?? []));
    if (!data || data.length < PAGINA) return out;
  }
}

/**
 * Statistiche del Black Friday per il monitor del CRM (PO 09/11/2026), sola
 * lettura. Il CRM manda `{ts, dal, leads:[{id, ingresso, telefono}]}` firmato
 * come gli altri endpoint (`x-bot-signature`, BOT_WEBHOOK_SECRET); la richiesta
 * vale cinque minuti. Risponde con lo stato della chat di ciascun lead e il
 * riepilogo delle chat nate da `dal`, per funnel. Definizioni in
 * lib/statistiche-bf.ts. Nessun testo dei messaggi, nessun telefono in uscita.
 */
export async function POST(req: NextRequest) {
  const secret = process.env.BOT_WEBHOOK_SECRET;
  if (!secret) return NextResponse.json({ ok: false, error: 'not_configured' }, { status: 503 });

  const raw = await req.text();
  const firma = verifySignature(raw, req.headers.get('x-bot-signature'), secret);
  if (!firma.valid) return NextResponse.json({ ok: false, error: firma.reason }, { status: 401 });

  let richiesta: ReturnType<typeof leggiRichiesta>;
  try {
    richiesta = leggiRichiesta(JSON.parse(raw));
  } catch {
    return NextResponse.json({ ok: false, error: 'bad_json' }, { status: 400 });
  }
  if (!richiesta) return NextResponse.json({ ok: false, error: 'bad_request' }, { status: 400 });
  if (Math.abs(Date.now() - richiesta.ts) > VALIDITA_MS) {
    return NextResponse.json({ ok: false, error: 'stale' }, { status: 401 });
  }

  const sb = getSupabaseAdmin();
  const adesso = new Date();
  try {
    // 1. Chat per crm_lead_id.
    const ids = richiesta.leads.map((l) => l.id);
    const perId = new Map<string, ConvRiga[]>();
    for (const b of blocchi(ids)) {
      const righe = await tutte<ConvRiga>((da, a) => sb.from('conversations').select(CONV_COLS).in('crm_lead_id', b).order('id').range(da, a));
      for (const c of righe) {
        if (!c.crm_lead_id) continue;
        perId.set(c.crm_lead_id, [...(perId.get(c.crm_lead_id) ?? []), c]);
      }
    }

    // 2. Ripiego per telefono, solo per chi non ha una chat col suo id.
    const senza = richiesta.leads.filter((l) => !perId.has(l.id) && toE164(l.telefono));
    const perTelefono = new Map<string, ConvRiga[]>();
    if (senza.length > 0) {
      const telefoni = [...new Set(senza.map((l) => toE164(l.telefono)!))];
      const contatti: { id: number; phone_e164: string }[] = [];
      for (const b of blocchi(telefoni)) {
        const { data, error } = await sb.from('leads').select('id, phone_e164').in('phone_e164', b);
        if (error) throw error;
        contatti.push(...((data ?? []) as { id: number; phone_e164: string }[]));
      }
      const telefonoDi = new Map(contatti.map((c) => [c.id, c.phone_e164]));
      for (const b of blocchi([...telefonoDi.keys()])) {
        const righe = await tutte<ConvRiga>((da, a) => sb.from('conversations').select(CONV_COLS).in('lead_id', b).order('id').range(da, a));
        for (const c of righe) {
          const tel = c.lead_id !== null ? telefonoDi.get(c.lead_id) : undefined;
          if (tel) perTelefono.set(tel, [...(perTelefono.get(tel) ?? []), c]);
        }
      }
    }

    const scelte = richiesta.leads.map((l) => {
      const daId = convPrincipale(perId.get(l.id) ?? []);
      if (daId) return { l, conv: daId, per: 'crm_lead_id' as const };
      const tel = toE164(l.telefono);
      const daTel = tel ? convPrincipale(perTelefono.get(tel) ?? []) : null;
      return { l, conv: daTel, per: daTel ? ('telefono' as const) : null };
    });

    // 3. Messaggi delle chat scelte, dal primo ingresso (meno il margine): solo direzione, stato e ora.
    const convIds = [...new Set(scelte.flatMap((s) => (s.conv ? [s.conv.id] : [])))];
    const primo = Math.min(...richiesta.leads.map((l) => Date.parse(l.ingresso)));
    const messaggi: MsgRiga[] = [];
    if (convIds.length > 0) {
      const da = new Date(primo - MARGINE_CHAT_MS).toISOString();
      for (const b of blocchi(convIds)) {
        messaggi.push(...(await tutte<MsgRiga>((x, y) => sb.from('messages')
          .select('conversation_id, direction, twilio_status, created_at')
          .in('conversation_id', b).gte('created_at', da).order('id').range(x, y))));
      }
    }

    // 4. Riepilogo delle chat nate da `dal`, per funnel.
    const nuove = await tutte<ConvRiepilogo>((x, y) => sb.from('conversations')
      .select('crm_funnel, created_at, bot_outcome, last_inbound_at')
      .gte('created_at', richiesta.dal.toISOString()).order('id').range(x, y));

    return NextResponse.json(
      {
        ok: true,
        letto_alle: adesso.toISOString(),
        leads: scelte.map((s) => statoLead(s.l, s.conv, s.per, messaggi, adesso)),
        riepilogo: { dal: richiesta.dal.toISOString(), funnel: riepilogoPerFunnel(nuove, adesso) },
      },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch (e) {
    console.error('[statistiche-bf] lettura', e);
    return NextResponse.json({ ok: false, error: 'db' }, { status: 500 });
  }
}
