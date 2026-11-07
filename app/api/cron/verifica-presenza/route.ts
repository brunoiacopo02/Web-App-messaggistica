import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { sendTemplateAndLog } from '@/lib/messaging';
import { sendFreeText } from '@/lib/twilio';
import { FILTRO_FUORI_LANCIO } from '@/lib/lancio-fase';
import { logCronQueryError } from '@/lib/cron-query-error';
import { mittenteDiConversazione } from '@/lib/mittente';
import { finestraApertaSuNumero } from '@/lib/finestra-numero';
import {
  verificaAccesa, inCoorteVerifica, decideVerifica, verificaVars, verificaText,
  prendiVerifica, rilasciaVerifica, segnaInviata, verificheGiaPrese, avvisaCrm,
  VERIFICA_ANTICIPO_MS, VERIFICA_ULTIMO_MS,
} from '@/lib/verifica-presenza';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

// Verifica presenza un'ora prima (PO 07/11/2026): ai lead confermati dalle Conferme il
// giorno prima, da T-60 a T-45 minuti, il bot chiede di confermare che ci saranno. Regole
// in lib/verifica-presenza.ts. Questa route fa solo invii, la presa in
// `verifiche_presenza` e l'avviso al CRM: non scrive mai esiti, bot_outcome o ai_status.
// La risposta del lead la registra il webhook in ingresso (`registraRispostaVerifica`).
//
// Interruttore: VERIFICA_1H_ENABLED=1. Template: VERIFICA_1H_TEMPLATE_SID (SID
// dell'account storico, tradotto per nome sugli altri account da sendTemplate).

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  if (req.headers.get('authorization') === `Bearer ${secret}`) return true;
  if (req.nextUrl.searchParams.get('secret') === secret) return true;
  return false;
}

type StatoCrm = {
  lead_id: string;
  conversation_id: number;
  appointment_date: string | null;
  conferme_outcome: string | null;
  conferme_outcome_at: string | null;
  presented: boolean | null;
  sales_outcome: string | null;
};

