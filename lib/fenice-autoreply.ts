import type { getSupabaseAdmin } from './supabase/admin';
import { generateMarioReply, type MarioTurn } from './mario';
import { gdoContextNote } from './gdo-context-note';
import { gdoVideoText } from './gdo-agenda';
import { sendFreeText } from './twilio';
import { marioDelayMs } from './mario-latency';
import { splitMarioMessages } from './mario-split';
import { ensureConfirmationBlock, containsVideoLink } from './confirmation-block';
import { unknownFeniceLinks } from './outbound-sanitize';
import { generateBotReport } from './bot-report';
import { sendOutcome } from './bot-outcome';
import { personaForConversation, PERSONA_NAME, OPENING_ENV_KEYS } from './persona';
import { confermaVideoVisto } from './video-visto';

type Supa = ReturnType<typeof getSupabaseAdmin>;

export type AutoReplyGate = {
  toMatchesFenice: boolean;
  autoReplyOn: boolean;
  aiOwner: string | null;
  aiStatus: string | null;
  /** Valorizzato = un umano ha preso le redini della chat (vedi `shouldAutoReply`). */
  aiPausedAt?: string | null;
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
 *
 * `ai_paused_at` è il fermo manuale ed è un veto che viene prima di tutto: lo mette
 * un umano dal pannello quando prende in carico la chat. Vive su una colonna sua e
 * non su `ai_status` proprio perché nessun turno del bot lo possa riscrivere per
 * sbaglio — a differenza dello stato, che il `finally` del drain rimaneggia a ogni giro.
 */
export function shouldAutoReply(g: AutoReplyGate): boolean {
  if (g.aiPausedAt) return false;
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
 * Falso anche col fermo manuale attivo: riaprire non farebbe rispondere il bot
 * (`shouldAutoReply` ha il suo veto) ma mostrerebbe 'active' su una chat che è in
 * mano a una persona.
 */
export function shouldReopen(g: {
  aiOwner: string | null;
  aiStatus: string | null;
  aiPausedAt?: string | null;
}): boolean {
  if (g.aiPausedAt) return false;
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
    ...OPENING_ENV_KEYS,
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

/**
 * Pure: il re-drive del cron deve scattare per questo inbound?
 *
 * Il re-drive è una rete di sicurezza, non un ciclo. Deve partire una volta sola per
 * inbound rimasto senza risposta: quando un turno produce solo tag e nessun testo
 * visibile non viene scritta nessuna riga outbound, `lastIsUnansweredInbound` resta
 * vero, e senza questa guardia lo stesso esito ripartirebbe ogni ora fino al tetto dei
 * 5 giorni. È il loop che il CRM vede come "lo stesso APPUNTAMENTO ogni ora" (conv
 * 3728: 32 ripetizioni a gap 1.00h fra il 01/08 e il 03/08).
 *
 * `ultimoDrainMs` è l'istante dell'ultimo giro di drain su questa conversazione, letto
 * dagli eventi `fenice_ai_reply` che il drain scrive a ogni giro andato a termine. Se
 * il drain è morto a metà l'evento non c'è, e il re-drive riparte: è voluto.
 */
export function serveRedrive(input: {
  ultimoInboundMs: number;
  ultimoDrainMs: number | null;
  nowMs: number;
  maxMs: number;
}): boolean {
  if (input.nowMs - input.ultimoInboundMs > input.maxMs) return false;
  if (input.ultimoDrainMs === null) return true;
  return input.ultimoInboundMs > input.ultimoDrainMs;
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

/**
 * Pure: questo turno è il turno del video? Vero solo per una conversazione in
 * modalità postino (`gdo_agenda_at` valorizzato) che ha il link del video e non
 * l'ha ancora mandato. È la risposta alla PRIMA risposta del lead: il video deve
 * essere quel messaggio, non aggiungersi a una risposta del modello.
 */
export function shouldSendGdoVideo(g: {
  gdoAgendaAt: string | null;
  gdoVideoUrl: string | null;
  gdoVideoSentAt: string | null;
}): boolean {
  if (!g.gdoAgendaAt) return false;
  if (!g.gdoVideoUrl) return false;
  return !g.gdoVideoSentAt;
}

/** Parole che da sole non chiedono niente: una presa d'atto, non un messaggio. */
const PRESE_DATTO = new Set([
  'ok', 'okay', 'oki', 'okey', 'va', 'bene', 'vabene', 'vabbene', 'vabbe', 'perfetto',
  'ottimo', 'grazie', 'mille', 'graz', 'si', 'certo', 'ricevuto', 'daccordo', 'accordo',
  'ciao', 'salve', 'buongiorno', 'buonasera', 'buonpomeriggio', 'ok👍', 'd',
]);

/**
 * Pure: questo messaggio del lead è solo una presa d'atto?
 *
 * Serve a decidere se il video del GDO può essere l'UNICA risposta a quel messaggio.
 * Fail-safe verso il "no": nel dubbio risponde il modello, perché il costo di
 * sbagliare in quella direzione è un messaggio in più, mentre nell'altra è una domanda
 * del lead che non riceve MAI risposta (conv 3647, 3661, 3676, 3704).
 */
export function isSoloPresaDAtto(body: string | null | undefined): boolean {
  const raw = (body ?? '').trim();
  if (!raw) return true; // media senza testo: non c'è nessuna domanda a cui rispondere
  if (raw.includes('?')) return false;
  const parole = raw
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parole.length === 0) return true; // solo emoji o punteggiatura
  if (parole.length > 4) return false;
  return parole.every((p) => PRESE_DATTO.has(p));
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
    .is('ai_paused_at', null) // fermo manuale: la chat è di un umano, non si claima
    .or(`ai_lock_at.is.null,ai_lock_at.lt.${staleCutoff}`)
    .select('id, ai_started_at, crm_lead_id, gdo_agenda_at, gdo_video_url, gdo_video_sent_at, gdo_video_watched_at, gdo_video_followups_sent, gdo_noemi_reminded_at, leads(first_name)')
    .single();
  if (!claimed) return;
  const startedAt = (claimed as { ai_started_at: string | null }).ai_started_at;
  const crmLeadId = (claimed as { crm_lead_id: string | null }).crm_lead_id;

  // Modalità postino: lead di un GDO, arruolato da `enrollGdoLeadAsPostino`.
  // Il bot fa da canale ma il lead non è nostro: niente esiti, niente stati terminali.
  const gdo = claimed as {
    gdo_agenda_at?: string | null;
    gdo_video_url?: string | null;
    gdo_video_sent_at?: string | null;
    gdo_video_watched_at?: string | null;
    gdo_video_followups_sent?: number | null;
    gdo_noemi_reminded_at?: string | null;
    leads?: { first_name?: string | null } | null;
  };
  const gdoAgendaAt = gdo.gdo_agenda_at ?? null;
  const gdoVideoUrl = gdo.gdo_video_url ?? null;
  const postino = gdoAgendaAt !== null;
  let gdoVideoSentAt = gdo.gdo_video_sent_at ?? null;
  let gdoVideoWatchedAt = gdo.gdo_video_watched_at ?? null;
  // Non incrementato qui: il contatore dei solleciti lo muove solo il cron dedicato.
  const gdoFollowupsSent = gdo.gdo_video_followups_sent ?? 0;
  let gdoNoemiRemindedAt = gdo.gdo_noemi_reminded_at ?? null;
  let gdoVideoMissingLogged = false;

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

      // Il messaggio del lead a cui stiamo rispondendo in questo giro.
      const inboundIdx = nextUnansweredInboundIndex(rows);
      const inboundBody = inboundIdx >= 0 ? (rows[inboundIdx].body ?? '') : '';
      // Un link del video già uscito in questa chat: serve sia alla patch del blocco
      // conferma, sia alla rete di sicurezza sul FATTO qui sotto.
      const videoGiaInviato = rows.some((m) => m.direction === 'out' && containsVideoLink(m.body));

      /** Manda il video del GDO come bolla a sé e ne registra l'invio. */
      const inviaVideoGdo = async (): Promise<void> => {
        const body = gdoVideoText(gdo.leads?.first_name ?? null, gdoVideoUrl as string);
        const sent = await sendFreeText({ to: phone, body, from });
        await supabase.from('messages').insert({
          conversation_id: conversationId, direction: 'out', body,
          twilio_sid: sent.sid, twilio_status: sent.status,
          sender: 'bot',
        });
        const sentAt = new Date().toISOString();
        await supabase.from('conversations')
          .update({ gdo_video_sent_at: sentAt, last_message_at: sentAt })
          .eq('id', conversationId);
        await supabase.from('event_log').insert({
          type: 'gdo_video_sent',
          payload: { conversationId, phone, crmLeadId, video: gdoVideoUrl } as never,
          message: `[gdo] video inviato a ${phone} dopo la risposta del lead`,
          level: 'info',
        });
        gdoVideoSentAt = sentAt;
      };

      const videoDaMandare = shouldSendGdoVideo({ gdoAgendaAt, gdoVideoUrl, gdoVideoSentAt });
      // Il video può essere l'UNICA risposta solo se il lead non ha chiesto niente. Se
      // ha fatto una domanda o un'obiezione, il modello risponde e il video esce
      // insieme: prima il video partiva al posto della risposta, l'ultimo messaggio
      // diventava outbound e quella domanda non riceveva risposta mai più.
      const videoDaSolo = videoDaMandare && isSoloPresaDAtto(inboundBody);
      const videoInsiemeAllaRisposta = videoDaMandare && !videoDaSolo;

      if (videoDaSolo) {
        await inviaVideoGdo();
        continue; // eventuali altri messaggi del lead li gestisce il round successivo
      }
      if (postino && !gdoVideoUrl && !gdoVideoMissingLogged) {
        // Non si inventa un link: si segnala e si lascia rispondere il modello,
        // meglio una risposta senza video che il silenzio del bot.
        gdoVideoMissingLogged = true;
        await supabase.from('event_log').insert({
          type: 'gdo_video_missing',
          payload: { conversationId, crmLeadId } as never,
          message: `[gdo] conv ${conversationId}: modalità postino senza link video, il lead non lo riceverà`,
          level: 'error',
        });
      }

      const history: MarioTurn[] = rows.map((m) => ({
        role: m.direction === 'in' ? 'user' : 'assistant',
        content: m.body,
      }));
      // Persona dal primo template outbound: aperture Marta ⇒ Marta, legacy ⇒ Mario.
      // Senza env Marta configurate il set è vuoto ⇒ sempre Mario (zero regressioni).
      const martaSids = martaSidsFromEnv();
      // I lead dei GDO ricevono l'agenda firmata Marta: la conversazione prosegue con
      // quel nome, altrimenti il lead si vedrebbe rispondere da qualcun altro.
      const persona = postino
        ? 'marta'
        : martaSids.size > 0
          ? personaForConversation(rows, martaSids)
          : 'mario';
      const result = await generateMarioReply(history, {
        personaName: PERSONA_NAME[persona],
        // I promemoria pendenti (video non confermato, Noemi non ancora spiegata)
        // viaggiano dentro il contesto: il modello li integra nel discorso invece di
        // farli arrivare come un messaggio programmato addosso.
        ...(postino
          ? {
              contextNote: gdoContextNote({
                gdoVideoSentAt: gdoVideoSentAt,
                gdoVideoWatchedAt: gdoVideoWatchedAt,
                gdoNoemiRemindedAt: gdoNoemiRemindedAt,
                followupsSent: gdoFollowupsSent,
                videoAppenaConfermato: false,
                videoInUscita: videoInsiemeAllaRisposta,
              }),
            }
          : {}),
      });

      // Il lead può confermare di aver visto il video PRIMA che gli sia mai arrivato
      // un sollecito (gdo_video_followups_sent resta 0 per sempre): in quel caso
      // `serveNoemi` non scatterebbe mai da nessuno dei due canali e Noemi non
      // verrebbe mai nominata. Qui lo sappiamo subito dopo il primo giro — si rifà
      // UNA sola chiamata con la nota aggiornata e si sostituisce solo il TESTO da
      // mandare: gli esiti del primo giro (outcome, passToHuman, appointmentFixed,
      // videoWatched...) restano quelli letti dal messaggio vero del lead. Non li si
      // ricalcola sul secondo giro: il suo unico scopo è infilarci il promemoria di
      // Noemi, e la nota in più che gli passiamo lo distoglierebbe dal resto del
      // turno — il primo giro li ha già letti puliti.
      let visibleReply = result.visibleReply;
      let watchedAt: string | null = null;
      // Rete di sicurezza: il tag [VIDEO_VISTO] il modello se lo dimentica nel 40% dei
      // casi. Se il video è già uscito e il lead scrive "fatto"/"visto", vale come
      // conferma anche senza tag — altrimenti continua a ricevere solleciti dopo aver
      // fatto quello che gli avevamo chiesto.
      const videoLinkInviato = videoGiaInviato || !!gdoVideoSentAt;
      const videoConfermato =
        result.videoWatched ||
        (videoLinkInviato && !gdoVideoWatchedAt && confermaVideoVisto(inboundBody));
      if (videoConfermato) watchedAt = new Date().toISOString();
      // Niente rigenerazione se il turno ha prodotto un esito o un passaggio umano:
      // "l'ho visto, ma voglio annullare" vale insieme videoWatched e disdetta, e la
      // NOTA_NOEMI ("diglielo adesso") sostituirebbe la risposta giusta con un
      // promemoria della preselezione mentre al CRM parte la nota di annullamento.
      if (postino && videoConfermato && !gdoNoemiRemindedAt && !result.outcome && !result.passToHuman) {
        try {
          const retry = await generateMarioReply(history, {
            personaName: PERSONA_NAME[persona],
            contextNote: gdoContextNote({
              gdoVideoSentAt: gdoVideoSentAt,
              gdoVideoWatchedAt: watchedAt, // appena confermato: sopprime NOTA_VIDEO nella nota
              gdoNoemiRemindedAt: gdoNoemiRemindedAt,
              followupsSent: gdoFollowupsSent,
              videoAppenaConfermato: true, // forza NOTA_NOEMI anche a followupsSent 0
              videoInUscita: videoInsiemeAllaRisposta,
            }),
          });
          // Fail-safe: una rigenerazione vuota non vale meno di zero, vale come un
          // fallimento — si manda comunque la prima risposta, il lead non resta muto.
          if (retry.visibleReply?.trim()) visibleReply = retry.visibleReply;
        } catch (err) {
          const m = err instanceof Error ? err.message : 'errore';
          await supabase.from('event_log').insert({
            type: 'gdo_noemi_regen_failed',
            payload: { conversationId } as never,
            message: `[gdo] conv ${conversationId}: rigenerazione per il promemoria di Noemi fallita, mandata la prima risposta — ${m}`,
            level: 'warn',
          });
        }
      }

      // Invia ogni a-capo come messaggio separato (più umano), con breve pausa.
      let parts = splitMarioMessages(visibleReply);

      // Il video esce in coda alla risposta, come ultima bolla: prima si risponde a
      // quello che il lead ha chiesto, poi gli si dà il video.
      if (videoInsiemeAllaRisposta) {
        parts = [...parts, gdoVideoText(gdo.leads?.first_name ?? null, gdoVideoUrl as string)];
      }

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
          sender: 'bot',
        });
      }
      if (parts.length > 0) {
        await supabase.from('conversations')
          .update({ last_message_at: new Date().toISOString() })
          .eq('id', conversationId);
      }

      if (videoInsiemeAllaRisposta) {
        const sentAt = new Date().toISOString();
        await supabase.from('conversations')
          .update({ gdo_video_sent_at: sentAt })
          .eq('id', conversationId);
        await supabase.from('event_log').insert({
          type: 'gdo_video_sent',
          payload: { conversationId, phone, crmLeadId, video: gdoVideoUrl, conRisposta: true } as never,
          message: `[gdo] video inviato a ${phone} insieme alla risposta del modello`,
          level: 'info',
        });
        gdoVideoSentAt = sentAt;
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
          // Sui lead del GDO niente report: al CRM va solo la nota, e il report
          // popolerebbe campi di un lead che non è nostro.
          const report = postino ? undefined : await generateBotReport(history);
          const sent = await sendOutcome(supabase, conversationId, {
            outcome: result.outcome,
            date: result.scheduledAt,
            discardReason: result.discardReason,
            note: result.note,
            // `note` e `discardReason` sono la sintesi del modello. Le Conferme hanno
            // chiesto anche le parole vere del lead: sono l'ultimo turno della
            // cronologia, l'unica cosa che non e' una parafrasi.
            leadWords: [...history].reverse().find((t) => t.role === 'user')?.content,
            report,
          }, postino ? { noteOnly: true } : {});
          // Esito CRM: chiudiamo se il callback è andato a buon fine; altrimenti
          // restiamo 'active' (ritentabile). In ogni caso usciamo: i rami legacy
          // (booked/handed_off) non valgono per i lead CRM.
          // 'note_duplicate' non è un fallimento ritentabile: la nota non è partita
          // perché era già partita prima, quindi l'esito è terminale e la
          // conversazione va chiusa qui (sendOutcome la chiude già a DB, ma il
          // `finally` di questo drain riscriverebbe finalStatus sopra).
          // Postino: la conversazione non si chiude mai per un esito. Il lead è del
          // GDO, il bot resta il suo canale su questa chat.
          // `keepOpen`: il CRM è stato informato con una nota (RICHIAMO senza una data
          // utilizzabile) ma la conversazione NON è esitata — il bot deve poter ancora
          // chiedere al lead quando gli va bene, invece di sparire.
          if (!postino && !sent.keepOpen && (sent.sent || sent.error === 'note_duplicate')) {
            finalStatus = 'closed';
          }
          break;
        }
      }

      if (result.passToHuman) {
        // Il CRM ha un esito apposta (CONTATTO_UMANO, dal 05/08). Senza questa chiamata
        // la richiesta di parlare con una persona resta solo nel nostro database e
        // nessuno la vede: 6 casi fra i 338 lead che ci hanno segnalato come fermi.
        // Le parole che mandiamo sono quelle del lead, prese dall'ultimo turno della
        // cronologia — una parafrasi del modello cambierebbe il senso della richiesta.
        if (crmLeadId) {
          const ultimoDelLead = [...history].reverse().find((t) => t.role === 'user')?.content;
          const esito = await sendOutcome(supabase, conversationId, {
            outcome: 'CONTATTO_UMANO',
            note: ultimoDelLead,
          });
          // Un CRM che non risponde non deve tenere il bot incollato a una chat che
          // deve prendere una persona: si registra e si va avanti.
          if (!esito.sent) {
            await supabase.from('event_log').insert({
              type: 'contatto_umano_non_segnalato',
              payload: { conversationId, crmLeadId, error: esito.error ?? null, status: esito.status ?? null } as never,
              message: `[bot-fissatore] conv ${conversationId}: passaggio a una persona non segnalato al CRM (${esito.error ?? esito.status})`,
              level: 'error',
            });
          }
        }
        finalStatus = 'handed_off';
        break;
      }

      if (videoConfermato && watchedAt) {
        // Il log non si interroga per decidere: la conferma serve al cron dei solleciti,
        // che deve smettere di scrivere a chi il video l'ha già visto. Si persiste
        // comunque, indipendentemente da come sia andata la rigenerazione sopra.
        await supabase.from('conversations')
          .update({ gdo_video_watched_at: watchedAt })
          .eq('id', conversationId);
        gdoVideoWatchedAt = watchedAt;

        await supabase.from('event_log').insert({
          type: 'video_watched',
          payload: { conversationId, crmLeadId, daTag: result.videoWatched } as never,
          message: `[bot-fissatore] conv ${conversationId}: il lead conferma di aver visto il video pre-call`,
          level: 'info',
        });
      }

      // Si segna il promemoria solo se è davvero uscito nel testo mandato al lead
      // (quello rigenerato, se la rigenerazione è scattata): iniettare la nota non
      // garantisce che il modello l'abbia detto, e segnarlo a vuoto significherebbe
      // non ripeterlo mai più.
      if (postino && !gdoNoemiRemindedAt && /\bNoemi\b/i.test(visibleReply ?? '')) {
        gdoNoemiRemindedAt = new Date().toISOString();
        await supabase.from('conversations')
          .update({ gdo_noemi_reminded_at: gdoNoemiRemindedAt })
          .eq('id', conversationId);
      }

      if (result.appointmentFixed) {
        // Postino: l'appuntamento l'ha preso il GDO, non è un esito nostro da
        // registrare — e 'booked' non è claimabile, il bot resterebbe muto.
        if (postino) break;
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
        // NON si va su 'booked': quello stato protegge un appuntamento REGISTRATO
        // (`bot_outcome` valorizzato) dal declassamento, ed è anche il lucchetto del
        // drain — quindi congela la chat per sempre. Qui non c'è nulla da proteggere:
        // il bot ha solo intuito l'appuntamento senza leggerne la data. Restando
        // 'active' al turno dopo può chiedere giorno e ora, e allora sì che l'esito
        // parte e lo stato diventa terminale per davvero.
        // (Caso reale conv 3401: il lead ha scritto altre due volte nel vuoto.)
        break;
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
    // Rilascio del lucchetto insieme allo stato finale, ma solo se il turno è ancora
    // NOSTRO: fra il claim e qui possono essere successe due cose, e in entrambe
    // riscrivere `ai_status` significa cancellare la decisione di qualcun altro.
    //   1) un umano ha fermato il bot dal pannello (`ai_paused_at` valorizzato);
    //   2) un altro drain ha scavalcato il lucchetto scaduto e sta gestendo lui il turno.
    // L'update cieco che c'era prima riportava la conversazione ad 'active' in tutti e
    // due i casi: è il motivo per cui un fermo manuale deciso a metà turno spariva dopo
    // pochi secondi e il bot ripartiva (conv 3748, 1/08/2026).
    // Se il drain muore prima di arrivare qui, il lucchetto lo sblocca il TTL (isLockStale).
    const { data: rilasciate } = await supabase
      .from('conversations')
      .update({ ai_status: finalStatus, ai_lock_at: null })
      .eq('id', conversationId)
      .eq('ai_lock_at', nowIso)
      .is('ai_paused_at', null)
      .select('id');
    if (!rilasciate || rilasciate.length === 0) {
      // Lo stato non si tocca, ma il lucchetto — se è ancora il nostro — va comunque
      // liberato: è il caso del fermo manuale, dove nessun altro processo lo scioglierà.
      await supabase
        .from('conversations')
        .update({ ai_lock_at: null })
        .eq('id', conversationId)
        .eq('ai_lock_at', nowIso);
    }
  }
}
