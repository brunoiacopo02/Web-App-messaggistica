import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { signPayload } from '@/lib/bot-hmac';
import { validateOutcomeBody, type BotOutcomeBody } from '@/lib/bot-contract';
import { buildEsitoRifiutatoNote } from '@/lib/arretrati';
import { fetchAllRows } from '@/lib/supabase/paginate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * Smaltimento delle due code arretrate concordate col CRM il 26/08/2026.
 *
 * Sta qui e non in uno script perche' il segreto vero (`BOT_WEBHOOK_SECRET`) vive su
 * Vercel: uno script locale firmerebbe con la copia di sviluppo e prenderebbe 401.
 *
 * POST { cosa: 'agenda-delivery' | 'esiti-403', esegui?: boolean, max?: number }
 * Senza `esegui` e' una prova a vuoto: dice cosa partirebbe e non manda niente.
 */

const URL_AGENDA = process.env.CRM_AGENDA_DELIVERED_URL
  ?? 'https://crm-sales-fenice.vercel.app/api/bot/agenda-delivery';
const URL_OUTCOME = process.env.CRM_OUTCOME_URL
  ?? 'https://crm-sales-fenice.vercel.app/api/bot/outcome';
const BUDGET_MS = 240_000;

type Supa = ReturnType<typeof getSupabaseAdmin>;

export async function POST(req: NextRequest) {
  const cron = process.env.CRON_SECRET;
  if (!cron || req.headers.get('authorization') !== `Bearer ${cron}`) {
    return new NextResponse('unauthorized', { status: 401 });
  }
  const secret = process.env.BOT_WEBHOOK_SECRET;
  if (!secret) return NextResponse.json({ ok: false, error: 'BOT_WEBHOOK_SECRET non impostato' }, { status: 503 });

  let body: { cosa?: string; esegui?: boolean; max?: number };
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'bad_json' }, { status: 400 }); }

  const esegui = body.esegui === true;
  const max = typeof body.max === 'number' && body.max > 0 ? Math.min(body.max, 1000) : 300;
  const admin = getSupabaseAdmin();

  if (body.cosa === 'agenda-delivery') return NextResponse.json(await agendaDelivery(admin, secret, esegui, max));
  if (body.cosa === 'esiti-403') return NextResponse.json(await esiti403(admin, secret, esegui, max));
  return NextResponse.json({ ok: false, error: "cosa: 'agenda-delivery' | 'esiti-403'" }, { status: 400 });
}

/**
 * Le agende recapitate di cui il CRM non ha mai saputo niente: l'avviso non partiva
 * perche' l'URL non era configurato, ma le status callback di Twilio sono passate. Lo
 * stato vero e' su `messages.twilio_status`, ed e' da li' che si recupera.
 */
async function agendaDelivery(admin: Supa, secret: string, esegui: boolean, max: number) {
  const sidAgenda = process.env.AGENDA_GDO_TEMPLATE_SID;
  if (!sidAgenda) return { ok: false, error: 'AGENDA_GDO_TEMPLATE_SID non impostato' };
  const started = Date.now();

  // Due insiemi: le consegne arrivate quando l'avviso non partiva, e quelle ancora
  // ferme su "inviato" da parte nostra.
  const tardive = await fetchAllRows<any>((from, to) => admin
    .from('event_log').select('payload').eq('type', 'gdo_agenda_consegna_tardiva').range(from, to));
  const ancora = await fetchAllRows<any>((from, to) => admin
    .from('conversations').select('id').eq('gdo_agenda_esito', 'inviato').not('crm_lead_id', 'is', null).range(from, to));

  // Gia' smaltite in un giro precedente. Senza questa marcatura le "consegne tardive"
  // rientrerebbero a ogni passata: allineare `gdo_agenda_esito` le toglie dal secondo
  // insieme ma non dal primo, e con 638 arretrati servono piu' giri.
  const smaltite = await fetchAllRows<any>((from, to) => admin
    .from('event_log').select('payload').eq('type', 'arretrato_agenda_avvisata').range(from, to));
  const fatte = new Set(smaltite.map((e: any) => Number(e.payload?.conversationId)));

  const ids = [...new Set([
    ...tardive.map((e: any) => e.payload?.conversationId).filter((x: unknown): x is number => typeof x === 'number'),
    ...ancora.map((c: any) => c.id),
  ])].filter((id) => !fatte.has(id));

  const convs: Array<{ id: number; crm_lead_id: string | null }> = [];
  for (let i = 0; i < ids.length; i += 80) {
    const { data } = await admin.from('conversations')
      .select('id, crm_lead_id').in('id', ids.slice(i, i + 80)).not('crm_lead_id', 'is', null);
    convs.push(...((data ?? []) as Array<{ id: number; crm_lead_id: string | null }>));
  }

  let consegnate = 0, avvisate = 0, fallite = 0;
  const esempi: Array<{ conv: number; lead: string; status: string }> = [];

  for (const c of convs) {
    if (avvisate >= max || Date.now() - started > BUDGET_MS) break;
    const { data: msgs } = await admin.from('messages')
      .select('twilio_sid, twilio_status').eq('conversation_id', c.id)
      .eq('template_sid', sidAgenda).order('created_at', { ascending: false }).limit(1);
    const riga = (msgs ?? [])[0] as { twilio_sid: string | null; twilio_status: string | null } | undefined;
    if (!riga || !['delivered', 'read'].includes(riga.twilio_status ?? '')) continue;
    consegnate++;
    if (esempi.length < 5) esempi.push({ conv: c.id, lead: c.crm_lead_id!, status: riga.twilio_status! });
    if (!esegui) continue;

    const payload = JSON.stringify({
      leadId: c.crm_lead_id, esito: 'consegnato', sid: riga.twilio_sid, at: new Date().toISOString(),
    });
    try {
      const r = await fetch(URL_AGENDA, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-bot-signature': signPayload(payload, secret) },
        body: payload,
      });
      if (r.ok) {
        // Il nostro esito si allinea solo se il CRM ha davvero preso l'avviso:
        // altrimenti perderemmo la possibilita' di riprovare.
        await admin.from('conversations').update({ gdo_agenda_esito: 'consegnato' }).eq('id', c.id);
        await admin.from('event_log').insert({
          type: 'arretrato_agenda_avvisata',
          payload: { conversationId: c.id, crmLeadId: c.crm_lead_id, sid: riga.twilio_sid } as never,
          message: `[bot-fissatore] avviso di consegna arretrato accettato dal CRM per lead ${c.crm_lead_id}`,
          level: 'info',
        });
        avvisate++;
      } else { fallite++; }
    } catch { fallite++; }
  }

  await admin.from('event_log').insert({
    type: 'arretrato_agenda_delivery',
    payload: { candidate: convs.length, consegnate, avvisate, fallite, esegui } as never,
    message: `[bot-fissatore] arretrato avvisi agenda: ${consegnate} consegnate davvero, ${avvisate} accettate dal CRM, ${fallite} fallite${esegui ? '' : ' (prova a vuoto)'}`,
    level: fallite > 0 ? 'warn' : 'info',
  });
  return { ok: true, cosa: 'agenda-delivery', candidate: convs.length, consegnate, avvisate, fallite, esegui, esempi };
}

