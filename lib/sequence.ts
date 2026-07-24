const H = 3600_000;
const D = 24 * H;

// Sequenza Track A: offset dei follow-up (giorni dal PRIMO outbound) e chiusura.
export const TOUCH_OFFSETS_DAYS: number[] = [1, 3, 7, 12];
export const SEQUENCE_END_DAYS = 14;
// Track B (lead che ha risposto poi tace): finestre nudge e resa.
export const NUDGE1_MIN_H = 18; export const NUDGE1_MAX_H = 24;
export const NUDGE2_H = 48; export const NUDGE3_H = 96;
export const TRACKB_GIVEUP_H = 120;

const FAST_FAIL_H = 48;   // numero morto: touch>=1 e mai nulla consegnato
const MIN_GAP_OUT_H = 20; // anti-doppione tra due out consecutivi

export type MsgLite = { direction: string; twilio_status: string | null; template_sid: string | null; created_at: string; is_template?: boolean };

const romeFmt = new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', hour: 'numeric', minute: 'numeric', hour12: false });

/** Fascia invii 08:30 (inclusa) – 20:30 (esclusa), ora locale Europe/Rome. */
export function inSendWindow(nowMs: number): boolean {
  const parts = romeFmt.formatToParts(new Date(nowMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const mins = get('hour') * 60 + get('minute');
  return mins >= 8 * 60 + 30 && mins < 20 * 60 + 30;
}

const outs = (msgs: MsgLite[]) => msgs.filter((m) => m.direction === 'out');

export function anyDelivered(msgs: MsgLite[]): boolean {
  return outs(msgs).some((m) => m.twilio_status === 'delivered' || m.twilio_status === 'read');
}

/** Numero morto: almeno un out e TUTTI con esito negativo certo (mai delivered/read). */
export function allOutboundDeadNoDelivery(msgs: MsgLite[]): boolean {
  const o = outs(msgs);
  return o.length >= 1 && o.every((m) => m.twilio_status === 'undelivered' || m.twilio_status === 'failed');
}

export function countSequenceTouches(msgs: MsgLite[], seqSids: string[]): number {
  return outs(msgs).filter((m) => m.template_sid != null && seqSids.includes(m.template_sid)).length;
}

export function firstOutboundAtMs(msgs: MsgLite[]): number | null {
  const ts = outs(msgs).map((m) => Date.parse(m.created_at));
  return ts.length ? Math.min(...ts) : null;
}

export function lastOutboundAtMs(msgs: MsgLite[]): number | null {
  const ts = outs(msgs).map((m) => Date.parse(m.created_at));
  return ts.length ? Math.max(...ts) : null;
}

export type TrackAAction =
  | { kind: 'send_opening' }
  | { kind: 'send_touch'; touchIndex: number }
  | { kind: 'discard_dead' }
  | { kind: 'non_risposto' }
  | { kind: 'wait' };

/** Track A: lead CRM mai risposto. Puro. */
export function decideTrackA(input: {
  nowMs: number;
  msgs: MsgLite[];
  seqSids: string[];
  sequenceEnabled: boolean;
}): TrackAAction {
  const { nowMs, msgs, seqSids, sequenceEnabled } = input;
  const t0 = firstOutboundAtMs(msgs);
  if (t0 === null) {
    // Apertura differita: la conv CRM esiste ma non è ancora partito nulla.
    return inSendWindow(nowMs) && sequenceEnabled ? { kind: 'send_opening' } : { kind: 'wait' };
  }
  const touches = countSequenceTouches(msgs, seqSids);
  // Fast-fail: già ritentato almeno una volta e mai consegnato nulla → numero morto.
  if (touches >= 1 && allOutboundDeadNoDelivery(msgs) && nowMs - t0 >= FAST_FAIL_H * H) {
    return { kind: 'discard_dead' };
  }
  // Chiusura a 14g: classificazione SEMPRE attiva, anche a kill-switch spento.
  if (nowMs - t0 >= SEQUENCE_END_DAYS * D) {
    return anyDelivered(msgs) ? { kind: 'non_risposto' } : { kind: 'discard_dead' };
  }
  if (
    touches < TOUCH_OFFSETS_DAYS.length &&
    nowMs - t0 >= TOUCH_OFFSETS_DAYS[touches] * D &&
    inSendWindow(nowMs) &&
    sequenceEnabled &&
    nowMs - (lastOutboundAtMs(msgs) ?? 0) >= MIN_GAP_OUT_H * H
  ) {
    return { kind: 'send_touch', touchIndex: touches + 1 };
  }
  return { kind: 'wait' };
}

export type TrackBAction =
  | { kind: 'nudge_free' }
  | { kind: 'nudge_template'; nudgeIndex: 1 | 2 }
  | { kind: 'classify' }
  | { kind: 'wait' };

/** Track B: lead che ha risposto poi è rimasto in silenzio. Puro. */
export function decideTrackB(input: {
  nowMs: number;
  lastInboundAtMs: number;
  nudgesSent: number;
  sequenceEnabled: boolean;
}): TrackBAction {
  const { nowMs, lastInboundAtMs, nudgesSent, sequenceEnabled } = input;
  const silH = (nowMs - lastInboundAtMs) / H;
  // La resa classifica sempre (non è un invio: kill-switch e fascia non contano).
  if (silH >= TRACKB_GIVEUP_H) return { kind: 'classify' };
  if (!sequenceEnabled || !inSendWindow(nowMs)) return { kind: 'wait' };
  // Nudge free solo dentro la finestra 24h WhatsApp (silenzio in [18,24)).
  if (nudgesSent === 0 && silH >= NUDGE1_MIN_H && silH < NUDGE1_MAX_H) return { kind: 'nudge_free' };
  // nudgesSent==0 a 48h = finestra free persa (es. lead notturno): recupero col template.
  if (nudgesSent === 0 && silH >= NUDGE2_H) return { kind: 'nudge_template', nudgeIndex: 1 };
  // A 96h il turno è comunque del secondo template, anche se il primo nudge è
  // stato il recupero (contatore a 1): progressione 0→t1→t2→classify garantita.
  if (nudgesSent === 1 && silH >= NUDGE3_H) return { kind: 'nudge_template', nudgeIndex: 2 };
  if (nudgesSent === 1 && silH >= NUDGE2_H) return { kind: 'nudge_template', nudgeIndex: 1 };
  if (nudgesSent === 2 && silH >= NUDGE3_H) return { kind: 'nudge_template', nudgeIndex: 2 };
  return { kind: 'wait' };
}

// Nudge free-text di Mario: richiamo gentile, mai pressante.
const NUDGE_VARIANTS: ((name: string) => string)[] = [
  (n) => `Ciao${n}! Sono ancora qui se ti va di riprendere il discorso da dove eravamo rimasti. Nessuna fretta!`,
  (n) => `Ehi${n}, ci eravamo persi a metà chiacchierata! Se ti va di continuare, io sono qui.`,
  (n) => `Ciao${n}! Se ti è rimasto qualche dubbio o vuoi riprendere il discorso, scrivimi pure quando ti è comodo.`,
];

export function pickNudgeText(conversationId: number, firstName: string | null): string {
  const name = firstName ? ` ${firstName}` : '';
  return NUDGE_VARIANTS[conversationId % 3](name);
}
