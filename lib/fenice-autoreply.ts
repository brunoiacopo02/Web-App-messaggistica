import type { getSupabaseAdmin } from './supabase/admin';
import { generateMarioReply, type MarioTurn } from './mario';
import { sendFreeText } from './twilio';
import { marioDelayMs } from './mario-latency';
import { splitMarioMessages } from './mario-split';
import { ensureConfirmationBlock, containsVideoLink } from './confirmation-block';
import { unknownFeniceLinks } from './outbound-sanitize';
import { generateBotReport } from './bot-report';
import { sendOutcome } from './bot-outcome';
import { personaForConversation, PERSONA_NAME } from './persona';

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
 *
 * Il lucchetto del drain vive su `ai_lock_at`, non più dentro `ai_status`: durante
 * un turno lo stato di prodotto resta leggibile, e un crash prima del `finally` non
 * lascia la riga bloccata (ci pensa il TTL, vedi `isLockStale`).
 *
 * 'replying' resta fra gli stati ammessi perché in produzione esistono righe ferme
 * su quel valore dal vecchio meccanismo: devono restare gestibili.
 */
export function shouldAutoReply(g: AutoReplyGate): boolean {
  if (!(g.toMatchesFenice && g.autoReplyOn && g.aiOwner === 'mario')) return false;
  return g.aiStatus === 'active' || g.aiStatus === 'replying';
}

/**
 * Pure: la conversazione va riaperta (portata a 'active') all'arrivo di un messaggio
 * del lead? Vero solo per 'closed' (dopo un esito non-appuntamento) — copre anche i
 * lead arruolati a mano, senza `crm_lead_id`, che con la vecchia condizione inline
 * (`crm_lead_id && ai_status === 'closed'`) restavano fuori del tutto. 'booked' NON
 * si riapre (vedi il commento su `shouldAutoReply`: `ai_status` fa anche da lucchetto
 * del drain, claimarlo perderebbe lo stato "appuntamento fissato" durante il turno).
 * Falso per 'handed_off': se un umano ha preso in carico la chat, il bot non rientra.
 */
export function shouldReopen(g: { aiOwner: string | null; aiStatus: string | null }): boolean {
  if (g.aiOwner !== 'mario') return false;
  return g.aiStatus === 'closed';
}

/**
 * Pure: possiamo mandare un esito al CRM per questa conversazione?
 * 'booked' non è un veto sul CRM ma sul lucchetto: ai_status fa anche da lock del
 * drain, quindi una conv booked non viene mai claimata e qui non arriva. Resta per
 * sicurezza (rete a costo zero, vedi `shouldAutoReply`). Gli esiti su un appuntamento
 * già fissato invece passano: `sendOutcome` li traduce in una NOTA, che il CRM
 * registra senza toccare lo stato del lead e notifica alle Conferme — non è più un
 * POST `APPUNTAMENTO` duplicato (vedi `sendOutcome`).
 */
export function canSendOutcome(g: { crmLeadId: string | null; aiStatus: string | null }): boolean {
  if (!g.crmLeadId) return false;
  return g.aiStatus !== 'booked';
}

type MsgRow = { direction: string; body: string };
// Riga del drain: come MsgRow ma con il template per derivare la persona (Mario/Marta).
type DrainMsgRow = MsgRow & { template_sid: string | null };

/** SID dei template "Marta" (aperture A/B + sequenza + riaggancio) dalle env.
 *  Env assenti ⇒ set vuoto ⇒ persona sempre Mario (comportamento identico a oggi). */
export function martaSidsFromEnv(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const keys = [
    'OPENING_SID_C1', 'OPENING_SID_C2',
    'OPENING_SID_T1', 'OPENING_SID_T2',
    'OPENING_SID_J1', 'OPENING_SID_J2',
    'MARTA_SEQ_TEMPLATE_SID_1', 'MARTA_SEQ_TEMPLATE_SID_2',
    'MARTA_SEQ_TEMPLATE_SID_3', 'MARTA_SEQ_TEMPLATE_SID_4',
    'MARTA_REENGAGE_TEMPLATE_SID',
  ];
  return new Set(keys.map((k) => env[k]).filter((v): v is string => !!v));
}

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

/** Dopo questo tempo un lucchetto è considerato abbandonato (processo morto). */
export const LOCK_TTL_MS = 10 * 60_000;

/**
 * Pure: il lucchetto va forzato? Assente no (è libero), illeggibile sì — meglio
 * riprovare che restare bloccati per sempre su un valore corrotto.
 */
