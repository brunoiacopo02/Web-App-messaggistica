import type { getSupabaseAdmin } from './supabase/admin';
import { sendFreeText } from './twilio';
import { romeHour } from './rome-time';

const H = 3600_000;

/** Quanto deve essere vecchia l'agenda inviata perché parta il follow-up. */
export const AGENDA_FOLLOWUP_DELAY_MS = 2 * H;
/**
 * Segnale "agenda inviata" nel flusso attuale: Mario manda in chat il link del
 * form di prenotazione (JotForm). NON usiamo più il template legacy AGENDA_TEMPLATE_SID,
 * fermo dal 19/06 e inviato a lead ormai freddi. Il link in chat individua i lead
 * davvero ingaggiati, ancora dentro la finestra 24h.
 */
export const BOOKING_LINK_MATCH = 'jotform.com/240755654585063';
/** Finestra di servizio WhatsApp: free-text lecito solo entro 24h dall'ultimo inbound. */
export const WINDOW_MS = 24 * H;
/** Fascia oraria (Rome) in cui è lecito inviare il follow-up. */
export const FOLLOWUP_HOUR_START = 9;
export const FOLLOWUP_HOUR_END = 21; // escluso: invia solo se ora < 21

export interface AgendaFollowupInput {
  agendaSentAtMs: number;
  nowMs: number;
  terminal: boolean;
  followupAlreadySent: boolean;
  lastInboundAtMs: number | null;
  lastMessageIsInbound: boolean;
  romeHour: number;
}

/** Decide se mandare il singolo follow-up agenda. Puro, niente effetti. */
export function decideAgendaFollowup(input: AgendaFollowupInput): 'send' | 'none' {
  if (input.terminal) return 'none';
  if (input.followupAlreadySent) return 'none';
  // Se l'ultimo messaggio è un inbound non ancora risposto, il backstop cron
  // genera già una risposta contestuale: evitare il follow-up canned per non
  // sovrapporre due messaggi e per non disturbare chi ha appena confermato l'appuntamento.
  if (input.lastMessageIsInbound) return 'none';
  if (input.nowMs - input.agendaSentAtMs < AGENDA_FOLLOWUP_DELAY_MS) return 'none';
  if (input.lastInboundAtMs === null) return 'none';
  if (input.nowMs - input.lastInboundAtMs >= WINDOW_MS) return 'none';
  if (input.romeHour < FOLLOWUP_HOUR_START || input.romeHour >= FOLLOWUP_HOUR_END) return 'none';
  return 'send';
}

/** Testo fisso del follow-up, in voce Mario. */
export function agendaFollowupText(firstName: string | null): string {
  const hi = firstName && firstName.trim() ? `Ciao ${firstName.trim()}` : 'Ciao';
  return `${hi} 🙂 ti avevo mandato gli orari per la videocall ma non ho ancora visto la conferma. Vuoi che ti tenga uno slot? Dimmi pure giorno e ora che preferisci.`;
}

type Supa = ReturnType<typeof getSupabaseAdmin>;

/**
 * Invia (idempotente) un singolo follow-up free-text ai lead a cui Mario ha mandato
 * il link di prenotazione (l'agenda) da >= 2h e che non hanno ancora preso l'appuntamento.
 * Rispetta finestra 24h e fascia oraria. Marca `bot_followups_sent` per non ripetere.
 */
