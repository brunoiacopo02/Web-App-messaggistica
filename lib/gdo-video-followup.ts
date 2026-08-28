import { BLACK_SUMMER_LINK } from './gdo-agenda';
import type { MarioTurn } from './mario';

/**
 * Solleciti del video ai lead dei GDO: due touch, ancorati al giorno in cui il lead
 * riceve l'agenda (21:30 quel giorno, 10:00 il giorno dopo). Qui la sola decisione,
 * senza effetti: il cron la usa e agisce.
 */

export type GdoFollowupAction = 'video-template' | 'sollecito-libero' | 'sollecito-template' | 'none';
export type GdoSlot = 'sera' | 'mattina';

/** Sotto questa soglia si sta parlando col lead: il promemoria lo porta la chat. */
export const CONVERSAZIONE_VIVA_MS = 6 * 3600_000;
/** Oltre questa, WhatsApp accetta solo template. */
export const FINESTRA_24H_MS = 24 * 3600_000;
/** Ripiego finché il CRM non manda la data della call. */
export const ORA_AGENDA_TARDI = 18;

export interface GdoFollowupInput {
  gdoAgendaAt: string | null;
  gdoVideoSentAt: string | null;
  gdoVideoWatchedAt: string | null;
  followupsSent: number;
  /** Data della call. Oggi il CRM non la manda: quasi sempre null. */
  appointmentAt: string | null;
  lastInboundAtMs: number | null;
  lastMessageIsInbound: boolean;
  nowMs: number;
  slot: GdoSlot;
  /** Giorni di calendario italiani fra l'agenda e adesso: 0 = stessa giornata. */
  giorniDaAgenda: number;
  /** Ora italiana in cui è arrivata l'agenda. */
  romeHourAgenda: number;
  /** Il lead ha scritto qualcosa DOPO che gli è arrivato il video. */
  haRispostoDopoVideo: boolean;
}

export function decideGdoVideoFollowup(i: GdoFollowupInput): GdoFollowupAction {
  if (!i.gdoAgendaAt) return 'none';

  // Gli slot appartengono a UNA agenda: la sera è quella stessa giornata, il mattino
  // è il giorno dopo. Un'agenda di tre giorni fa non ha più slot da servire.
  const giorniAttesi = i.slot === 'sera' ? 0 : 1;
  if (i.giorniDaAgenda !== giorniAttesi) return 'none';

  // Un sollecito dopo la call è solo danno. Una data illeggibile vale come sconosciuta.
  const appointmentTime = i.appointmentAt ? Date.parse(i.appointmentAt) : NaN;
  const hasValidAppointment = !Number.isNaN(appointmentTime);

  if (hasValidAppointment && appointmentTime <= i.nowMs) return 'none';

  if (!hasValidAppointment && i.slot === 'sera' && i.romeHourAgenda >= ORA_AGENDA_TARDI) {
    // Senza la data vera, un'agenda arrivata a sera è probabilmente una call a
    // ridosso — o già avvenuta. Si tace e si riprova il mattino dopo.
    return 'none';
  }

  if (i.gdoVideoWatchedAt) return 'none';

  // Ha risposto dopo il video: da qui in poi non è più un lead freddo da sbloccare con
  // un messaggio programmato, è una conversazione. Il promemoria del video viaggia
  // dentro la risposta del modello (NOTA_VIDEO), che si adatta a quello che ha detto.
  // Fra i lead GDO che hanno risposto almeno una volta, chi riceve 2 solleciti disdice
  // al 22,4% contro il 7,6% di chi non ne riceve (misura del 04/08/2026).
  if (i.haRispostoDopoVideo) return 'none';

  if (i.followupsSent >= 2) return 'none';

  const daUltimoInbound = i.lastInboundAtMs === null ? null : i.nowMs - i.lastInboundAtMs;

  // Si sta parlando: un messaggio programmato addosso stona, e il promemoria arriva
  // comunque dentro la risposta del modello (lib/gdo-context-note.ts).
  if (daUltimoInbound !== null && daUltimoInbound < CONVERSAZIONE_VIVA_MS) return 'none';

  // Sua domanda senza risposta: ci pensa il re-drive di bot-followups. Due nostri
  // messaggi di fila sarebbero maleducati.
  if (i.lastMessageIsInbound) return 'none';

  if (!i.gdoVideoSentAt) return 'video-template';

  const finestraAperta = daUltimoInbound !== null && daUltimoInbound < FINESTRA_24H_MS;
  return finestraAperta ? 'sollecito-libero' : 'sollecito-template';
}

/**
 * Turno sintetico che chiude la cronologia del sollecito libero. Non è un messaggio del
 * lead e va scritto in modo che il modello non lo scambi per tale: è la nostra decisione
 * di riprendere il filo.
 */
export const TURNO_RIPRESA_SOLLECITO =
  '[nota di sistema, non è un messaggio del lead: il lead non risponde da qualche ora. ' +
  'Riprendi tu il filo del discorso seguendo le note di contesto.]';