export async function GET(req: NextRequest) {
  if (!authorized(req)) return new NextResponse('unauthorized', { status: 401 });
  if (!verificaAccesa()) return NextResponse.json({ ok: true, skipped: 'disabled' });

  const supabase = getSupabaseAdmin();
  const now = Date.now();
  const sid = process.env.VERIFICA_1H_TEMPLATE_SID || null;

  // Le call per cui adesso può partire una verifica: fra T-60 e T-45.
  const { data: statoData, error: statoErr } = await supabase
    .from('crm_lead_status')
    .select('lead_id, conversation_id, appointment_date, conferme_outcome, conferme_outcome_at, presented, sales_outcome')
    .eq('conferme_outcome', 'confermato')
    .not('conversation_id', 'is', null)
    .gte('appointment_date', new Date(now + VERIFICA_ULTIMO_MS).toISOString())
    .lte('appointment_date', new Date(now + VERIFICA_ANTICIPO_MS).toISOString());
  if (statoErr) await logCronQueryError(supabase, 'verifica_presenza_query_error', statoErr);

  const coorte = ((statoData ?? []) as StatoCrm[]).filter((r) =>
    !r.presented && !r.sales_outcome && inCoorteVerifica({
      confermeOutcome: r.conferme_outcome,
      confermeOutcomeAt: r.conferme_outcome_at,
      appointmentAt: r.appointment_date,
    }));
  if (coorte.length === 0) return NextResponse.json({ ok: true, sent: 0, skipped: 0 });

  const { data: convData, error: convErr } = await supabase
    .from('conversations')
    .select('id, crm_lead_id, ai_paused_at, cancel_requested_at, wa_number, last_inbound_at, last_inbound_number, leads(phone_e164, first_name)')
    .in('id', coorte.map((r) => r.conversation_id))
    .or(FILTRO_FUORI_LANCIO);
  if (convErr) await logCronQueryError(supabase, 'verifica_presenza_query_error', convErr);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const convs = new Map<number, any>(((convData ?? []) as any[]).map((c) => [c.id as number, c]));
  const prese = await verificheGiaPrese(supabase, coorte.map((r) => r.conversation_id));

  let sent = 0;
  let skipped = 0;
  for (const r of coorte) {
    const c = convs.get(r.conversation_id);
    const phone = c?.leads?.phone_e164 as string | undefined;
    const callMs = r.appointment_date ? Date.parse(r.appointment_date) : NaN;
    if (!c || !phone || Number.isNaN(callMs)) { skipped++; continue; }
    const appuntamentoAt = new Date(callMs).toISOString();

    // Sempre dal numero della chat: quello da cui il lead ha ricevuto l'agenda o con cui
    // ha parlato (il webhook porta la chat sul numero a cui il lead scrive).
    const from = mittenteDiConversazione(c);
    const confMs = r.conferme_outcome_at ? Date.parse(r.conferme_outcome_at) : NaN;
    const disdettaMs = c.cancel_requested_at ? Date.parse(c.cancel_requested_at) : NaN;

    const canale = decideVerifica({
      enabled: true,
      callMs,
      nowMs: now,
      chatDelLead: c.crm_lead_id === r.lead_id,
      aiPausedAt: c.ai_paused_at ?? null,
      disdettaDopoConferma: !Number.isNaN(disdettaMs) && !Number.isNaN(confMs) && disdettaMs > confMs,
      giaInviata: prese.has(`${c.id}|${appuntamentoAt}`),
      finestraAperta: finestraApertaSuNumero(c, from, now),
      haTemplate: !!sid,
    });
    if (!canale) { skipped++; continue; }

    const presa = await prendiVerifica(supabase, { conversationId: c.id, crmLeadId: r.lead_id, appuntamentoAt });
    if (presa === null) { skipped++; continue; }

    const vars = verificaVars(c.leads?.first_name ?? null, callMs, now);
    const body = verificaText(vars);
    let ok = false;
    let errore: string | null = null;
    try {
      if (canale === 'template' && sid) {
        const res = await sendTemplateAndLog(supabase, c.id as number, phone, sid, 'Verifica presenza T-1h', from, vars, body);
        ok = res.ok;
        if (!res.ok) errore = res.error ?? 'invio del template fallito';
      } else {
        const tw = await sendFreeText({ to: phone, body, from });
        ok = true;
        await supabase.from('messages').insert({
          conversation_id: c.id, direction: 'out', body,
          twilio_sid: tw.sid, twilio_status: tw.status, sender: 'bot',
        });
        await supabase.from('conversations').update({ last_message_at: new Date().toISOString() }).eq('id', c.id);
      }
    } catch (err) {
      errore = err instanceof Error ? err.message : 'errore ignoto';
    }

    if (!ok) {
      await rilasciaVerifica(supabase, presa);
      await supabase.from('event_log').insert({
        type: 'verifica_presenza_error',
        payload: { conversationId: c.id, crmLeadId: r.lead_id, appuntamentoAt, canale } as never,
        message: `[verifica] conv ${c.id}: verifica presenza (${canale}) non partita: ${errore ?? 'errore ignoto'}`,
        level: 'error',
      });
      skipped++;
      continue;
    }

    const inviataAt = new Date().toISOString();
    await segnaInviata(supabase, presa, canale, inviataAt);
    const crm = await avvisaCrm({ evento: 'inviata', leadId: r.lead_id, appuntamentoAt, at: inviataAt, canale });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (supabase as any).from('verifiche_presenza')
      .update(crm.ok ? { crm_avvisato_at: inviataAt } : { crm_errore: crm.error ?? `http_${crm.status}` })
      .eq('id', presa);
    sent++;
    await supabase.from('event_log').insert({
      type: 'verifica_presenza_sent',
      payload: { conversationId: c.id, crmLeadId: r.lead_id, appuntamentoAt, canale, from, crm: crm.ok ? 'ok' : (crm.error ?? crm.status ?? null) } as never,
      message: `[verifica] conv ${c.id}: verifica presenza un'ora prima (${canale})${crm.ok ? '' : ' — CRM non avvisato'}`,
      level: crm.ok ? 'info' : 'warn',
    });
  }

  return NextResponse.json({ ok: true, sent, skipped });
}