export async function runAgendaFollowups(
  supabase: Supa,
  now: Date = new Date(),
): Promise<{ sent: number; skipped: number }> {
  const from = process.env.TWILIO_WHATSAPP_NUMBER_FENICE;
  if (!from) return { sent: 0, skipped: 0 };

  const nowMs = now.getTime();
  const twoHAgo = new Date(nowMs - AGENDA_FOLLOWUP_DELAY_MS).toISOString();
  const dayAgo = new Date(nowMs - WINDOW_MS).toISOString();

  // 1. Link di prenotazione inviato tra 24h e 2h fa (oltre 24h la finestra è chiusa).
  const { data: agendaMsgs } = await supabase
    .from('messages')
    .select('conversation_id, created_at')
    .eq('direction', 'out')
    .ilike('body', `%${BOOKING_LINK_MATCH}%`)
    .not('twilio_status', 'in', '(failed,undelivered)')
    .lte('created_at', twoHAgo)
    .gte('created_at', dayAgo)
    .order('created_at', { ascending: false });

  const agendaAtByConv = new Map<number, number>();
  for (const m of (agendaMsgs ?? []) as unknown as { conversation_id: number; created_at: string }[]) {
    if (!agendaAtByConv.has(m.conversation_id)) {
      agendaAtByConv.set(m.conversation_id, Date.parse(m.created_at));
    }
  }
  const convIds = [...agendaAtByConv.keys()];
  if (convIds.length === 0) return { sent: 0, skipped: 0 };

  // 2. Stato delle conversazioni candidate.
  const { data: convs } = await supabase
    .from('conversations')
    .select('id, lead_id, ai_status, bot_outcome, bot_followups_sent')
    .in('id', convIds);

  const leadIds = [...new Set((convs ?? []).map((c) => c.lead_id))];
  const { data: leads } = await supabase
    .from('leads')
    .select('id, phone_e164, first_name')
    .in('id', leadIds);
  const leadById = new Map((leads ?? []).map((l) => [l.id, l]));

  const hour = romeHour(now);
  let sent = 0;
  let skipped = 0;

  for (const c of (convs ?? []) as any[]) {
    const agendaSentAtMs = agendaAtByConv.get(c.id);
    if (agendaSentAtMs === undefined) { skipped++; continue; }
    const lead = leadById.get(c.lead_id);
    const phone = lead?.phone_e164 as string | undefined;

    // Ultimo inbound del lead → finestra 24h.
    const { data: lastIn } = await supabase
      .from('messages')
      .select('created_at')
      .eq('conversation_id', c.id)
      .eq('direction', 'in')
      .order('created_at', { ascending: false })
      .limit(1);
    const lastInboundAtMs = lastIn && lastIn[0] ? Date.parse(lastIn[0].created_at) : null;

    // Ultimo messaggio in qualsiasi direzione → evita follow-up se il lead
    // ha già scritto e il backstop sta già gestendo la risposta.
    const { data: lastMsg } = await supabase
      .from('messages')
      .select('direction')
      .eq('conversation_id', c.id)
      .order('created_at', { ascending: false })
      .limit(1);
    const lastMessageIsInbound = lastMsg?.[0]?.direction === 'in';

    const decision = decideAgendaFollowup({
      agendaSentAtMs,
      nowMs,
      terminal: c.bot_outcome != null
        || c.ai_status === 'closed'
        || c.ai_status === 'booked'
        || c.ai_status === 'handed_off',
      followupAlreadySent: (c.bot_followups_sent ?? 0) >= 1,
      lastInboundAtMs,
      lastMessageIsInbound,
      romeHour: hour,
    });

    if (decision === 'none' || !phone) { skipped++; continue; }

    const body = agendaFollowupText((lead?.first_name as string | null) ?? null);
    const msg = await sendFreeText({ to: phone, body, from });
    await supabase.from('messages').insert({
      conversation_id: c.id, direction: 'out', body,
      twilio_sid: msg.sid, twilio_status: msg.status,
    });
    await supabase.from('conversations')
      .update({ bot_followups_sent: (c.bot_followups_sent ?? 0) + 1, last_message_at: now.toISOString() })
      .eq('id', c.id);
    await supabase.from('event_log').insert({
      type: 'agenda_followup_sent',
      payload: { conversationId: c.id, phone } as never,
      message: `Follow-up agenda inviato a ${phone}`,
      level: 'info',
    });
    sent++;
  }

  return { sent, skipped };
}