/**
 * Cronologia da passare al modello quando siamo NOI a riprendere il filo, senza un
 * messaggio del lead a cui rispondere.
 *
 * `decideGdoVideoFollowup` restituisce un'azione solo quando l'ultimo messaggio della
 * chat è nostro (`lastMessageIsInbound === false`): la cronologia grezza finirebbe
 * quindi SEMPRE con un turno `assistant`, e su claude-sonnet-4-6 il prefill dell'ultimo
 * turno assistant non esiste più — l'API risponde 400 e il sollecito non parte. Il turno
 * sintetico in coda chiude la cronologia lato `user` ed è anche più onesto: qui non c'è
 * un messaggio a cui rispondere, c'è una nostra decisione di riagganciare.
 *
 * `turnoDiRipresa` è parametrico perché il problema non è solo dei solleciti GDO: il
 * recupero delle mancate risposte al telefono (`/api/bot/call-attempt`) scrive nello
 * stesso identico punto — dopo un nostro messaggio — e ha bisogno dello stesso turno
 * sintetico, ma con le sue parole (là non è "il lead non risponde da qualche ora", è
 * "le Conferme hanno appena provato a chiamarlo").
 *
 * Cronologia vuota (tutte le righe precedono `ai_started_at`): si lascia vuota, così
 * `generateMarioReply` usa la sua apertura — il turno sintetico da solo, senza nessun
 * filo da riprendere, direbbe al modello una cosa falsa.
 */
export function buildSollecitoHistory(
  rows: { direction: string; body: string }[],
  turnoDiRipresa: string = TURNO_RIPRESA_SOLLECITO,
): MarioTurn[] {
  const history: MarioTurn[] = rows.map((m) => ({
    role: m.direction === 'in' ? 'user' : 'assistant',
    content: m.body,
  }));
  if (history.length === 0) return history;
  return [...history, { role: 'user', content: turnoDiRipresa }];
}

/** Pausa prima di una bolla, come nel drain: la riga dopo non arriva addosso alla prima. */
export const pausaFraBolle = (body: string): number => Math.min(3000, 800 + body.length * 25);

export type BolleDeps = {
  /** Manda una bolla e torna gli identificativi Twilio. */
  invia: (body: string) => Promise<{ sid?: string; status?: string }>;
  /** Dopo ogni bolla accettata da Twilio: segna il touch e registra il messaggio. */
  dopoInvio: (bolla: { body: string; sid?: string; status?: string; indice: number }) => Promise<void>;
  /** Il giro si interrompe qui. L'errore non si perde: chi chiama lo registra. */
  suErrore: (info: { indice: number; previste: number; errore: string }) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
};

/**
 * Manda un sollecito libero a bolle e torna QUELLE DAVVERO USCITE.
 *
 * L'invio a bolle non è atomico come quello a bolla singola: un `sendFreeText` che
 * esplode a metà lascerebbe il lead con un sollecito troncato e, se il touch si
 * segnasse solo a fine ciclo, con il contatore fermo — allo slot dopo ne riceverebbe un
 * terzo, contro il tetto dei due touch. Per questo `dopoInvio` è chiamata subito dopo
 * ogni bolla accettata (chi chiama ci segna il touch, idempotente) e non a fine giro.
 *
 * Una bolla accettata da Twilio conta come spedita anche se la registrazione a valle
 * fallisce: il lead l'ha ricevuta, e il testo davvero uscito è quello che decide se
 * Noemi è stata nominata o no.
 */
export async function inviaBolleSollecito(parts: string[], deps: BolleDeps): Promise<string[]> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const spedite: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) await sleep(pausaFraBolle(parts[i]));
    try {
      const twilio = await deps.invia(parts[i]);
      spedite.push(parts[i]);
      await deps.dopoInvio({ body: parts[i], sid: twilio.sid, status: twilio.status, indice: i });
    } catch (err) {
      const e = err as { message?: string };
      await deps.suErrore({ indice: i, previste: parts.length, errore: e?.message ?? 'errore ignoto' });
      break;
    }
  }
  return spedite;
}

/**
 * Quale variabile d'ambiente contiene il template video per un dato link.
 * Fail-closed: un link non in mappa, o una env vuota, non produce nessun invio.
 */
export const VIDEO_TEMPLATE_ENV_BY_LINK: Record<string, string> = {
  'https://corso.feniceacademy.it/conferenza-bx': 'VIDEO_GDO_LAVORA_SID',
  'https://corso.feniceacademy.it/conferenza-axmsbn9r50': 'VIDEO_GDO_NONLAVORA_SID',
  'https://corso.feniceacademy.it/conferenza-dx': 'VIDEO_GDO_LAVORA_FAMIGLIA_SID',
  'https://corso.feniceacademy.it/conferenza-ex': 'VIDEO_GDO_NONLAVORA_FAMIGLIA_SID',
  [BLACK_SUMMER_LINK]: 'VIDEO_GDO_OFFERTA_SID',
};
