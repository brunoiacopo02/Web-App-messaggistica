import type { getSupabaseAdmin } from './supabase/admin';
import { generateMarioReply, type MarioTurn } from './mario';
import { datePiene, tettoGiornaliero } from './booking-capienza';
import { gdoContextNote, serveNoemi, type GdoNoteInput } from './gdo-context-note';
import {
  accodaDomanda, decidiDomanda, domandaInAttesa, eRispostaDaNotare, motivoRiscaldamento, notaDomandaGiaFatta, notaRisposta,
  parlaDAltro, parlaDiDisdireOSpostare, riscaldamentoInerte, RISCALDAMENTO_CHIUSO, testoRispostaCompleto, togliDomandaRifatta,
  type DomandaDecisa,
} from './gdo-warmup';
import { gdoVideoText } from './gdo-agenda';
import { decideGdoRecap, gdoRecapText } from './gdo-recap';
import { claimRecap, rilasciaRecap } from './gdo-recap-send';
import { sendFreeText } from './twilio';
import { marioDelayMs } from './mario-latency';
import { splitMarioMessages } from './mario-split';
import { ensureConfirmationBlock, containsVideoLink } from './confirmation-block';
import { unknownFeniceLinks } from './outbound-sanitize';
import { generateBotReport } from './bot-report';
import { registraEsitoSenzaLeadId, sendOutcome, inviaNotaAlCrm } from './bot-outcome';
import { stopDalCrmPerLead, vuolePassaggioAUmano } from './stop-crm';
import { buildScriveDopoLaCallNote, motivoScartoAppuntamento, TESTO_DATA_DA_VERIFICARE, unisciGiorni } from './bot-outcome-rules';
import { giorniDelLinkForm } from './booking-slots';
import { paroleDellaRichiesta } from './contatti-umani';
import { bookingBlackout } from './booking-blackout';
import type { BotOutcome } from './bot-contract';
import { personaForConversation, PERSONA_NAME, OPENING_ENV_KEYS } from './persona';
import { confermaVideoVisto } from './video-visto';
import { notaPrimoContatto } from './primo-contatto-note';
import { haCongedo, lancioInCorso, marioDopoNotte, risposteRiscaldamento } from './lancio-fase';
import { eseguiTurnoLancio } from './lancio-turno';
import { congedoDaRevocare } from './lancio-classifica';
import {
  lancioStandardDrain, lancioStandardContextNote, linkSviluppatoreContextNote, eventoLancioPassato,
  bloccaPassaggioLancio, NOTA_LANCIO_NIENTE_PASSAGGIO, TESTO_LANCIO_NIENTE_PASSAGGIO, pulsanteDopoNotteContextNote,
  iscrittoDopoLiveContextNote,
} from './lancio-followup';
import { LANCIO_INGRESSO_LINK_SVILUPPATORE } from './primo-messaggio';
import { eStudenteOfferta, STUDENTI_CONTEXT_NOTE } from './studenti-offerta';
import { getLancioSettings, type LancioSettings } from './lancio-settings';
import { alertUnaVolta } from './alert-una-volta';
import type { LancioInfo } from './lancio-crm';
import { mittenteDiConversazione } from './mittente';
import { brochureContextNote, professioniContextNote, professioniVince, richiestaSchedaFuoriFunnel, schedaDaInviare, schedaSubito } from './professioni-nota';
import { isSlugProfessione, PROVENIENZA_PROFESSIONI } from './professioni';
import { inviaScheda, testoScheda } from './scheda-invio';
import { fissatoIlDi } from './noemi-quando';
import {
  dataCallDelBot,
  giorniSpostamento,
  motivoDataNonValida,
  motivoNonSpostabile,
  notaSpostamentoPrompt,
  origineSpostamento,
  spostamentoAbilitato,
  richiamoNonESpostamento,
  spostamentoGiaRifiutato,
  testoSpostamentoFatto,
  testoSpostamentoNonFatto,
  ultimoLinkVideo,
  type MotivoNonSpostabile,
} from './gdo-spostamento';
import {
  giaSpostatoDalBot, inviaSpostamentoAlCrm, registraSpostamentoInChat, spostamentiRifiutati, statoCrmLocale, ultimoSpostamentoDalBot,
} from './gdo-spostamento-send';
import { isoWithOffset } from './bot-contract';
import { sameInstant } from './rome-time';

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
 *
 * Falso, infine, per una chat del lancio dove il congedo e' gia' uscito
 * (`lancio_info.congedo_at`, vedi `haCongedo`): quella persona ha detto che non le
 * interessa e le abbiamo risposto che non le scriviamo piu'. Se riscrive, riaprire la
 * rimetterebbe in mano al bot — a Mario, per giunta, visto che la fase e' terminale —
 * proprio dopo una promessa di silenzio. La restituzione di fine lancio (B5) sa gia'
 * dove trovarla. I chiamanti che non leggono le colonne del lancio non passano questi
 * campi e si comportano come prima.
 *
 * Il congedo pero' si puo' sciogliere (piano 2026-10-01, Task 3): se il lead riscrive
 * con una domanda o un ripensamento (`revocaCongedoLancio`) il webhook toglie
 * `congedo_at` PRIMA di chiamare questa funzione, e da li' la chat si riapre come
 * qualunque chat 'closed' di Mario.
 *
 * Falso anche per una chat del lancio in fase `restituito`: il lead e' tornato al pool
 * del CRM (ruling C8).
 */
export function shouldReopen(g: {
  aiOwner: string | null;
  aiStatus: string | null;
  aiPausedAt?: string | null;
  lancioSlug?: string | null;
  lancioInfo?: unknown;
  lancioFase?: string | null;
}): boolean {
  if (g.aiPausedAt) return false;
  if (g.aiOwner !== 'mario') return false;
  if (g.lancioSlug && haCongedo(g.lancioInfo)) return false;
  // Restituito al pool (B5, ruling C8): il lead e' del CRM, non del bot. Riaprire qui
  // rimetterebbe Mario su una persona che un GDO sta chiamando. Il webhook avvisa il CRM.
  if (g.lancioSlug && g.lancioFase === 'restituito') return false;
  return g.aiStatus === 'closed';
}

/**
 * Pure: il congedo del lancio va sciolto per questo inbound? (piano 2026-10-01, Task 3)
 *
 * Fino al 1/10 chi era stato congedato restava muto per sempre, anche quando riscriveva
 * per chiedere: conv 22484 "Vorrei sapere del percorso", "Durata, modalità di
 * svolgimento e prezzo"; conv 21596 "È possibile avere una registrazione? O ci sarà una
 * altra data per lo meno?". Nessuno dei due ha avuto risposta.
 *
 * Vero solo per una chat del lancio di Mario col congedo marcato e un testo che NON e'
 * un rifiuto, una protesta o una chiusura di cortesia (`congedoDaRevocare`). Mai col
 * fermo manuale, mai su una chat passata a una persona, mai su un restituito (e' del CRM,
 * ruling C8). Lo stato deve essere 'closed' (congedo accettato dal CRM) o 'active'
 * (congedo con lo scarto ancora da ritentare): 'replying' vuol dire un turno in volo, e
 * cambiargli fase e marcatori sotto i piedi e' peggio di aspettare il messaggio dopo.
 */
export function revocaCongedoLancio(g: {
  aiOwner: string | null;
  aiStatus: string | null;
  aiPausedAt?: string | null;
  handedOffAt?: string | null;
  lancioSlug?: string | null;
  lancioInfo?: unknown;
  lancioFase?: string | null;
  testo: string;
}): boolean {
  if (g.aiPausedAt || g.handedOffAt) return false;
  if (g.aiOwner !== 'mario') return false;
  if (g.aiStatus !== 'closed' && g.aiStatus !== 'active') return false;
  if (!g.lancioSlug || g.lancioFase === 'restituito') return false;
  if (!haCongedo(g.lancioInfo)) return false;
  return congedoDaRevocare(g.testo);
}

export type AdoptGate = {
  toMatchesFenice: boolean;
  /** INBOUND_ADOPTION_ENABLED === '1' */
  adoptionOn: boolean;
  /** L'interruttore generale dell'auto-risposta, dal pannello (vedi `shouldAutoReply`). */
  autoReplyOn: boolean;
  aiOwner: string | null;
  aiPausedAt?: string | null;
  handedOffAt?: string | null;
  /** Esiste una QUALUNQUE riga in uscita su questa conversazione, anche senza SID. */
  hasOutbound: boolean;
  /** L'inbound corrente e' il pulsante del webinar (lib/primo-messaggio.ts): la storia
   *  della chat non conta, la richiesta e' esplicita e fatta adesso. */
  lancioPulsante?: boolean;
};

/**
 * Pure: il bot prende in carico una conversazione che nessuno possiede?
 *
 * Fino al 04/09/2026 rispondeva solo ai lead arruolati dall'intake del CRM: chi scriveva
 * per primo non aveva padrone e restava zitto. 29 persone su 43 arrivate dal canale
 * Telegram fra il 26/08 e il 04/09 non hanno mai ricevuto una risposta, con un silenzio
 * mediano di 113 ore.
 *
 * `hasOutbound` conta QUALUNQUE riga in uscita, anche di un invio fallito: se qualcuno ha
 * provato a scrivere a questa persona, la chat ha una storia che qui non conosciamo. È
 * anche ciò che tiene fuori le campagne e la inbox, dove il primo messaggio è sempre
 * nostro. È il criterio OPPOSTO a quello di `apreSopraChatViva` (in `fenice-enroll.ts`),
 * la guardia sull'apertura dentro `enrollLeadIntoMario`, che guarda solo agli outbound
 * partiti davvero: là serve sapere se il lead ha visto qualcosa, qui se qualcuno ha provato.
 *
 * `autoReplyOn` è l'interruttore generale del pannello, e qui è un veto come gli altri:
 * non si adotta chi non si può servire. Lo si spegne durante un incidente, cioè proprio
 * quando il bot non deve rispondere — e una conversazione adottata ma muta è fuori da
 * tutte e tre le reti di recupero (`adotta-mai-risposti` cerca `ai_owner` nullo,
 * `bot-followups` un `crm_lead_id` valorizzato, `riapri-mute` una riga in uscita).
 */
