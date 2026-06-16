import type { getSupabaseAdmin } from './supabase/admin';
import { generateMarioReply, type MarioTurn } from './mario';
import { sendFreeText } from './twilio';
import { marioDelayMs } from './mario-latency';

type Supa = ReturnType<typeof getSupabaseAdmin>;

export type AutoReplyGate = {
  toMatchesFenice: boolean;
  autoReplyOn: boolean;
  aiOwner: string | null;
  aiStatus: string | null;
};

/**
 * Pure: la conversazione è candidata all'auto-risposta di Mario? Vero per gli stati
 * 'active' e 'replying' (il lock CAS in drainMarioReplies serializza le esecuzioni
 * concorrenti). Falso per stati terminali ('handed_off' / 'booked') o non arruolati.
 */
export function shouldAutoReply(g: AutoReplyGate): boolean {
  if (!(g.toMatchesFenice && g.autoReplyOn && g.aiOwner === 'mario')) return false;
  return g.aiStatus === 'active' || g.aiStatus === 'replying';
}

type MsgRow = { direction: string; body: string };

/**
 * Pure: dato l'elenco messaggi in ordine cronologico, ritorna l'indice del primo
 * messaggio 'in' (lead) NON ancora gestito — cioè che viene dopo l'ultimo 'out'.
 * Ritorna -1 se non c'è nessun inbound da gestire.
 */
export function nextUnansweredInboundIndex(rows: MsgRow[]): number {
  let lastOut = -1;
  for (let i = 0; i < rows.length; i++) if (rows[i].direction === 'out') lastOut = i;
  for (let i = lastOut + 1; i < rows.length; i++) if (rows[i].direction === 'in') return i;
  return -1;
}

const MAX_REPLIES_PER_DRAIN = 8; // anti-runaway per singola esecuzione
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Best-effort: risponde a OGNI messaggio del lead non ancora gestito, uno alla volta,
 * in ordine, con latenza umana (5-40s) prima di ciascuna risposta. Serializzato tramite
 * lock CAS sulla conversazione (ai_status 'active' -> 'replying'). Non lancia: logga errori.
 */
export async function drainMarioReplies(
  supabase: Supa,
  conversationId: number,
  phone: string,
  delayMs: () => number = marioDelayMs,
): Promise<void> {
  const from = process.env.TWILIO_WHATSAPP_NUMBER_FENICE;
  if (!from) {
    await supabase.from('event_log').insert({
      type: 'fenice_ai_error', payload: { conversationId } as never,
      message: 'TWILIO_WHATSAPP_NUMBER_FENICE non configurato', level: 'error',
    });
    return;
  }

  // Lock: claim del turno. Se un'altra esecuzione sta già rispondendo, esci:
  // quel drain ricontrolla i messaggi a ogni giro e gestirà anche questo inbound.
  const { data: claimed } = await supabase
    .from('conversations')
    .update({ ai_status: 'replying' })
    .eq('id', conversationId)
    .eq('ai_status', 'active')
    .select('id');
  if (!claimed || claimed.length === 0) return;

  let finalStatus = 'active';
  try {
    for (let n = 0; n < MAX_REPLIES_PER_DRAIN; n++) {
      const { data: rows } = await supabase
        .from('messages')
        .select('direction, body, created_at')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: true })
        .limit(200);

      const all = (rows ?? []) as MsgRow[];
      const idx = nextUnansweredInboundIndex(all);
      if (idx === -1) break;

      const history: MarioTurn[] = all.slice(0, idx + 1).map((m) => ({
        role: m.direction === 'in' ? 'user' : 'assistant',
        content: m.body,
      }));

      await sleep(delayMs());
      const result = await generateMarioReply(history);

      if (result.visibleReply) {
        const sent = await sendFreeText({ to: phone, body: result.visibleReply, from });
        await supabase.from('messages').insert({
          conversation_id: conversationId, direction: 'out', body: result.visibleReply,
          twilio_sid: sent.sid, twilio_status: sent.status,
        });
        await supabase.from('conversations')
          .update({ last_message_at: new Date().toISOString() })
          .eq('id', conversationId);
      }

      await supabase.from('event_log').insert({
        type: 'fenice_ai_reply',
        payload: { conversationId, phone, appointmentFixed: result.appointmentFixed, passToHuman: result.passToHuman } as never,
        message: `Mario ha risposto a ${phone}`, level: 'info',
      });

      if (result.passToHuman) { finalStatus = 'handed_off'; break; }
      if (result.appointmentFixed) { finalStatus = 'booked'; break; }
    }
  } catch (err) {
    const m = err instanceof Error ? err.message : 'errore';
    await supabase.from('event_log').insert({
      type: 'fenice_ai_error', payload: { conversationId, phone, error: m } as never,
      message: `Auto-risposta Mario fallita per ${phone}: ${m}`, level: 'error',
    });
    finalStatus = 'active';
  } finally {
    await supabase.from('conversations').update({ ai_status: finalStatus }).eq('id', conversationId);
  }
}