/**
 * Gli esiti che il CRM ha rifiutato con 403 perche' il lead era gia' tornato a una
 * persona. Non c'e' niente da correggere: si manda una NOTA perche' il lavoro fatto
 * dal bot non sparisca. Una conversazione gia' rimandata non si rimanda due volte.
 */
async function esiti403(admin: Supa, secret: string, esegui: boolean, max: number) {
  const started = Date.now();

  const rifiutati = await fetchAllRows<any>((from, to) => admin
    .from('event_log').select('created_at, payload').eq('type', 'bot_outcome_rejected')
    .order('created_at', { ascending: true }).range(from, to));

  const gia = await fetchAllRows<any>((from, to) => admin
    .from('event_log').select('payload').eq('type', 'arretrato_esito_rinviato').range(from, to));
  const fatti = new Set(gia.map((e: any) => String(e.payload?.conversationId)));

  // Uno per conversazione, il piu' recente: se il bot ha preso due 403 sullo stesso
  // lead, la storia utile e' l'ultima.
  const perConv = new Map<number, { quando: string; payload: Record<string, unknown> }>();
  for (const e of rifiutati) {
    const conv = Number(e.payload?.conversationId);
    if (!Number.isFinite(conv) || fatti.has(String(conv))) continue;
    perConv.set(conv, { quando: e.created_at, payload: e.payload });
  }

  let inviate = 0, fallite = 0;
  const esempi: Array<{ conv: number; lead: string; outcome: string }> = [];

  for (const [conv, e] of perConv) {
    if (inviate >= max || Date.now() - started > BUDGET_MS) break;
    const leadId = typeof e.payload.crmLeadId === 'string' ? e.payload.crmLeadId : null;
    const outcome = typeof e.payload.outcome === 'string' ? e.payload.outcome : null;
    if (!leadId || !outcome) continue;

    const { data: conversazione } = await admin.from('conversations')
      .select('ai_objection_note, last_message_preview').eq('id', conv).maybeSingle();
    const note = buildEsitoRifiutatoNote({
      outcome,
      quandoIso: e.quando,
      discardReason: typeof e.payload.discardReason === 'string' ? e.payload.discardReason : null,
      leadWords: (conversazione as { ai_objection_note?: string | null } | null)?.ai_objection_note ?? null,
    });
    if (esempi.length < 5) esempi.push({ conv, lead: leadId, outcome });
    if (!esegui) continue;

    const corpo: BotOutcomeBody = { leadId, outcome: 'NOTA', note };
    if (!validateOutcomeBody(corpo).ok) continue;
    const raw = JSON.stringify(corpo);
    try {
      const r = await fetch(URL_OUTCOME, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-bot-signature': signPayload(raw, secret) },
        body: raw,
      });
      if (r.ok) {
        inviate++;
        // La marcatura vale come "questa conversazione e' stata smaltita": senza,
        // un secondo giro rimanderebbe le stesse note.
        await admin.from('event_log').insert({
          type: 'arretrato_esito_rinviato',
          payload: { conversationId: conv, crmLeadId: leadId, outcome } as never,
          message: `[bot-fissatore] esito ${outcome} del lead ${leadId} rimandato al CRM come nota`,
          level: 'info',
        });
      } else { fallite++; }
    } catch { fallite++; }
  }

  return { ok: true, cosa: 'esiti-403', candidate: perConv.size, inviate, fallite, esegui, esempi };
}