export function isLockStale(lockAt: string | null, nowMs: number, ttlMs: number = LOCK_TTL_MS): boolean {
  if (lockAt === null) return false;
  const t = Date.parse(lockAt);
  if (Number.isNaN(t)) return true;
  return nowMs - t >= ttlMs;
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
 * round. Serializzato tramite lock CAS su `ai_lock_at` (con TTL). Non lancia.
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
  // Il lucchetto vive su ai_lock_at: ai_status resta lo stato di prodotto, così una
  // conversazione ammissibile non viene esclusa dal claim solo perché un'altra
  // esecuzione le aveva riscritto lo stato. Un lucchetto più vecchio di LOCK_TTL_MS
  // è di un processo morto e si può scavalcare.
  const nowIso = new Date().toISOString();
  const staleCutoff = new Date(Date.now() - LOCK_TTL_MS).toISOString();
  const { data: claimed } = await supabase
    .from('conversations')
    .update({ ai_lock_at: nowIso })
    .eq('id', conversationId)
    .eq('ai_status', 'active')
    .or(`ai_lock_at.is.null,ai_lock_at.lt.${staleCutoff}`)
    .select('id, ai_started_at, crm_lead_id')
    .single();
  if (!claimed) return;
  const startedAt = (claimed as { ai_started_at: string | null }).ai_started_at;
  const crmLeadId = (claimed as { crm_lead_id: string | null }).crm_lead_id;

  // Carica i messaggi della conversazione dall'arruolamento in poi (in ordine).
  async function loadHistory(): Promise<DrainMsgRow[]> {
    let q = supabase
      .from('messages')
      .select('direction, body, template_sid, created_at')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true })
      .limit(200);
    if (startedAt) q = q.gte('created_at', startedAt);
    const { data } = await q;
    return (data ?? []) as DrainMsgRow[];
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
      // Persona dal primo template outbound: aperture Marta ⇒ Marta, legacy ⇒ Mario.
      // Senza env Marta configurate il set è vuoto ⇒ sempre Mario (zero regressioni).
      const martaSids = martaSidsFromEnv();
      const persona = martaSids.size > 0 ? personaForConversation(rows, martaSids) : 'mario';
      const result = await generateMarioReply(history, { personaName: PERSONA_NAME[persona] });

      // Invia ogni a-capo come messaggio separato (più umano), con breve pausa.
      let parts = splitMarioMessages(result.visibleReply);

      // Link Fenice che il modello si è inventato (es. `conferenza-zx`): il lead lo
      // riceverebbe senza che ne resti traccia da nessuna parte. Non blocchiamo
      // l'invio — è un segnale diagnostico, non un filtro — ma l'URL fasullo va
      // registrato per poterlo ritrovare.
      const linkInventati = parts.flatMap((p) => unknownFeniceLinks(p));
      if (linkInventati.length > 0) {
        await supabase.from('event_log').insert({
          type: 'unknown_fenice_link',
          payload: { conversationId, links: linkInventati } as never,
          message: `[bot-fissatore] conv ${conversationId}: link Fenice non ufficiale in uscita: ${linkInventati.join(', ')}`,
          level: 'warn',
        });
      }

      // `appointmentFixed` è vero anche quando il modello RI-emette il tag su una
      // conversazione già fissata (il lead riconferma giorno e ora dopo la riapertura):
      // in quel turno il blocco non va toccato, altrimenti il passaggio FATTO uscirebbe
      // una seconda volta staccato da qualsiasi video. Il video già inviato in un turno
      // precedente è il segnale che il blocco è già stato mandato; se invece il link
      // esce proprio adesso, la cronologia non lo contiene ancora e la patch si applica.
      const videoGiaInviato = rows.some((m) => m.direction === 'out' && containsVideoLink(m.body));
      if (result.appointmentFixed && !videoGiaInviato) {
        const block = ensureConfirmationBlock(parts);
        parts = block.parts;
        if (block.added.length > 0 || block.missingVideoLink) {
          await supabase.from('event_log').insert({
            type: 'confirmation_block_patched',
            payload: { conversationId, added: block.added, missingVideoLink: block.missingVideoLink } as never,
            message: `[bot-fissatore] blocco conferma incompleto sulla conversazione ${conversationId}: aggiunti [${block.added.join(', ')}]${block.missingVideoLink ? ', link video assente' : ''}`,
            level: block.missingVideoLink ? 'warn' : 'info',
          });
        }
      }
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

      if (result.outcome) {
        // Il drain claima solo da 'active' (vedi il lock CAS sopra): aiStatus qui è
        // sempre 'active'. Il ramo 'booked' di canSendOutcome resta comunque la rete
        // a costo zero descritta nel suo commento.
        const canSend = canSendOutcome({ crmLeadId, aiStatus: 'active' });
        if (canSend) {
          const report = await generateBotReport(history);
          const sent = await sendOutcome(supabase, conversationId, {
            outcome: result.outcome,
            date: result.scheduledAt,
            discardReason: result.discardReason,
            note: result.note,
            report,
          });
          // Esito CRM: chiudiamo se il callback è andato a buon fine; altrimenti
          // restiamo 'active' (ritentabile). In ogni caso usciamo: i rami legacy
          // (booked/handed_off) non valgono per i lead CRM.
          // 'note_duplicate' non è un fallimento ritentabile: la nota non è partita
          // perché era già partita prima, quindi l'esito è terminale e la
          // conversazione va chiusa qui (sendOutcome la chiude già a DB, ma il
          // `finally` di questo drain riscriverebbe finalStatus sopra).
          if (sent.sent || sent.error === 'note_duplicate') finalStatus = 'closed';
          break;
        }
      }

      if (result.passToHuman) { finalStatus = 'handed_off'; break; }

      if (result.videoWatched) {
        await supabase.from('event_log').insert({
          type: 'video_watched',
          payload: { conversationId, crmLeadId } as never,
          message: `[bot-fissatore] conv ${conversationId}: il lead conferma di aver visto il video pre-call`,
          level: 'info',
        });
      }

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
    // Rilascio del lucchetto insieme allo stato finale: se il drain muore prima,
    // ci pensa il TTL (isLockStale) invece di lasciare la riga bloccata per sempre.
    await supabase
      .from('conversations')
      .update({ ai_status: finalStatus, ai_lock_at: null })
      .eq('id', conversationId);
  }
}
