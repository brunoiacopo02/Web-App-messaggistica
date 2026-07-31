import { BLACK_SUMMER_LINK } from './gdo-agenda';

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
}

export function decideGdoVideoFollowup(i: GdoFollowupInput): GdoFollowupAction {
  if (!i.gdoAgendaAt) return 'none';

  // Gli slot appartengono a UNA agenda: la sera è quella stessa giornata, il mattino
  // è il giorno dopo. Un'agenda di tre giorni fa non ha più slot da servire.
  const giorniAttesi = i.slot === 'sera' ? 0 : 1;
  if (i.giorniDaAgenda !== giorniAttesi) return 'none';

  // Un sollecito dopo la call è solo danno.
  if (i.appointmentAt) {
    const at = Date.parse(i.appointmentAt);
    if (!Number.isNaN(at) && at <= i.nowMs) return 'none';
  } else if (i.slot === 'sera' && i.romeHourAgenda >= ORA_AGENDA_TARDI) {
    // Senza la data vera, un'agenda arrivata a sera è probabilmente una call a
    // ridosso — o già avvenuta. Si tace e si riprova il mattino dopo.
    return 'none';
  }

  if (i.gdoVideoWatchedAt) return 'none';
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