export function shouldAdoptInbound(g: AdoptGate): boolean {
  if (!g.toMatchesFenice || !g.adoptionOn || !g.autoReplyOn) return false;
  if (g.aiOwner !== null) return false;
  if (g.aiPausedAt || g.handedOffAt) return false;
  if (g.lancioPulsante) return true;
  return !g.hasOutbound;
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
type DrainMsgRow = MsgRow & { template_sid: string | null; created_at: string; id?: number | null };

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
/** Quanti turni del lancio al massimo in un solo drain: il lead che scrive a raffica va
 *  seguito, ma un turno costa modello + CRM + Twilio e il drain ha un lucchetto sopra. */
const MAX_GIRI_LANCIO = 3;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/**
 * Funnel Professioni (PO 28/10/2026): fra il PDF della scheda e il primo testo di Mario
 * passano almeno questi millisecondi. Twilio spedisce un media scaricandolo prima dal nostro
 * URL, un testo no: partiti a ridosso, il testo puo' arrivare al lead PRIMA del PDF che
 * annuncia. Di solito il modello ci mette gia' di piu'; questo e' il pavimento.
 */
export const DISTACCO_SCHEDA_MS = 4000;
/** Millisecondi di un `created_at`, 0 se manca o non si legge: serve solo a confrontare
 *  due righe della stessa cronologia, mai a decidere un orario. */
const quando = (v: string | null | undefined): number => {
  const ms = v ? Date.parse(v) : NaN;
  return Number.isFinite(ms) ? ms : 0;
};

/**
 * L'inbound piu' recente che il turno ha davanti: e' l'ultimo messaggio del lotto che il
 * turno consuma, e quindi la soglia per sapere se ne e' arrivato un altro mentre girava.
 *
 * Si guarda il TEMPO, non la posizione rispetto all'ultimo outbound: il turno del lancio
 * scrive la sua bolla alla FINE (dopo 5-20 secondi), quindi un messaggio arrivato durante
 * il turno finisce in cronologia PRIMA di quella bolla — per
 * `nextUnansweredInboundIndex`, che cerca il primo inbound dopo l'ultimo outbound, quel
 * messaggio semplicemente non esiste.
 */
export function ultimoInboundAt(righe: readonly DrainMsgRow[]): number {
  return righe.reduce((max, m) => (m.direction === 'in' ? Math.max(max, quando(m.created_at)) : max), 0);
}

/** Il primo inbound piu' nuovo della soglia, -1 se non c'e': e' arrivato DURANTE il turno,
 *  ovunque sia finito rispetto alla bolla. */
export function indiceInboundDopo(righe: readonly DrainMsgRow[], soglia: number): number {
  return righe.findIndex((m) => m.direction === 'in' && quando(m.created_at) > soglia);
}

/** La risposta alla domanda `step` del riscaldamento e' gia' arrivata al CRM? (indice su type) */
async function rispostaRiscaldamentoGiaNotata(supabase: Supa, conversationId: number, step: number): Promise<boolean> {
  try {
    const { data } = await supabase
      .from('event_log')
      .select('id')
      .eq('type', 'gdo_warmup_risposta_nota')
      .eq('payload->>conversationId', String(conversationId))
      .eq('payload->>step', String(step))
      .eq('payload->>inviata', 'true')
      .is('payload->>continua', null)
      .limit(1);
    return (data ?? []).length > 0;
  } catch {
    return false;
  }
}

/**
 * L'id dell'ultimo messaggio del lead che il turno ha visto, o null. Si confronta l'ID e
 * non l'orario: `created_at` nel DB ha i microsecondi e un Date JS solo i millisecondi,
 * quindi "created_at > ultimo orario visto" ritrovava sempre lo stesso messaggio e il
 * riscaldamento credeva che il lead scrivesse ancora (domande ferme dal deploy 30e21a4,
 * 29/10/2026).
 */
export function ultimoInboundId(righe: readonly { direction: string; id?: number | string | null }[]): number | null {
  let max: number | null = null;
  for (const m of righe) {
    if (m.direction !== 'in' || m.id === null || m.id === undefined) continue;
    const n = Number(m.id);
    if (Number.isFinite(n) && (max === null || n > max)) max = n;
  }
  return max;
}

/**
 * I messaggi del lead arrivati dopo l'ultimo che il turno ha visto, in ordine. Servono alla
 * nota del riscaldamento: un messaggio arrivato mentre il turno girava finisce in cronologia
 * SOTTO la nostra bolla e nessun turno lo rilegge piu' (conv 28998). Nel dubbio, nessuno.
 */
async function inboundArrivatiDopo(supabase: Supa, conversationId: number, ultimoId: number | null): Promise<string[]> {
  if (ultimoId === null) return [];
  try {
    const { data } = await supabase
      .from('messages')
      .select('id, body')
      .eq('conversation_id', conversationId)
      .eq('direction', 'in')
      .gt('id', ultimoId)
      .order('id', { ascending: true })
      .limit(10);
    return ((data ?? []) as { body: string | null }[]).map((m) => (m.body ?? '').trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/** E' arrivato un messaggio del lead dopo l'ultimo che il turno ha visto? (lead che scrive ancora) */
async function inboundArrivatoDopo(supabase: Supa, conversationId: number, ultimoId: number | null): Promise<boolean> {
  if (ultimoId === null) return false;
  try {
    const { data } = await supabase
      .from('messages')
      .select('id')
      .eq('conversation_id', conversationId)
      .eq('direction', 'in')
      .gt('id', ultimoId)
      .limit(1);
    return (data ?? []).length > 0;
  } catch {
    return false;
  }
}

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
  distaccoSchedaMs: number = DISTACCO_SCHEDA_MS,
): Promise<void> {
  // Lock: claim del turno. Se un'altra esecuzione sta già rispondendo, esci:
  // quel drain ricontrolla i messaggi e gestirà anche questo inbound.
  // Il lucchetto vive su ai_lock_at: ai_status resta lo stato di prodotto, così una
  // conversazione ammissibile non viene esclusa dal claim solo perché un'altra
  // esecuzione le aveva riscritto lo stato. Un lucchetto più vecchio di LOCK_TTL_MS
  // è di un processo morto e si può scavalcare.
  const nowIso = new Date().toISOString();
  const staleCutoff = new Date(Date.now() - LOCK_TTL_MS).toISOString();
  const { data: claimed, error: claimErr } = await supabase
    .from('conversations')
    .update({ ai_lock_at: nowIso })
    .eq('id', conversationId)
    .eq('ai_status', 'active')
    .is('ai_paused_at', null) // fermo manuale: la chat è di un umano, non si claima
    .or(`ai_lock_at.is.null,ai_lock_at.lt.${staleCutoff}`)
    // `bot_outcome` e `bot_scheduled_at` servono al ramo degli esiti senza leadId
    // (`registraEsitoSenzaLeadId`): senza di loro non saprebbe che su questa
    // conversazione c'e' gia' un appuntamento in piedi, e lo declasserebbe.
    // `wa_number` e' il numero con cui questa chat e' nata: ogni bolla del turno — le
    // risposte di Mario, il video del GDO, i turni del lancio — deve partire da li'.
    .select('id, ai_started_at, crm_lead_id, bot_outcome, bot_scheduled_at, gdo_agenda_at, gdo_appuntamento_set_at, gdo_video_url, gdo_video_sent_at, gdo_video_watched_at, gdo_video_followups_sent, gdo_noemi_reminded_at, gdo_appuntamento_at, ai_paused_at, cancel_requested_at, gdo_recap_for_at, gdo_recap_sent_at, gdo_warmup_step, lancio_slug, lancio_fase, lancio_ingresso, lancio_info, wa_number, professione, scheda_inviata_at, crm_funnel, leads(first_name)')
    .single();
  // PGRST116 = nessuna riga: e' il caso NORMALE (conversazione non claimabile, o
  // lucchetto di un altro drain) e non va segnalato. Qualunque altro errore invece qui
  // non si vedeva: `data` tornava null e il drain usciva zitto, identico al caso
  // normale. Con le colonne `lancio_*` entrate in questa select, una migrazione non
  // applicata (Postgres 42703) farebbe tacere il bot per TUTTI senza una riga di log.
  // Non si lancia: un drain che non parte e' un messaggio senza risposta, non un 500.
  if (claimErr && claimErr.code !== 'PGRST116') {
    console.error(`[fenice] claim fallito su conv ${conversationId}: ${claimErr.message}`);
    await supabase.from('event_log').insert({
      type: 'fenice_ai_claim_error',
      payload: { conversationId, message: claimErr.message, code: claimErr.code ?? null } as never,
      message: `[fenice] claim del turno fallito su conv ${conversationId}: ${claimErr.message}`,
      level: 'error',
    });
    return;
  }
  if (!claimed) return;
  const startedAt = (claimed as { ai_started_at: string | null }).ai_started_at;
  const crmLeadId = (claimed as { crm_lead_id: string | null }).crm_lead_id;
  const esitoInPiedi = (claimed as { bot_outcome?: BotOutcome | null }).bot_outcome ?? null;
  // `let`: lo spostamento di una call del bot (lib/gdo-spostamento.ts) la porta alla data nuova.
  let dataInPiedi = (claimed as { bot_scheduled_at?: string | null }).bot_scheduled_at ?? null;
  // Funnel Professioni: il corso scelto e se la scheda e' gia' partita. `let` perche' un
  // giro successivo dello stesso drain non deve riprovare l'invio (inviaScheda e' comunque
  // idempotente sulla colonna) e perche' il corso scelto da Mario col tag, su una chat
  // entrata senza corso riconosciuto, vale da li' in avanti.
  let professione = (claimed as { professione?: string | null }).professione ?? null;
  // Il funnel deciso all'adozione: una chat PROFESSIONI senza corso riconosciuto riceve la
  // nota lo stesso (spec §2), e Mario chiede quale corso.
  const funnelProfessioni = (claimed as { crm_funnel?: string | null }).crm_funnel === PROVENIENZA_PROFESSIONI;
  let schedaInviataAt = (claimed as { scheda_inviata_at?: string | null }).scheda_inviata_at ?? null;

  // Il mittente e' quello della chat (vedi lib/mittente.ts). Si risolve DOPO il claim
  // perche' sta sulla riga; se manca e' la configurazione (nemmeno il primario in env)
  // e si esce sciogliendo il lucchetto a mano, come nel ramo dello stop del CRM sotto.
  const from = mittenteDiConversazione(claimed as { wa_number?: string | null });
  if (!from) {
    await supabase.from('event_log').insert({
      type: 'fenice_ai_error', payload: { conversationId } as never,
      message: 'TWILIO_WHATSAPP_NUMBER_FENICE non configurato', level: 'error',
    });
    await supabase.from('conversations').update({ ai_lock_at: null }).eq('id', conversationId).eq('ai_lock_at', nowIso);
    return;
  }

  // Lo stop che viene dal CRM, non dalla chat: chi si e' presentato alla call o ha
  // comprato non deve ricevere piu' niente, e nemmeno chi una persona ha scartato per un
  // motivo che dalla chat non si vede. Il 29/08/2026 sei clienti da tre settimane hanno
  // rischiato un "rifissiamo la call?" e ci siamo fermati solo perche' il CRM ha
  // incrociato i dati a mano: questo e' il controllo che quel giro non lo fa fare piu'.
  // Il lucchetto va sciolto a mano, perche' si esce prima del `try`/`finally`.
  // Qui il lead ci ha appena scritto, quindi il modo e' 'risposta': uno scarto deciso da
  // un GDO non ci fa tacere davanti a una persona che si e' fatta viva. Restano fuori
  // solo i clienti e chi alla call c'e' gia' andato — e per loro il silenzio sarebbe il
  // peggio dei due mondi: sulle chat vive con uno stop, 39 persone in quello stato ci
  // hanno scritto negli ultimi 14 giorni. Non risponde il bot: risponde una persona.
  const stopCrm = await stopDalCrmPerLead(supabase, crmLeadId, 'risposta');
  if (stopCrm) {
    if (crmLeadId && vuolePassaggioAUmano(stopCrm)) {
      // Una volta sola per conversazione: il lucchetto e' l'evento stesso, come nel
      // recupero NR, altrimenti ogni messaggio del cliente rifarebbe la segnalazione.
      const { data: gia } = await supabase
        .from('event_log').select('id')
        .eq('type', 'bot_passa_a_persona_stato_crm')
        .eq('payload->>conversationId', String(conversationId))
        .limit(1).maybeSingle();
      if (!gia) {
        const { data: ultimo } = await supabase
          .from('messages').select('body')
          .eq('conversation_id', conversationId).eq('direction', 'in')
          .order('created_at', { ascending: false }).limit(1).maybeSingle();
        const parole = (ultimo as { body: string | null } | null)?.body ?? undefined;
        await sendOutcome(supabase, conversationId, {
          outcome: 'CONTATTO_UMANO',
          note: parole,
          motivoContattoUmano: stopCrm === 'gia_cliente' ? 'scrive_un_cliente' : 'scrive_chi_si_e_presentato',
          notaContattoUmano: buildScriveDopoLaCallNote({ leadWords: parole, cliente: stopCrm === 'gia_cliente' }),
        });
        await supabase.from('event_log').insert({
          type: 'bot_passa_a_persona_stato_crm',
          payload: { conversationId, crmLeadId, motivo: stopCrm } as never,
          message: `[bot-fissatore] conv ${conversationId}: scrive chi il CRM dice ${stopCrm}, passata a una persona`,
          level: 'info',
        });
      }
      await supabase.from('conversations')
        .update({ ai_status: 'handed_off', ai_lock_at: null, handed_off_at: new Date().toISOString() })
        .eq('id', conversationId).eq('ai_lock_at', nowIso);
      return;
    }
    await supabase.from('event_log').insert({
      type: 'bot_fermo_stato_crm',
      payload: { conversationId, crmLeadId, motivo: stopCrm } as never,
      message: `[bot-fissatore] conv ${conversationId}: il bot non risponde, il CRM dice ${stopCrm}`,
      level: 'info',
    });
    await supabase.from('conversations').update({ ai_lock_at: null }).eq('id', conversationId).eq('ai_lock_at', nowIso);
    return;
  }

  // Modalità postino: lead di un GDO, arruolato da `enrollGdoLeadAsPostino`.
  // Il bot fa da canale ma il lead non è nostro: niente esiti, niente stati terminali.
  const gdo = claimed as {
    gdo_agenda_at?: string | null;
    gdo_appuntamento_set_at?: string | null;
    gdo_video_url?: string | null;
    gdo_video_sent_at?: string | null;
    gdo_video_watched_at?: string | null;
    gdo_video_followups_sent?: number | null;
    gdo_noemi_reminded_at?: string | null;
    bot_scheduled_at?: string | null;
    gdo_appuntamento_at?: string | null;
    ai_paused_at?: string | null;
    cancel_requested_at?: string | null;
    gdo_recap_for_at?: string | null;
    gdo_recap_sent_at?: string | null;
    gdo_warmup_step?: number | null;
    leads?: { first_name?: string | null } | null;
  };
  // Chat del lancio Web Dev AI: il turno lo fa lib/lancio-turno, non Mario.
  const lancio = claimed as {
    lancio_slug?: string | null; lancio_fase?: string | null; lancio_ingresso?: string | null; lancio_info?: LancioInfo | null;
  };
  const gdoAgendaAt = gdo.gdo_agenda_at ?? null;
  // Da quando conta la call per dire quando chiama Noemi: agenda o ultimo spostamento.
  // `let`: lo spostamento fatto dal bot (lib/gdo-spostamento.ts) lo riporta ad adesso.
  let fissatoIlGdo = fissatoIlDi(gdo);
  const gdoVideoUrl = gdo.gdo_video_url ?? null;
  // La chat ha ricevuto un'agenda GDO. Se il turno e' davvero del postino lo decide il giro
  // (`postino` nel ciclo qui sotto): il funnel Professioni vince su un'agenda gia' passata.
  const agendaGdo = gdoAgendaAt !== null;
  let gdoVideoSentAt = gdo.gdo_video_sent_at ?? null;
  let gdoVideoWatchedAt = gdo.gdo_video_watched_at ?? null;
  // Non incrementato qui: il contatore dei solleciti lo muove solo il cron dedicato.
  const gdoFollowupsSent = gdo.gdo_video_followups_sent ?? 0;
  let gdoNoemiRemindedAt = gdo.gdo_noemi_reminded_at ?? null;
  // Ora vera della call: serve a dire quando chiama Noemi (mattina di domani ⇒ la mattina stessa,
  // mattina più in là ⇒ già il giorno prima; vedi quandoChiamaNoemi).
  const botScheduledAt = gdo.bot_scheduled_at ?? null;
  // `let`: dopo uno spostamento fatto dal bot vale la data nuova per il resto del drain.
  let gdoAppuntamentoAt = gdo.gdo_appuntamento_at ?? null;
  // Il recap GDO gia' uscito per questa call (vedi lib/gdo-recap.ts). `let`: dopo la
  // presa vale anche per i giri successivi dello stesso drain.
  let gdoRecapForAt = gdo.gdo_recap_for_at ?? null;
  // Quando e' uscito: serve solo a rilasciare la presa se l'invio del recap fallisce.
  let gdoRecapSentAt = gdo.gdo_recap_sent_at ?? null;
  // Passo del riscaldamento (lib/gdo-warmup.ts). `let`: avanza in memoria fra un giro e
  // l'altro dello stesso drain, come il recap.
  let gdoWarmupStep = gdo.gdo_warmup_step ?? null;
  let gdoVideoMissingLogged = false;

  // Carica i messaggi della conversazione dall'arruolamento in poi (in ordine).
  async function loadHistory(): Promise<DrainMsgRow[]> {
    let q = supabase
      .from('messages')
      .select('id, direction, body, template_sid, created_at')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true })
      .limit(200);
    if (startedAt) q = q.gte('created_at', startedAt);
    const { data } = await q;
    return (data ?? []) as DrainMsgRow[];
  }

  /**
   * La riga della chat come la legge il ramo del lancio, riletta ADESSO: le stesse
   * colonne che il claim aveva fotografato, piu' i due campi che dicono se la chat e'
   * ancora del bot. Serve solo dal secondo giro del lancio in poi — costa una select in
   * piu' per giro in piu', e senza di essa il turno successivo lavorerebbe su una fase
   * gia' vecchia. Torna `null` quando un altro giro non si deve fare.
   */
  async function rileggiRigaLancio(): Promise<{ lancio_fase: string | null; lancio_info: LancioInfo | null; crm_lead_id: string | null } | null> {
    const { data, error } = await supabase
      .from('conversations')
      .select('crm_lead_id, ai_status, ai_owner, ai_paused_at, lancio_slug, lancio_fase, lancio_info')
      .eq('id', conversationId)
      .maybeSingle();
    const riga = data as {
      crm_lead_id?: string | null; ai_status?: string | null; ai_owner?: string | null; ai_paused_at?: string | null;
      lancio_slug?: string | null; lancio_fase?: string | null; lancio_info?: LancioInfo | null;
    } | null;
    const motivo = error
      ? `rilettura_fallita:${error.message}`
      : !riga
        ? 'riga_sparita'
        : riga.ai_paused_at || riga.ai_owner !== 'mario'
          ? 'chat_di_un_umano'
          : riga.ai_status !== 'active' && riga.ai_status !== 'replying'
            ? `stato_${riga.ai_status ?? 'nullo'}`
            : !lancioInCorso(riga)
              ? `fase_${riga.lancio_fase ?? 'nulla'}`
              : null;
    if (motivo === null && riga) {
      return { lancio_fase: riga.lancio_fase ?? null, lancio_info: riga.lancio_info ?? null, crm_lead_id: riga.crm_lead_id ?? null };
    }
    await supabase.from('event_log').insert({
      type: 'lancio_giro_interrotto',
      payload: { conversationId, motivo } as never,
      message: `[lancio] conv ${conversationId}: niente altro giro nel drain (${motivo})`,
      level: 'info',
    });
    return null;
  }

  let finalStatus = 'active';
  // Giornate già al completo: il bot non le propone. Si legge una volta per drain,
  // non per turno. Senza BOOKING_DAILY_CAP la lista è vuota e non si tocca il DB.
  const giorniPieni = await datePiene(supabase, tettoGiornaliero(process.env.BOOKING_DAILY_CAP), new Date());

  // Lancio Web Developer AI, dopo il follow-up (spec §5.5): la chat e' di Mario standard e
  // il video di preparazione e' la live editata. Il link si legge una volta per drain, e
  // solo se serve; se manca, Mario usa i quattro video classici e resta la traccia.
  // Le impostazioni si leggono una volta per drain: servono al video della live e, per chi
  // arriva dal link "Sviluppatore AI", all'ora dell'evento.
  let lancioSettings: LancioSettings | undefined;
  const leggiSettingsLancio = async (): Promise<LancioSettings> =>
    (lancioSettings ??= await getLancioSettings(supabase));
  let lancioVideoLive: string | null | undefined;
  const leggiVideoLive = async (): Promise<string | null> => {
    if (lancioVideoLive !== undefined) return lancioVideoLive;
    lancioVideoLive = (await leggiSettingsLancio()).videoLiveLink;
    // Una volta per chat, non a ogni drain: la mattina del 6, col link non ancora
    // impostato, ogni messaggio di ogni lead del lancio ne scriveva uno — e un avviso che
    // si ripete non e' un avviso. Il fatto che manchi e' uno solo e si legge alla prima.
    if (!lancioVideoLive) {
      await alertUnaVolta(supabase, {
        type: 'lancio_video_live_link_missing',
        conversationId,
        payload: { crmLeadId },
        message: `[lancio] conv ${conversationId}: lancio_video_live_link non impostato, Mario usa i video classici`,
        level: 'warn',
      });
    }
    return lancioVideoLive;
  };
  try {
    for (let round = 0; round < MAX_ROUNDS_PER_DRAIN; round++) {
      const before = await loadHistory();
      if (nextUnansweredInboundIndex(before) === -1) break; // niente di nuovo da gestire

      // Finestra di accorpamento: aspetta, poi ricarica per includere ciò che è arrivato.
      await sleep(delayMs());
      // `let`: se il turno del lancio passa un messaggio al postino a un giro successivo
      // (Task 5), Mario deve rispondere sulla cronologia e sul messaggio di quel giro.
      let rows = await loadHistory();
      if (nextUnansweredInboundIndex(rows) === -1) break;

      // Il messaggio del lead a cui stiamo rispondendo in questo giro.
      const inboundIdx = nextUnansweredInboundIndex(rows);
      let inboundBody = inboundIdx >= 0 ? (rows[inboundIdx].body ?? '') : '';

      if (lancioInCorso(lancio)) {
        // Il turno del lancio dura 5-20 secondi (modello + CRM + Twilio) e scrive la sua
        // bolla alla fine: un messaggio del lead arrivato nel frattempo ("ok" e subito
        // dopo "alle 10") resta sotto la bolla in cronologia e nessuno gli risponde piu'
        // — la traccia `fenice_ai_reply` viene scritta a turno finito, quindi anche il
        // re-drive di `bot-followups` lo considera gestito. Qui si gira finche' arrivano
        // messaggi NUOVI, al massimo MAX_GIRI_LANCIO volte: il confronto e' sul tempo
        // dell'ultimo inbound che il turno ha visto, non sulla posizione rispetto
        // all'ultima bolla.
        //
        // Dal secondo giro in poi si rilegge anche la RIGA della chat: il turno di prima
        // ha mosso `lancio_fase` e `lancio_info` (e puo' aver adottato il lead, quindi
        // `crm_lead_id`). Con la fotografia del claim, un lead che scrive "si" e poi
        // "si si" si prendeva due volte "posto bloccato": al secondo giro la fase era
        // ancora 'attesa' e il ramo `gia_bloccato` non scattava mai.
        let righeTurno = rows;
        let inboundTurno = inboundBody;
        let faseTurno = lancio.lancio_fase ?? null;
        let infoTurno = lancio.lancio_info ?? null;
        let leadIdTurno = crmLeadId;
        // B5: ha risposto al follow-up. Il turno chiude il lancio e passa la mano a Mario
        // in QUESTO drain: 'handed_to_mario' non e' uno stato di ai_status e non deve mai
        // entrare in finalStatus (che il finally scrive grezzo in conversations).
        let passaggioAMario = false;
        // Task 5 (conv 9676): chat del lancio che e' anche un lead GDO, e il messaggio
        // riguarda la call col consulente. Risponde Mario nel ramo postino NELLO STESSO
        // round, ma la fase del lancio NON cambia: il messaggio dopo torna al lancio.
        let passaggioAlPostino = false;
        for (let giro = 0; giro < MAX_GIRI_LANCIO; giro++) {
          // La soglia si prende PRIMA del turno: dopo, la cronologia e' gia' cambiata.
          const ultimoVisto = ultimoInboundAt(righeTurno);
          const esitoTurno = await eseguiTurnoLancio(supabase, {
            conversationId, phone, from,
            crmLeadId: leadIdTurno,
            fase: faseTurno,
            nome: gdo.leads?.first_name ?? null,
            rows: righeTurno, inboundBody: inboundTurno,
            // Le risposte del riscaldamento (e il marcatore del congedo): senza, il turno
            // post-pitch ricomincerebbe da capo a ogni messaggio del lead.
            lancioInfo: infoTurno,
            contestoGdo: { gdoAgendaAt, gdoAppuntamentoAt },
          });
          if (esitoTurno === 'handed_to_mario') {
            passaggioAMario = true;
            break;
          }
          if (esitoTurno === 'handed_to_postino') {
            passaggioAlPostino = true;
            break;
          }
          finalStatus = esitoTurno;
          // Solo mentre il lancio resta 'active': un congedo o un passaggio umano hanno
          // chiuso la partita.
          if (finalStatus !== 'active') break;
          const dopoIlTurno = await loadHistory();
          const iNuovo = indiceInboundDopo(dopoIlTurno, ultimoVisto);
          // Niente di nuovo: un turno che ha taciuto (fuori orario, solo media) lascia
          // scoperto lo STESSO inbound, e rilavorarlo sarebbe un giro a vuoto.
          if (iNuovo < 0) break;
          const riga = await rileggiRigaLancio();
          // La chat non e' piu' nostra da servire (fase terminale, umano subentrato,
          // conversazione chiusa da un esito): si esce e basta. Il messaggio nuovo lo
          // vede chi di dovere — un altro giro scriverebbe al lead a nome di una fase
          // che a DB non c'e' piu'.
          if (!riga) break;
          faseTurno = riga.lancio_fase;
          infoTurno = riga.lancio_info;
          leadIdTurno = riga.crm_lead_id;
          righeTurno = dopoIlTurno;
          inboundTurno = dopoIlTurno[iNuovo].body ?? '';
        }
        if (passaggioAlPostino) {
          // Niente `lancio_fase = 'chiuso'` e nessuna rilettura di `lancio_info`: la chat
          // resta del lancio. `lancioStandardDrain` qui sotto resta falso (la fase e'
          // attesa/posto_bloccato), quindi niente nota della live: Mario parte col solo
          // contesto GDO, perche' `postino` e' vero (`gdo_agenda_at` valorizzato). Se il
          // passaggio arriva a un giro successivo, Mario lavora su quel messaggio.
          finalStatus = 'active';
          rows = righeTurno;
          inboundBody = inboundTurno;
        } else if (passaggioAMario) {
          // Ha risposto al follow-up: il turno ha chiuso il lancio, da qui in poi e' Mario
          // standard NELLO STESSO round. La copia in memoria segue il DB, e finalStatus
          // resta 'active' come per qualunque chat che Mario sta servendo.
          lancio.lancio_fase = 'chiuso';
          finalStatus = 'active';
          // Il turno puo' aver scritto su `lancio_info` il marcatore del passaggio dopo la
          // notte del webinar (`mario_dopo_notte`, decisione PO 25/09): e' quello che sceglie
          // la nota di contesto qui sotto. Una lettura sola, e solo su questo passaggio.
          const { data: dopoIlPassaggio } = await supabase
            .from('conversations').select('lancio_info').eq('id', conversationId).maybeSingle();
          const infoDopo = (dopoIlPassaggio as { lancio_info?: LancioInfo | null } | null)?.lancio_info;
          if (infoDopo !== undefined) lancio.lancio_info = infoDopo;
        } else {
          break;
        }
      }

      // Link ufficiali "in piu'" per questa conversazione: il video della live (lancio).
      // `linkExtra` = link che non sono "inventati" E che valgono come "video gia'
      // uscito"; `videoExtra` = i soli link del lancio. Il video del GDO entra in
      // `linkExtra` perche' dall'offerta del mese quel link arriva da un'impostazione e
      // non sta nella whitelist statica: senza dirlo ai sanitizzatori ogni offerta
      // finirebbe a log come link inventato, e il blocco di conferma direbbe "link video
      // assente" (niente passaggio FATTO) proprio nel turno in cui il video esce.
      // Sui quattro video classici non cambia nulla: sono gia' nella whitelist.
      // Funnel Professioni (PO 15/10/2026, conv 3292): chi scrive la frase delle Professioni
      // su una chat col lancio finito e senza una call GDO ancora da fare e' del funnel. Il
      // turno e' quello del funnel: niente contesto GDO (nota, video, Noemi, esiti solo nota)
      // e niente note del lancio chiuso. Si decide qui, a ogni giro, perche' il turno del
      // lancio qui sopra puo' aver appena chiuso la fase.
      const vinceProfessioni = professioniVince({
        professione,
        crmFunnel: funnelProfessioni ? PROVENIENZA_PROFESSIONI : null,
        lancioSlug: lancio.lancio_slug, lancioFase: lancio.lancio_fase,
        gdoAgendaAt, botScheduledAt, gdoAppuntamentoAt,
        now: Date.now(),
      });
      const postino = agendaGdo && !vinceProfessioni;
      const lancioStandard = !vinceProfessioni && lancioStandardDrain(lancio);
      // Chi e' entrato dal link "professione dello Sviluppatore AI" (PO 24/09/2026): prima
      // della live non c'e' nessuna registrazione da mandare, e nessun avviso da scrivere
      // perche' manca — i video restano i classici e Mario non nomina la live.
      // Passata a Mario dopo la notte del webinar (PO 25/09): pulsante premuto dal 6 in poi,
      // o dopo-pitch rimasto a meta' oltre le 03:00. Ha visto la live: la nota lo dice.
      const dopoNotte = lancioStandard ? marioDopoNotte(lancio.lancio_info) : null;
      const daLinkSviluppatore = lancioStandard && !dopoNotte && lancio.lancio_ingresso === LANCIO_INGRESSO_LINK_SVILUPPATORE;
      // Su TUTTE le chat del lancio, non solo su quelle del link: il link della live si
      // imposta in anticipo (PO 02/10, la pagina e' attiva solo dopo il 6) e una chat
      // passata a Mario standard prima della live non deve ricevere una pagina ancora spenta.
      const eventoPassato = lancioStandard
        ? eventoLancioPassato((await leggiSettingsLancio()).eventoAt, Date.now())
        : true;
      const videoLive = lancioStandard && eventoPassato ? await leggiVideoLive() : null;
      const videoExtra: string[] = videoLive ? [videoLive] : [];
      const linkExtra: string[] = [...videoExtra, ...(gdoVideoUrl ? [gdoVideoUrl] : [])];
      // Un link del video già uscito in questa chat: serve sia alla patch del blocco
      // conferma, sia alla rete di sicurezza sul FATTO qui sotto.
      const videoGiaInviato = rows.some((m) => m.direction === 'out' && containsVideoLink(m.body, linkExtra));

      const videoDaMandare = postino && shouldSendGdoVideo({ gdoAgendaAt, gdoVideoUrl, gdoVideoSentAt });
      // Recap GDO (data della call, Noemi, video, FATTO in una bolla): esce al posto della
      // bolla del video, quindi solo nel turno in cui il video parte. Spento senza
      // GDO_RECAP_ENABLED; senza data della call resta la bolla del video di sempre.
      // L'ultimo inbound della cronologia e' il messaggio del lead di questo turno.
      const recapTipo = videoDaMandare
        ? decideGdoRecap({
            enabled: process.env.GDO_RECAP_ENABLED === '1',
            occasione: 'turno-video',
            gdoAgendaAt,
            botOutcome: esitoInPiedi,
            appuntamentoAt: gdoAppuntamentoAt,
            recapForAt: gdoRecapForAt,
            videoSentAt: gdoVideoSentAt,
            lastInboundAtMs: ultimoInboundAt(rows) || null,
            aiPausedAt: gdo.ai_paused_at ?? null,
            cancelRequestedAt: gdo.cancel_requested_at ?? null,
            nowMs: Date.now(),
          })
        : null;

      /**
       * La bolla del video: il recap se tocca a lui e la presa riesce (per questa call
       * potrebbe essere gia' uscito), altrimenti il video di sempre. Con il recap torna
       * anche la presa: Noemi, `gdo_recap_sent` e la memoria del drain si segnano solo
       * dopo che la bolla e' partita (`recapPartito`); se l'invio lancia, la presa si
       * rilascia (`recapNonPartito`) e il prossimo turno riprova.
       */
      type PresaRecapDrain = { at: string; prima: { forAt: string | null; sentAt: string | null } };
      const bollaVideoGdo = async (): Promise<{ body: string; presa: PresaRecapDrain | null }> => {
        if (recapTipo === 'completo' && gdoAppuntamentoAt) {
          const prima = { forAt: gdoRecapForAt, sentAt: gdoRecapSentAt };
          if (await claimRecap(supabase, conversationId, gdoAppuntamentoAt, false)) {
            return {
              body: gdoRecapText({ nome: gdo.leads?.first_name ?? null, call: new Date(gdoAppuntamentoAt), videoLink: gdoVideoUrl, fissatoIl: fissatoIlGdo }),
              presa: { at: gdoAppuntamentoAt, prima },
            };
          }
        }
        return { body: gdoVideoText(gdo.leads?.first_name ?? null, gdoVideoUrl as string), presa: null };
      };

      /** Il recap e' partito: il promemoria di Noemi e' detto, a DB e in memoria. */
      const recapPartito = async (presa: PresaRecapDrain): Promise<void> => {
        const ora = new Date().toISOString();
        gdoRecapForAt = presa.at;
        gdoRecapSentAt = ora;
        if (!gdoNoemiRemindedAt) {
          gdoNoemiRemindedAt = ora;
          await supabase.from('conversations')
            .update({ gdo_noemi_reminded_at: ora })
            .eq('id', conversationId)
            .is('gdo_noemi_reminded_at', null);
        }
        await supabase.from('event_log').insert({
          type: 'gdo_recap_sent',
          payload: { conversationId, tipo: recapTipo, occasione: 'turno-video' } as never,
          message: `[gdo] conv ${conversationId}: recap con data, Noemi e video al posto della bolla del video`,
          level: 'info',
        });
      };

      /** Il recap non e' partito: la presa torna com'era. L'errore dell'invio prosegue. */
      const recapNonPartito = async (presa: PresaRecapDrain): Promise<void> => {
        const erroreRilascio = await rilasciaRecap(supabase, conversationId, presa.at, presa.prima, false);
        if (erroreRilascio) {
          await supabase.from('event_log').insert({
            type: 'gdo_recap_errore',
            payload: { conversationId, occasione: 'turno-video', error: erroreRilascio } as never,
            message: `[gdo] conv ${conversationId}: recap non partito e ${erroreRilascio}`,
            level: 'error',
          });
        }
      };

      /** Manda il video del GDO (o il recap) come bolla a sé e ne registra l'invio. */
      const inviaVideoGdo = async (): Promise<void> => {
        const { body, presa } = await bollaVideoGdo();
        let sent: Awaited<ReturnType<typeof sendFreeText>>;
        try {
          sent = await sendFreeText({ to: phone, body, from });
        } catch (err) {
          if (presa) await recapNonPartito(presa);
          throw err;
        }
        if (presa) await recapPartito(presa);
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
      // Su `agendaGdo`, non su `postino`: chi ha ricevuto l'agenda firmata Marta continua a
      // parlare con Marta anche quando il turno e' del funnel Professioni.
      const persona = agendaGdo
        ? 'marta'
        : martaSids.size > 0
          ? personaForConversation(rows, martaSids)
          : 'mario';
      // Sui lead adottati (non postino) la nota e' la dichiarazione IA: se sulla
      // conversazione non e' mai uscito niente da parte nostra, il lead non sa mai
      // con chi sta parlando senza questa nota.
      const notaPrimo = notaPrimoContatto(rows);
      // Nota del lancio: per chi arriva dal link c'e' sempre (la domanda sulla live), e si
      // SOMMA alla dichiarazione IA del primo contatto invece di prenderne il posto — quella
      // persona non ha mai ricevuto niente da noi, ed e' proprio il caso in cui serve.
      const notaLancio = dopoNotte
        ? [
            dopoNotte.da === 'iscritto_dopo_live'
              ? iscrittoDopoLiveContextNote(videoLive)
              : pulsanteDopoNotteContextNote({ da: dopoNotte.da, videoLiveLink: videoLive, risposte: risposteRiscaldamento(lancio.lancio_info) }),
            notaPrimo,
          ].filter(Boolean).join('\n\n')
        : daLinkSviluppatore
        ? [linkSviluppatoreContextNote({ videoLiveLink: videoLive, eventoPassato }), notaPrimo].filter(Boolean).join('\n\n')
        : lancioStandard
          ? lancioStandardContextNote(videoLive)
          : null;
      // Sul lancio senza appuntamento Mario non passa la chat a una persona: la riga va in
      // coda alla nota, anche quando la nota del follow-up e' null (video della live non
      // ancora impostato).
      const notaLancioCompleta = lancioStandard && esitoInPiedi !== 'APPUNTAMENTO'
        ? [notaLancio ?? notaPrimo, NOTA_LANCIO_NIENTE_PASSAGGIO].filter(Boolean).join('\n\n')
        : notaLancio;
      // Studente della lista 135 (lib/studenti-offerta.ts): sa che e' gia' nostro e gli
      // propone la call per l'offerta studenti. Solo fuori dal lancio e dal postino.
      const notaStudente = !postino && !lancio.lancio_slug && eStudenteOfferta(lancio.lancio_info)
        ? [STUDENTI_CONTEXT_NOTE, notaPrimo].filter(Boolean).join('\n\n')
        : null;
      // Funnel Professioni (PO 14/10/2026): la chat col corso segnato, o nel funnel
      // PROFESSIONI anche senza corso, riceve la sua nota (si somma alla dichiarazione IA del
      // primo contatto). Fuori dal lancio in corso e dalla call GDO ancora da fare
      // (`professioniVince`): su lancio chiuso o agenda passata la nota del funnel vince.
      // Nelle adv promettiamo la brochure subito (PO 28/10/2026): alla frase del link, o
      // quando la chiede, la scheda parte PRIMA della risposta di Mario, una volta sola
      // (CAS su `scheda_inviata_at` in `inviaScheda`). La nota poi gli dice che e' gia' sopra.
      const idxTurno = nextUnansweredInboundIndex(rows);
      const slugSubito = schedaSubito({
        vinceProfessioni, professione, schedaInviataAt,
        testiTurno: idxTurno >= 0 ? rows.slice(idxTurno).filter((m) => m.direction === 'in').map((m) => m.body ?? '') : [],
      });
      let schedaAppenaInviata = false;
      let schedaPartitaAlMs: number | null = null;
      if (slugSubito) {
        const esitoSubito = await inviaScheda(supabase, { conversationId, phone, from, slug: slugSubito, momento: 'subito' });
        if (esitoSubito !== 'fallita') schedaInviataAt = new Date().toISOString();
        if (esitoSubito === 'inviata') {
          schedaAppenaInviata = true;
          schedaPartitaAlMs = Date.now();
          // La cronologia del modello e' stata letta prima: il PDF ci entra a mano, cosi'
          // Mario vede che e' partito e non lo ripete.
          history.push({ role: 'assistant', content: testoScheda(slugSubito) });
        }
      }
      const notaProfessioni = vinceProfessioni
        ? [professioniContextNote(isSlugProfessione(professione) ? professione : null, { schedaInviata: !!schedaInviataAt, appenaInviata: schedaAppenaInviata }), notaPrimo].filter(Boolean).join('\n\n')
        : null;
      // Brochure su richiesta fuori dal funnel Professioni (PO 28/10/2026): solo se il lead
      // la chiede (in questo turno o, pendente, poco prima), mai nel postino ne' nel lancio.
      // La nota si somma a quella del turno; la scheda parte solo col tag di Mario, qui sotto.
      const richiestaScheda = richiestaSchedaFuoriFunnel({
        vinceProfessioni, postino, lancioSlug: lancio.lancio_slug, schedaInviataAt,
        testiTurno: rows.slice(idxTurno).filter((m) => m.direction === 'in').map((m) => m.body ?? ''),
        testiPrima: rows.slice(0, idxTurno).filter((m) => m.direction === 'in').map((m) => m.body ?? ''),
      });
      const notaBrochure = richiestaScheda ? brochureContextNote(richiestaScheda) : null;
      // Postino: i promemoria del turno e, dopo il recap, la domanda di riscaldamento.
      // La nota tace nel turno del recap e in quello di Noemi: una cosa alla volta.
      const noteGdo: GdoNoteInput | null = postino
        ? {
            gdoVideoSentAt: gdoVideoSentAt,
            gdoVideoWatchedAt: gdoVideoWatchedAt,
            gdoNoemiRemindedAt: gdoNoemiRemindedAt,
            followupsSent: gdoFollowupsSent,
            videoAppenaConfermato: false,
            videoInUscita: videoInsiemeAllaRisposta,
            recapInUscita: recapTipo === 'completo',
            botScheduledAt: botScheduledAt,
            gdoAppuntamentoAt: gdoAppuntamentoAt,
            fissatoIl: fissatoIlGdo,
          }
        : null;
      // Riscaldamento (lib/gdo-warmup.ts): le domande le scrive il codice, in coda alla
      // bolla del modello. Qui solo il motivo per cui la domanda del turno puo' partire o
      // tace (evento `gdo_warmup_nota`); il modello non ne sa niente.
      const warmupAcceso = process.env.GDO_WARMUP_ENABLED === '1';
      const motivoWarmup = agendaGdo && warmupAcceso
        ? motivoRiscaldamento({
            enabled: true,
            postino,
            cancelRequested: !!gdo.cancel_requested_at,
            step: gdoWarmupStep,
            recapForAt: gdoRecapForAt,
            videoSentAt: gdoVideoSentAt,
            recapInQuestoTurno: recapTipo === 'completo',
            appuntamentoAt: gdoAppuntamentoAt,
            serveNoemi: noteGdo ? serveNoemi(noteGdo) : false,
            nowMs: Date.now(),
          })
        : null;
      const stepWarmupTurno = gdoWarmupStep;
      // La domanda del riscaldamento ancora in attesa di risposta (anche se il modello l'ha
      // riformulata nel turno di mezzo). Si calcola PRIMA del modello: se c'e', il modello
      // sa che non deve rifarla. Se la risposta e' gia' arrivata al CRM non si rinota.
      const warmupAttivo = postino && !riscaldamentoInerte(motivoWarmup);
      const giaNotata = warmupAttivo && idxTurno >= 0 && (gdoWarmupStep === 1 || gdoWarmupStep === 2)
        ? await rispostaRiscaldamentoGiaNotata(supabase, conversationId, gdoWarmupStep)
        : false;
      const attesa = warmupAttivo && idxTurno >= 0 ? domandaInAttesa(rows, idxTurno, gdoWarmupStep, giaNotata) : null;
      const notaWarmup = attesa ? notaDomandaGiaFatta(attesa.step) : null;
      // Spostamento della call fatto dal bot (PO 28/10/2026, lib/gdo-spostamento.ts): sul
      // postino (lead GDO) e, dal 29/10, sulle call fissate dal bot; una volta sola, se le
      // Conferme non hanno ancora esitato il lead. Le due letture (evento "gia' spostato",
      // stato CRM locale) si pagano solo quando il resto e' gia' in regola. Il blocco nel
      // prompt c'e' solo se lo spostamento si puo' fare.
      const rangesSpostamento = bookingBlackout(process.env.BOOKING_BLACKOUT);
      const origineSposta = crmLeadId ? origineSpostamento({ postino, botOutcome: esitoInPiedi }) : null;
      const callDelBot = origineSposta === 'bot' ? dataCallDelBot(dataInPiedi, gdoAppuntamentoAt) : null;
      // La call che si sposta: quella del GDO o quella fissata dal bot.
      const callSpostabileAt = callDelBot ? callDelBot.at : gdoAppuntamentoAt;
      const baseSpostamento = {
        enabled: spostamentoAbilitato(process.env.GDO_SPOSTAMENTO_BOT_ENABLED),
        origine: origineSposta,
        appuntamentoAt: callSpostabileAt,
        dataCambiata: callDelBot?.cambiata ?? false,
        nowMs: Date.now(),
      };
      let motivoNoSposta: MotivoNonSpostabile | null = motivoNonSpostabile({ ...baseSpostamento, giaSpostato: false });
      if (motivoNoSposta === null && crmLeadId) {
        const [gia, crm] = await Promise.all([
          giaSpostatoDalBot(supabase, conversationId),
          statoCrmLocale(supabase, crmLeadId),
        ]);
        motivoNoSposta = motivoNonSpostabile({
          ...baseSpostamento,
          giaSpostato: gia,
          confermeOutcome: crm?.confermeOutcome ?? null,
          presented: crm?.presented ?? null,
          salesOutcome: crm?.salesOutcome ?? null,
        });
      }
      const giorniSposta = giorniSpostamento(new Date(), rangesSpostamento);
      const notaSposta = motivoNoSposta === null && giorniSposta.length > 0 && callSpostabileAt
        ? notaSpostamentoPrompt({ giorni: giorniSposta, callAt: new Date(callSpostabileAt) })
        : null;
      // Sulle call del bot il blocco va in coda alla nota del turno, qualunque sia; sul
      // postino sta gia' in coda alla nota GDO (qui sotto).
      const notaSpostaBot = origineSposta === 'bot' ? notaSposta : null;
      const result = await generateMarioReply(history, {
        personaName: PERSONA_NAME[persona],
        giorniPieni,
        // I promemoria pendenti (video non confermato, Noemi non ancora spiegata)
        // viaggiano dentro il contesto: il modello li integra nel discorso invece di
        // farli arrivare come un messaggio programmato addosso. Sui lead adottati la
        // nota e' un'altra, la dichiarazione IA: un postino ha sempre ricevuto l'agenda,
        // quindi i due casi non si incontrano mai.
        ...(noteGdo
          ? { contextNote: [gdoContextNote(noteGdo), notaSposta, notaWarmup].filter(Boolean).join('\n\n') }
          : notaLancioCompleta
            ? { contextNote: [notaLancioCompleta, notaSpostaBot].filter(Boolean).join('\n\n') }
            : notaStudente
            ? { contextNote: [notaStudente, notaBrochure, notaSpostaBot].filter(Boolean).join('\n\n') }
            : notaProfessioni
            ? { contextNote: [notaProfessioni, notaSpostaBot].filter(Boolean).join('\n\n') }
            : notaPrimo || notaBrochure || notaSpostaBot
              ? { contextNote: [notaPrimo, notaBrochure, notaSpostaBot].filter(Boolean).join('\n\n') }
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
      // La rigenerazione di Noemi ha sostituito il testo: in quel turno niente domanda.
      let rigenerataNoemi = false;
      // Il lancio non passa MAI un lead ai GDO (PO 25/09/2026): senza appuntamento il
      // [PASSAGGIO_UMANO] si ignora e la riga del modello, che prometterebbe un contatto,
      // cede il posto alla proposta della call col consulente.
      const passaggioBloccato = bloccaPassaggioLancio({
        lancioStandard, passToHuman: result.passToHuman, esitoInPiedi,
        appointmentFixed: result.appointmentFixed || result.outcome === 'APPUNTAMENTO',
      });
      const passaAPersona = result.passToHuman && !passaggioBloccato;
      // I giorni che la guardia sulla data deve accettare: quelli che il modello ha visto
      // in questo turno PIÙ quelli che il form offriva quando è partito il link. La data
      // si concorda prima del link, il lead può compilarlo il giorno dopo (caso Comaschi).
      // Senza i giorni del turno (chiamanti che non li conoscono) si resta a `undefined`:
      // la guardia ricalcola la finestra di adesso, invece di vedere solo quella del link.
      const giorniTurno = result.bookingDays && result.bookingDays.length > 0
        ? unisciGiorni(result.bookingDays, giorniDelLinkForm(rows, bookingBlackout(process.env.BOOKING_BLACKOUT)))
        : undefined;
      // Il tag APPUNTAMENTO di questo turno verrà scartato? Si guarda PRIMA di mandare il
      // testo: altrimenti il lead legge «ci siamo» per una call che in agenda non entra.
      // Solo sui lead CRM nostri (il postino non fissa, e sugli adottati nessuno
      // riceverebbe la segnalazione che il testo sostitutivo promette).
      const motivoScarto = crmLeadId && !postino
        ? motivoScartoAppuntamento({
            current: esitoInPiedi,
            outcome: result.outcome,
            date: result.scheduledAt,
            existingDate: dataInPiedi,
            nowMs: Date.now(),
            ranges: bookingBlackout(process.env.BOOKING_BLACKOUT),
            bookingDays: giorniTurno,
          })
        : null;
      const appuntamentoScartato = motivoScarto !== null;
      if (appuntamentoScartato) visibleReply = TESTO_DATA_DA_VERIFICARE;
      // Da qui in giù "fissato in questo turno" vale solo se la data passa la guardia: niente
      // blocco Noemi + video e niente scheda per una call che non esiste.
      const fissatoNelTurno = result.appointmentFixed && !appuntamentoScartato;
      if (passaggioBloccato) {
        await supabase.from('event_log').insert({
          type: 'lancio_passaggio_umano_ignorato',
          payload: { conversationId, crmLeadId, mario: true, risposta: (result.visibleReply ?? '').slice(0, 300) } as never,
          message: `[lancio] conv ${conversationId}: Mario voleva passare la chat a una persona, proposta la call`,
          level: 'info',
        });
        visibleReply = TESTO_LANCIO_NIENTE_PASSAGGIO;
      }
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
      if (postino && videoConfermato && !gdoNoemiRemindedAt && !result.outcome && !passaAPersona) {
        try {
          const retry = await generateMarioReply(history, {
            personaName: PERSONA_NAME[persona],
            giorniPieni,
            contextNote: [gdoContextNote({
              gdoVideoSentAt: gdoVideoSentAt,
              gdoVideoWatchedAt: watchedAt, // appena confermato: sopprime NOTA_VIDEO nella nota
              gdoNoemiRemindedAt: gdoNoemiRemindedAt,
              followupsSent: gdoFollowupsSent,
              videoAppenaConfermato: true, // forza NOTA_NOEMI anche a followupsSent 0
              videoInUscita: videoInsiemeAllaRisposta,
              recapInUscita: recapTipo === 'completo',
              botScheduledAt: botScheduledAt,
              gdoAppuntamentoAt: gdoAppuntamentoAt,
              fissatoIl: fissatoIlGdo,
            }), notaSposta, notaWarmup].filter(Boolean).join('\n\n'),
          });
          // Fail-safe: una rigenerazione vuota non vale meno di zero, vale come un
          // fallimento — si manda comunque la prima risposta, il lead non resta muto.
          if (retry.visibleReply?.trim()) {
            visibleReply = retry.visibleReply;
            rigenerataNoemi = true;
          }
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

      // Spostamento della call (lib/gdo-spostamento.ts): il modello ha scritto [SPOSTA|...].
      // Si decide PRIMA di mandare il testo: il lead legge "fatto" solo se il CRM ha
      // davvero spostato. Il codice verifica la data, il CRM decide; ogni "no" ripiega
      // sulla nota SPOSTAMENTO CHIESTO di sempre (esito RICHIAMO sul canale solo-nota).
      let spostamentoFatto = false;
      let bollaSpostamento: string | null = null;
      if (origineSposta && crmLeadId && result.spostaAt !== undefined) {
        const adesso = new Date();
        const videoVisto = !!gdoVideoWatchedAt || videoConfermato;
        // Il video della chat: quello del GDO o, sulle call del bot, l'ultimo link uscito.
        const videoLinkSposta = origineSposta === 'bot' ? ultimoLinkVideo(rows) : gdoVideoUrl;
        // Lo stesso spostamento rivisto (il turno di prima e' andato a meta'): si riconferma.
        if (motivoNoSposta === 'gia_spostato' && callSpostabileAt && sameInstant(result.spostaAt, callSpostabileAt)) {
          bollaSpostamento = testoSpostamentoFatto({
            nome: gdo.leads?.first_name ?? null, call: new Date(callSpostabileAt),
            fissatoIl: origineSposta === 'gdo' ? fissatoIlGdo ?? adesso : adesso,
            videoVisto, videoLink: videoLinkSposta,
          });
          spostamentoFatto = true;
        } else if (spostamentoGiaRifiutato(result.spostaAt, await spostamentiRifiutati(supabase, conversationId))) {
          // Stessa data gia' tentata e rifiutata (lead c91081be: su «Ok grazie» il modello
          // rimette [SPOSTA]): niente secondo POST al CRM, niente secondo testo, niente
          // seconda nota. Parte solo quello che il modello ha scritto oltre al tag.
          await supabase.from('event_log').insert({
            type: 'gdo_spostamento_ripetuto_ignorato',
            payload: { conversationId, crmLeadId, origine: origineSposta, data: result.spostaAt } as never,
            message: `[${origineSposta}] conv ${conversationId}: spostamento a ${result.spostaAt} gia' rifiutato, non ritentato`,
            level: 'info',
          });
        } else {
          const motivo: string | null = motivoNoSposta
            ?? motivoDataNonValida(result.spostaAt, callSpostabileAt, adesso.getTime(), rangesSpostamento);
          const secret = process.env.BOT_WEBHOOK_SECRET;
          const risposta = motivo === null
            ? secret
              ? await inviaSpostamentoAlCrm(crmLeadId, result.spostaAt, secret)
              : { ok: false as const, motivo: 'not_configured' }
            : null;
          if (risposta?.ok) {
            const da = callSpostabileAt;
            const a = new Date(result.spostaAt).toISOString();
            await registraSpostamentoInChat(supabase, {
              conversationId, crmLeadId, da, a, now: adesso, origine: origineSposta, allineaGdo: !!gdoAppuntamentoAt,
            });
            if (origineSposta === 'bot') {
              // Call del bot: l'esito resta APPUNTAMENTO, cambia solo la data nostra.
              dataInPiedi = a;
              if (gdoAppuntamentoAt) gdoAppuntamentoAt = a;
            } else {
              gdoAppuntamentoAt = a;
              fissatoIlGdo = adesso;
              gdoRecapForAt = a;
              gdoRecapSentAt = adesso.toISOString();
              gdoNoemiRemindedAt ??= adesso.toISOString();
            }
            bollaSpostamento = testoSpostamentoFatto({
              nome: gdo.leads?.first_name ?? null, call: new Date(a), fissatoIl: adesso, videoVisto, videoLink: videoLinkSposta,
            });
            spostamentoFatto = true;
          } else {
            const perche = motivo ?? (risposta && !risposta.ok ? risposta.motivo : 'sconosciuto');
            await supabase.from('event_log').insert({
              type: 'gdo_spostamento_non_fatto',
              payload: { conversationId, crmLeadId, origine: origineSposta, data: result.spostaAt, motivo: perche, status: risposta && !risposta.ok ? risposta.status ?? null : null } as never,
              message: `[${origineSposta}] conv ${conversationId}: spostamento a ${result.spostaAt} non fatto (${perche}), parte la nota alle Conferme`,
              level: risposta && !risposta.ok && risposta.status === undefined ? 'error' : 'info',
            });
            // Le Conferme hanno gia' deciso (scartato/confermato): niente «ti chiama Noemi».
            visibleReply = testoSpostamentoNonFatto(perche);
            // La data chiesta arriva alle Conferme come oggi: RICHIAMO sul canale solo-nota
            // diventa "SPOSTAMENTO CHIESTO — ... a <data>". Un esito gia' scritto dal modello vince.
            if (!result.outcome) {
              result.outcome = 'RICHIAMO';
              if (isoWithOffset(result.spostaAt.trim())) result.scheduledAt = result.spostaAt.trim();
              else result.note = result.spostaAt.trim() || undefined;
            }
          }
        }
        if (spostamentoFatto) {
          // La conferma la scrive il codice: un esito del modello nello stesso turno non parte.
          visibleReply = '';
          result.outcome = undefined;
          result.scheduledAt = undefined;
        }
      }

      // Un RICHIAMO senza data nuova su una frase che non chiede di spostare (o sulla call
      // appena spostata dal bot) non diventa la nota «SPOSTAMENTO CHIESTO» (lead 4da4e19f).
      if (origineSposta && crmLeadId && result.outcome === 'RICHIAMO' && result.spostaAt === undefined) {
        const testoTurnoRichiamo = idxTurno >= 0
          ? rows.slice(idxTurno).filter((m) => m.direction === 'in').map((m) => (m.body ?? '').trim()).filter(Boolean).join(' / ')
          : '';
        const spostataA = await ultimoSpostamentoDalBot(supabase, conversationId);
        if (richiamoNonESpostamento({
          outcome: result.outcome,
          date: result.scheduledAt,
          spostaNelTurno: false,
          callAt: callSpostabileAt,
          spostataDalBotA: spostataA,
          testoLead: testoTurnoRichiamo,
          soloPresaDAtto: isSoloPresaDAtto(testoTurnoRichiamo),
          // Gli ultimi messaggi del lead prima di questo turno (al massimo 6 righe indietro).
          testoPrima: rows.slice(Math.max(0, (idxTurno >= 0 ? idxTurno : rows.length) - 6), idxTurno >= 0 ? idxTurno : rows.length)
            .filter((m) => m.direction === 'in').map((m) => m.body ?? '').join(' / '),
        })) {
          await supabase.from('event_log').insert({
            type: 'richiamo_non_spostamento_ignorato',
            payload: { conversationId, crmLeadId, origine: origineSposta, parole: testoTurnoRichiamo.slice(0, 200), callSpostataDalBot: !!spostataA } as never,
            message: `[${origineSposta}] conv ${conversationId}: RICHIAMO del modello senza richiesta di spostamento, nessuna nota`,
            level: 'info',
          });
          result.outcome = undefined;
          result.scheduledAt = undefined;
          result.note = undefined;
        }
      }

      // Riscaldamento: la domanda in attesa non si rifa' MAI, nemmeno se il lead ha
      // risposto con un pollice (conv 29566). Le frasi del modello che la rifanno vanno via.
      if (attesa && !bollaSpostamento && visibleReply) {
        const pulita = togliDomandaRifatta(visibleReply, attesa.step);
        if (pulita.tolta) {
          await supabase.from('event_log').insert({
            type: 'gdo_warmup_domanda_rifatta_tolta',
            payload: { conversationId, step: attesa.step, prima: visibleReply.slice(0, 300), dopo: pulita.testo.slice(0, 300) } as never,
            message: `[gdo] conv ${conversationId}: il modello rifaceva la domanda ${attesa.step} del riscaldamento, frase tolta`,
            level: 'info',
          });
          visibleReply = pulita.testo;
        }
      }

      // Invia ogni a-capo come messaggio separato (più umano), con breve pausa.
      // La conferma dello spostamento resta UNA bolla (va a capo dentro, come il recap).
      let parts = bollaSpostamento ? [bollaSpostamento] : splitMarioMessages(visibleReply);

      // Riscaldamento: il turno dopo una domanda (la nostra ultima bolla la conteneva) e la
      // domanda di questo turno. Il testo del lead e' quello di tutti gli inbound del turno.
      const testoLeadTurno = idxTurno >= 0
        ? rows.slice(idxTurno).filter((m) => m.direction === 'in').map((m) => (m.body ?? '').trim()).filter(Boolean).join(' / ')
        : '';
      const esitoTurno = !!result.outcome || result.appointmentFixed || spostamentoFatto;
      // Arrivato a ridosso della domanda: il lead stava ancora scrivendo. Non e' la risposta
      // a questa domanda; se la domanda era la 2, e' il seguito della risposta alla 1.
      const rispostaA = attesa && !attesa.continuazione ? attesa.step : null;
      const seguitoDi: 1 | null = attesa?.continuazione && attesa.step === 2 ? 1 : null;
      const turnoFuoriTema = parlaDAltro(testoLeadTurno);
      const turnoPresaDAtto = isSoloPresaDAtto(testoLeadTurno);
      const turnoSoloVideo = confermaVideoVisto(testoLeadTurno) && testoLeadTurno.split(/\s+/).filter(Boolean).length <= 3;
      const decisioneDomanda: DomandaDecisa | null = warmupAttivo
        ? decidiDomanda(motivoWarmup, gdoWarmupStep, {
            esito: esitoTurno,
            passaggio: result.passToHuman,
            disdettaOSpostamento: parlaDiDisdireOSpostare(testoLeadTurno),
            spiegaNoemi: rigenerataNoemi,
            fallback: passaggioBloccato,
            videoInUscita: videoInsiemeAllaRisposta,
            rispostaModello: visibleReply,
            fuoriTema: turnoFuoriTema,
            continuazione: !!attesa?.continuazione,
          })
        : null;
      // La domanda va in fondo all'ultima bolla della risposta, mai in una bolla sua.
      // Se intanto il lead ha scritto ancora (sta mandando piu' bolle), la domanda aspetta
      // il turno dopo: prima finisce di scrivere lui (conv 28813).
      let bollaDomanda: string | null = null;
      let leadScriveAncora = false;
      if (decisioneDomanda?.domanda) {
        leadScriveAncora = await inboundArrivatoDopo(supabase, conversationId, ultimoInboundId(rows));
        if (!leadScriveAncora) {
          const accodata = accodaDomanda(parts, decisioneDomanda.domanda.testo);
          parts = accodata.parts;
          bollaDomanda = accodata.bolla;
        }
      }

      // Il video esce in coda alla risposta, come ultima bolla: prima si risponde a
      // quello che il lead ha chiesto, poi gli si dà il video.
      // La presa del recap in coda (se c'e'): si chiude dopo l'invio della sua bolla.
      let presaRecap: PresaRecapDrain | null = null;
      let bollaRecap: string | null = null;
      if (videoInsiemeAllaRisposta) {
        const bolla = await bollaVideoGdo();
        presaRecap = bolla.presa;
        bollaRecap = bolla.presa ? bolla.body : null;
        parts = [...parts, bolla.body];
      }

      // Link Fenice che il modello si è inventato (es. `conferenza-zx`): il lead lo
      // riceverebbe senza che ne resti traccia da nessuna parte. Non blocchiamo
      // l'invio — è un segnale diagnostico, non un filtro — ma l'URL fasullo va
      // registrato per poterlo ritrovare.
      const linkInventati = parts.flatMap((p) => unknownFeniceLinks(p, linkExtra));
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
      if (fissatoNelTurno && !videoGiaInviato) {
        const block = ensureConfirmationBlock(parts, { extraVideoLinks: linkExtra });
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
      let recapUscito = false;
      // La scheda partita in questo turno arriva al lead prima del testo che la segue.
      if (schedaPartitaAlMs !== null && parts.length > 0) {
        const attesa = distaccoSchedaMs - (Date.now() - schedaPartitaAlMs);
        if (attesa > 0) await sleep(attesa);
      }
      // Il passo del riscaldamento avanza solo se la bolla con la domanda e' partita.
      let domandaUscita = false;
      try {
        for (let i = 0; i < parts.length; i++) {
          if (i > 0) await sleep(Math.min(3000, 800 + parts[i].length * 25));
          const sent = await sendFreeText({ to: phone, body: parts[i], from });
          if (bollaDomanda && parts[i] === bollaDomanda) domandaUscita = true;
          if (presaRecap && !recapUscito && parts[i] === bollaRecap) {
            recapUscito = true;
            await recapPartito(presaRecap);
          }
          await supabase.from('messages').insert({
            conversation_id: conversationId, direction: 'out', body: parts[i],
            twilio_sid: sent.sid, twilio_status: sent.status,
            sender: 'bot',
          });
        }
      } catch (err) {
        if (presaRecap && !recapUscito) await recapNonPartito(presaRecap);
        throw err;
      }
      if (parts.length > 0) {
        await supabase.from('conversations')
          .update({ last_message_at: new Date().toISOString() })
          .eq('id', conversationId);
      }

      // Scheda del corso (spec §3) non ancora partita (di solito parte subito, qui sopra):
      // dopo l'appuntamento esce col video, prima se Mario la chiede col tag. `inviaScheda`
      // e' idempotente sulla colonna.
      if (result.schedaNonValida) {
        await supabase.from('event_log').insert({
          type: 'scheda_slug_non_valido',
          payload: { conversationId, slug: result.schedaNonValida } as never,
          message: `[professioni] conv ${conversationId}: Mario ha chiesto la scheda "${result.schedaNonValida}" che non esiste`,
          level: 'warn',
        });
      }
      // Stessa condizione della nota: nel postino e nel lancio in corso la scheda non parte mai.
      const scheda = vinceProfessioni ? schedaDaInviare({
        professione,
        schedaInviataAt,
        schedaRichiesta: result.schedaRichiesta,
        appuntamentoConVideoOra: fissatoNelTurno && !videoGiaInviato && parts.some((p) => containsVideoLink(p, linkExtra)),
      }) : null;
      if (scheda) {
        const esitoScheda = await inviaScheda(supabase, { conversationId, phone, from, ...scheda });
        if (esitoScheda === 'inviata') {
          schedaInviataAt = new Date().toISOString();
          // Chat entrata senza corso riconosciuto: lo slug del tag e' il corso scelto. Si
          // salva, cosi' il video dopo l'appuntamento e il sollecito dedicato lo conoscono.
          if (professione === null) {
            professione = scheda.slug;
            const { error: erroreCorso } = await supabase.from('conversations')
              .update({ professione: scheda.slug }).eq('id', conversationId);
            if (erroreCorso) {
              await supabase.from('event_log').insert({
                type: 'professione_non_scritta',
                payload: { conversationId, slug: scheda.slug, errore: erroreCorso.message } as never,
                message: `[professioni] conv ${conversationId}: corso ${scheda.slug} dal tag NON scritto — ${erroreCorso.message}`,
                level: 'warn',
              });
            }
          }
        }
      }
      // Brochure su richiesta fuori dal funnel: parte solo col tag di Mario e solo nei turni
      // con la richiesta accesa. `professione` NON si scrive: la chat diventerebbe del funnel
      // (`professioniVince`) e prenderebbe il sollecito della scheda.
      if (!vinceProfessioni && richiestaScheda === 'da_mandare' && result.schedaRichiesta && !schedaInviataAt) {
        const esito = await inviaScheda(supabase, { conversationId, phone, from, slug: result.schedaRichiesta, momento: 'su_richiesta' });
        if (esito === 'inviata') schedaInviataAt = new Date().toISOString();
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
        payload: { conversationId, phone, appointmentFixed: fissatoNelTurno, appuntamentoScartato: motivoScarto, passToHuman: passaAPersona, ...(result.spostaAt !== undefined ? { spostaAt: result.spostaAt, spostamentoFatto } : {}) } as never,
        message: `Mario ha risposto a ${phone}`, level: 'info',
      });

      // Il secondo recapito che il lead dà in chat moriva qui: il bot rispondeva "lo
      // segno, avviso Noemi" e non lo segnava nessuno. [NOTA|...] è il canale già vivo
      // (lo stesso delle disdette): non è un esito, non tocca lo stato del lead, e la
      // conversazione prosegue esattamente come prima — per questo sta PRIMA della
      // gestione degli esiti, non al loro posto. Il messaggio al lead è già partito
      // sopra: un errore qui non deve mai propagarsi, altrimenti il `catch` del drain
      // rimetterebbe la conversazione 'active' e il prossimo giro rimanderebbe la
      // stessa risposta al lead una seconda volta.
      if (result.notaCrm && crmLeadId) {
        try {
          const secret = process.env.BOT_WEBHOOK_SECRET;
          const esitoNota = secret
            ? await inviaNotaAlCrm(supabase, conversationId, crmLeadId, result.notaCrm, undefined, secret)
            : { sent: false, error: 'not_configured' };
          if (!esitoNota.sent) {
            await supabase.from('event_log').insert({
              type: 'nota_secondo_recapito_non_inviata',
              payload: { conversationId, crmLeadId, error: esitoNota.error ?? null, status: esitoNota.status ?? null } as never,
              message: `[bot-fissatore] conv ${conversationId}: nota col secondo recapito del lead non inviata al CRM (${esitoNota.error ?? esitoNota.status})`,
              level: 'error',
            });
          }
        } catch (err) {
          const m = err instanceof Error ? err.message : 'errore';
          await supabase.from('event_log').insert({
            type: 'nota_secondo_recapito_non_inviata',
            payload: { conversationId, crmLeadId, error: m } as never,
            message: `[bot-fissatore] conv ${conversationId}: eccezione inviando la nota col secondo recapito del lead — ${m}`,
            level: 'error',
          });
        }
      }

      // Riscaldamento, il turno dopo una domanda: le parole del lead vanno SUBITO al CRM
      // come nota (mai un esito, mai un cambio di stato). Il messaggio al lead e' gia'
      // partito: un errore qui non deve mai propagarsi.
      const notaRiscaldamento = async (step: 1 | 2, opts: { continua?: boolean; testo?: string } = {}): Promise<boolean> => {
        if (!crmLeadId) return false;
        const { nota, alert } = notaRisposta(step, opts.testo ?? testoLeadTurno, { continua: opts.continua });
        const extra = opts.continua ? { continua: true } : {};
        try {
          const secret = process.env.BOT_WEBHOOK_SECRET;
          const esitoNota = secret
            ? await inviaNotaAlCrm(supabase, conversationId, crmLeadId, nota, undefined, secret)
            : { sent: false, error: 'not_configured' };
          const errore = esitoNota.sent ? null : (esitoNota.error ?? esitoNota.status ?? null);
          await supabase.from('event_log').insert({
            type: 'gdo_warmup_risposta_nota',
            payload: { conversationId, step, alert, inviata: esitoNota.sent, error: errore, ...extra } as never,
            message: `[gdo] conv ${conversationId}: ${opts.continua ? 'seguito della ' : ''}risposta alla domanda ${step} del riscaldamento${alert ? ' (⚠️)' : ''} ${esitoNota.sent ? 'inviata al CRM' : `NON inviata (${errore})`}`,
            level: esitoNota.sent ? 'info' : 'error',
          });
          return esitoNota.sent;
        } catch (err) {
          const m = err instanceof Error ? err.message : 'errore';
          await supabase.from('event_log').insert({
            type: 'gdo_warmup_risposta_nota',
            payload: { conversationId, step, alert, inviata: false, error: m, ...extra } as never,
            message: `[gdo] conv ${conversationId}: eccezione inviando la risposta alla domanda ${step} del riscaldamento — ${m}`,
            level: 'error',
          });
          return false;
        }
      };
      // I messaggi arrivati mentre il turno girava (dopo la nostra bolla in cronologia):
      // nessun turno li rileggerebbe, quindi contano per la nota di QUESTO turno (conv 28998:
      // «Fatto» e 20 secondi dopo la risposta vera). Letti solo se una domanda e' in attesa.
      const arrivatiDurante = rispostaA || seguitoDi
        ? await inboundArrivatiDopo(supabase, conversationId, ultimoInboundId(rows))
        : [];
      const testoNota = testoRispostaCompleto(testoLeadTurno, arrivatiDurante);
      const notaPresaDAtto = arrivatiDurante.length > 0 ? isSoloPresaDAtto(testoNota) : turnoPresaDAtto;
      const notaSoloVideo = arrivatiDurante.length > 0
        ? confermaVideoVisto(testoNota) && testoNota.split(/\s+/).filter(Boolean).length <= 3
        : turnoSoloVideo;
      const daNotare = eRispostaDaNotare({
        testo: testoNota,
        esito: esitoTurno,
        passaggio: result.passToHuman,
        soloPresaDAtto: notaPresaDAtto,
        soloConfermaVideo: notaSoloVideo,
      });
      if (rispostaA && daNotare) await notaRiscaldamento(rispostaA, { testo: testoNota });
      if (seguitoDi && daNotare) await notaRiscaldamento(seguitoDi, { continua: true, testo: testoNota });

      // Diagnostica del riscaldamento: perche' la domanda parte o salta. Non deve mai
      // rompere il turno: la risposta e' gia' uscita.
      if (motivoWarmup) {
        try {
          const domanda = leadScriveAncora && decisioneDomanda?.domanda
            ? 'lead_scrive_ancora'
            : decisioneDomanda?.domanda
              ? (domandaUscita ? `inviata_${decisioneDomanda.domanda.step}` : 'non_uscita')
              : (decisioneDomanda?.salto ?? motivoWarmup);
          await supabase.from('event_log').insert({
            type: 'gdo_warmup_nota',
            payload: { conversationId, step: stepWarmupTurno, motivo: motivoWarmup, domanda, rispostaA, ...(attesa?.continuazione ? { continuazione: true } : {}) } as never,
            message: `[gdo] conv ${conversationId}: riscaldamento passo ${stepWarmupTurno ?? 0}, motivo ${motivoWarmup}, domanda ${domanda}`,
            level: 'info',
          });
        } catch {
          // solo diagnostica
        }
      }

      // Il passo: avanza alla domanda appena uscita; dopo la domanda 2 il primo turno vero
      // del lead chiude (risposta o no, la domanda non si ripete). Non chiudono il turno
      // scritto a ridosso della domanda, quello fuori tema (problema del video…) e il solo
      // "ok"/"fatto": la domanda 2 resta in attesa per i turni dopo. Un errore non si propaga.
      const attesaDomanda2Resta = attesa?.step === 2
        && (attesa.continuazione || turnoFuoriTema || notaPresaDAtto || notaSoloVideo);
      const passoNuovo = domandaUscita && decisioneDomanda?.domanda
        ? decisioneDomanda.domanda.step
        : warmupAttivo && (gdoWarmupStep ?? 0) === 2 && !attesaDomanda2Resta
          ? RISCALDAMENTO_CHIUSO
          : null;
      if (domandaUscita && decisioneDomanda?.domanda) {
        await supabase.from('event_log').insert({
          type: 'gdo_warmup_domanda_inviata',
          payload: { conversationId, step: decisioneDomanda.domanda.step } as never,
          message: `[gdo] conv ${conversationId}: domanda ${decisioneDomanda.domanda.step} del riscaldamento inviata`,
          level: 'info',
        });
      }
      if (passoNuovo !== null) {
        const chiuso = passoNuovo === RISCALDAMENTO_CHIUSO;
        const { error: erroreWarmup } = await supabase.from('conversations')
          .update({
            gdo_warmup_step: passoNuovo,
            ...(chiuso ? { gdo_warmup_closed_at: new Date().toISOString() } : {}),
          })
          .eq('id', conversationId);
        if (erroreWarmup) {
          await supabase.from('event_log').insert({
            type: 'gdo_warmup_step_non_scritto',
            payload: { conversationId, da: gdoWarmupStep, a: passoNuovo, errore: erroreWarmup.message } as never,
            message: `[gdo] conv ${conversationId}: passo del riscaldamento ${passoNuovo} NON scritto — ${erroreWarmup.message}`,
            level: 'warn',
          });
        } else if (chiuso) {
          await supabase.from('event_log').insert({
            type: 'gdo_warmup_step',
            payload: { conversationId, da: gdoWarmupStep, a: passoNuovo } as never,
            message: `[gdo] conv ${conversationId}: riscaldamento chiuso dopo la domanda 2`,
            level: 'info',
          });
        }
        // Anche se la scrittura fallisce: nello stesso drain non si rifa' la domanda.
        gdoWarmupStep = passoNuovo;
      }

      if (result.outcome) {
        // Il drain claima solo da 'active' (vedi il lock CAS sopra): aiStatus qui è
        // sempre 'active'. Il ramo 'booked' di canSendOutcome resta comunque la rete
        // a costo zero descritta nel suo commento.
        const canSend = canSendOutcome({ crmLeadId, aiStatus: 'active' });
        // Il funnel ha vinto su una chat con un'agenda GDO (conv 3292): al CRM il lead e'
        // ancora del GDO, e /api/bot/outcome accetta da noi solo NOTA, CONTATTO_UMANO e
        // APPUNTAMENTO (questo solo se il bot aveva il lead). Gli altri esiti restano note,
        // come sul postino, senza chiudere; l'appuntamento rifiutato torna indietro come nota.
        // CONTATTO_UMANO non passa di qui: e' il ramo `passaAPersona`, gia' pieno.
        const exPostino = agendaGdo && !postino;
        const soloNota = postino || (exPostino && result.outcome !== 'APPUNTAMENTO');
        if (canSend) {
          // Sui lead del GDO niente report: al CRM va solo la nota, e il report
          // popolerebbe campi di un lead che non è nostro.
          const report = soloNota ? undefined : await generateBotReport(history);
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
            // I due giorni prenotabili che il modello ha visto in QUESTO turno: la
            // guardia sulla data li usa al posto di ricalcolarli. A mezzanotte (ora di
            // Roma) l'ancora dei giorni ruota, e una call promessa poco prima veniva scartata dopo
            // essere già stata confermata al lead in chat.
            // Più i giorni che il form offriva quando è partito il link: vedi `giorniTurno`.
            bookingDays: giorniTurno,
          }, soloNota
            ? { noteOnly: true }
            : { ...(exPostino ? { notaSeRifiutato: true } : {}), ...(appuntamentoScartato ? { segnalaSeDataScartata: true } : {}) });
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
          if (!soloNota && !sent.keepOpen && (sent.sent || sent.error === 'note_duplicate')) {
            finalStatus = 'closed';
          }
          break;
        }
        if (!soloNota) {
          // Lead adottato: il CRM non lo conosce, quindi `crm_lead_id` e' nullo e
          // l'esito non ha dove andare. Senza questo ramo non veniva scritto NIENTE —
          // `bot_outcome`, `bot_outcome_at` e `bot_scheduled_at` li tocca solo
          // `sendOutcome` dopo un 2xx — e l'appuntamento appena fissato non esisteva
          // da nessuna parte: ne' sulla riga, ne' negli eventi, ne' in
          // `/api/bot/lead-entranti`, che quelle tre colonne le legge per dire al CRM
          // che quella persona ha gia' una call in agenda.
          //
          // Le decisioni sono le STESSE del ramo normale (declassamento, guardia sulla
          // data, richiamo senza data): vivono in `registraEsitoSenzaLeadId`, accanto a
          // `sendOutcome`, e qui si salta solo la rete. Se `chiudi` e' falso la
          // conversazione resta viva apposta: il bot deve poter ancora chiedere una
          // data buona invece di sparire.
          const locale = await registraEsitoSenzaLeadId(
            supabase,
            conversationId,
            {
              outcome: result.outcome,
              date: result.scheduledAt,
              discardReason: result.discardReason,
              note: result.note,
              leadWords: [...history].reverse().find((t) => t.role === 'user')?.content,
              // Gli stessi due giorni che viaggiano verso `sendOutcome` qui sopra: la
              // guardia sulla data li vuole anche sugli adottati, o a mezzanotte l'ancora
              // ruota e la call appena promessa in chat risulta fuori finestra.
              bookingDays: giorniTurno,
            },
            { botOutcome: esitoInPiedi, botScheduledAt: dataInPiedi },
          );
          if (locale.chiudi) finalStatus = 'closed';
          break;
        }
      }

      if (passaAPersona) {
        // Il CRM ha un esito apposta (CONTATTO_UMANO, dal 05/08). Senza questa chiamata
        // la richiesta di parlare con una persona resta solo nel nostro database e
        // nessuno la vede: 6 casi fra i 338 lead che ci hanno segnalato come fermi.
        // Le parole che mandiamo sono quelle del lead, prese dall'ultimo turno della
        // cronologia — una parafrasi del modello cambierebbe il senso della richiesta.
        if (crmLeadId) {
          // Il messaggio con la richiesta vera (`motivoRichiesta`), non l'ultimo: nelle
          // chat vere l'ultimo è spesso "Grazie" o "ok" e in coda CRM non dice niente.
          const ultimoDelLead = paroleDellaRichiesta(rows)
            ?? [...history].reverse().find((t) => t.role === 'user')?.content;
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
        // Quando e con che parole il lead ha chiesto la persona. Senza questo, per
        // ricostruire il motivo si finisce sull'ULTIMO messaggio in ingresso — che
        // nelle chat vere e' quasi sempre "Ok" o "Grazie", e a chi deve richiamare non
        // dice niente. L'errore non si propaga: se la colonna non c'e' ancora (migration
        // 20260825000001 non applicata) il passaggio a una persona avviene lo stesso.
        {
          const ultimoDelLead = paroleDellaRichiesta(rows)
            ?? [...history].reverse().find((t) => t.role === 'user')?.content ?? null;
          const { error: errHandoff } = await supabase.from('conversations')
            .update({ handed_off_at: new Date().toISOString(), handed_off_reason: ultimoDelLead })
            .eq('id', conversationId);
          if (errHandoff) {
            await supabase.from('event_log').insert({
              type: 'handed_off_non_registrato',
              payload: { conversationId, error: errHandoff.message } as never,
              message: `[bot-fissatore] conv ${conversationId}: motivo del passaggio non registrato (${errHandoff.message})`,
              level: 'warn',
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
