import type { getSupabaseAdmin } from './supabase/admin';
import { generateMarioReply, type MarioTurn } from './mario';
import { sendFreeText } from './twilio';
import { marioDelayMs } from './mario-latency';
import { splitMarioMessages } from './mario-split';
import { generateBotReport } from './bot-report';
import { sendOutcome } from './bot-outcome';

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

/** Pure: l'ultimo messaggio della conversazione è un inbound del lead non ancora risposto?
 *  Vero quando esiste un inbound dopo l'ultimo outbound (cioè il bot deve ancora rispondere). */
export function lastIsUnansweredInbound(rows: MsgRow[]): boolean {
  return nextUnansweredInboundIndex(rows) !== -1;
}

export const REPLYING_ORPHAN_MS = 10 * 60_000;

/**
 * Pure: il lock 'replying' è orfano (drain killato) e va recuperato dal backstop?
 * Vero solo se lo stato è 'replying' e l'ultimo inbound è più vecchio della soglia.
 */
export function isOrphanedReplyingLock(
  aiStatus: string | null,
  lastInboundAtMs: number | null,
  nowMs: number,
  thresholdMs = REPLYING_ORPHAN_MS,
): boolean {
  if (aiStatus !== 'replying') return false;
  if (lastInboundAtMs == null) return false;
  return nowMs - lastInboundAtMs >= thresholdMs;
}

const MAX_ROUNDS_PER_DRAIN = 5; // anti-runaway: round di accorpamento per esecuzione
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Best-effort: ACCORPA i messaggi del lead. Attende la finestra di latenza (5-40s) e poi
 * risponde UNA volta a tutti i messaggi arrivati (cronologia dall'arruolamento in poi,
 * via ai_started_at). Se durante l'attesa/elaborazione arrivano altri messaggi, fa un altro
 * round. Serializzato tramite lock CAS (ai_status 'active' -> 'replying'). Non lancia.
 * `delayMs` è iniettabile: il cron passa `() => 0` per saltare la finestra di accorpamento
 * (il lead ha già aspettato).
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
  // quel drain ricontrolla i messaggi e gestirà anche questo inbound.
  const { data: claimed } = await supabase
    .from('conversations')
    .update({ ai_status: 'replying' })
    .eq('id', conversationId)
    .eq('ai_status', 'active')
    .select('id, ai_started_at, crm_lead_id')
    .single();
  if (!claimed) return;
  const startedAt = (claimed as { ai_started_at: string | null }).ai_started_at;
  const crmLeadId = (claimed as { crm_lead_id: string | null }).crm_lead_id;

  // Carica i messaggi della conversazione dall'arruolamento in poi (in ordine).
  async function loadHistory(): Promise<MsgRow[]> {
    let q = supabase
      .from('messages')
      .select('direction, body, created_at')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true })
      .limit(200);
    if (startedAt) q = q.gte('created_at', startedAt);
    const { data } = await q;
    return (data ?? []) as MsgRow[];
  }

  let finalStatus = 'active';
  try {
    for (let round = 0; round < MAX_ROUNDS_PER_DRAIN; round++) {
      const before = await loadHistory();
      if (nextUnansweredInboundIndex(before) === -1) break; // niente di nuovo da gestire

      // Finestra di accorpamento: aspetta, poi ricarica per includere ciò che è arrivato.
      await sleep(delayMs());
      const rows = await loadHistory();
      if (nextUnansweredInboundIndex(rows) === -1) break;

      const history: MarioTurn[] = rows.map((m) => ({
        role: m.direction === 'in' ? 'user' : 'assistant',
        content: m.body,
      }));
      const result = await generateMarioReply(history);

      // Invia ogni a-capo come messaggio separato (più umano), con breve pausa.
      const parts = splitMarioMessages(result.visibleReply);
      for (let i = 0; i < parts.length; i++) {
        if (i > 0) await sleep(Math.min(3000, 800 + parts[i].length * 25));
        const sent = await sendFreeText({ to: phone, body: parts[i], from });
        await supabase.from('messages').insert({
          conversation_id: conversationId, direction: 'out', body: parts[i],
          twilio_sid: sent.sid, twilio_status: sent.status,
        });
      }
      if (parts.length > 0) {
        await supabase.from('conversations')
          .update({ last_message_at: new Date().toISOString() })
          .eq('id', conversationId);
      }

      await supabase.from('event_log').insert({
        type: 'fenice_ai_reply',
        payload: { conversationId, phone, appointmentFixed: result.appointmentFixed, passToHuman: result.passToHuman } as never,
        message: `Mario ha risposto a ${phone}`, level: 'info',
      });

      if (crmLeadId && result.outcome) {
        const report = await generateBotReport(history);
        const sent = await sendOutcome(supabase, conversationId, {
          outcome: result.outcome,
          date: result.scheduledAt,
          discardReason: result.discardReason,
          note: result.note,
          report,
        });
        // Esito CRM: chiudiamo solo se il callback è andato a buon fine; altrimenti
        // restiamo 'active' (ritentabile). In ogni caso usciamo: i rami legacy
        // (booked/handed_off) non valgono per i lead CRM.
        if (sent.sent) finalStatus = 'closed';
        break;
      }

      if (result.passToHuman) { finalStatus = 'handed_off'; break; }
      if (result.appointmentFixed) {
        // Lead CRM con appuntamento fissato ma senza outcome parsato (es. data
        // mancante): il callback non partirà — segnala subito, il watchdog del
        // cron farà da rete a 24h. (Caso reale: conv 3061 del 15/07.)
        if (crmLeadId) {
          await supabase.from('event_log').insert({
            type: 'booked_without_outcome',
            payload: { conversationId, crmLeadId } as never,
            message: `[bot-fissatore] conv ${conversationId}: appuntamento fissato ma outcome non parsato, callback CRM NON inviata`,
            level: 'error',
          });
        }
        finalStatus = 'booked'; break;
      }
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
