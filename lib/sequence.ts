import { firstNameOf } from './name';

const H = 3600_000;
const D = 24 * H;

// Sequenza Track A: offset dei follow-up (giorni dal PRIMO outbound) e chiusura.
//
// 01/08/2026 — sequenza tagliata a UN SOLO follow-up. Sui dati dei primi 7 giorni il
// touch 1 ha reso 26 risposte su 101 consegnati e 3 appuntamenti; i touch 2 e 3 insieme
// 11 risposte su 70 consegnati e ZERO appuntamenti, con la lettura in calo a ogni giro
// (54% → 42% → 38%). Sono template MARKETING verso chi non risponde: il prezzo lo paga
// la reputazione del numero (qualità Meta scesa a LOW), il ricavo non esiste.
export const TOUCH_OFFSETS_DAYS: number[] = [1];
export const SEQUENCE_END_DAYS = 4;
// Track B (lead che ha risposto poi tace): finestra del nudge gratuito e resa.
// I due template di riaggancio sono stati rimossi (18 risposte su 74 consegnati, metà
// delle quali un "NO" secco, zero appuntamenti): resta il solo nudge free-text, che
// viaggia dentro la finestra 24h e non consuma reputazione.
export const NUDGE1_MIN_H = 18; export const NUDGE1_MAX_H = 24;
// 07/08/2026 — la resa passa da 120h a 288h (12 giorni). Per il CRM classificare
// significa restituire il lead: INTERROTTO lo rimette nel giro dei GDO umani. A cinque
// giorni la chat puo' ancora ripartire, e quando riparte due canali lavorano la stessa
// persona senza vedersi — caso Marina Destefanis del 26/07: restituita, riassegnata a
// un GDO che l'ha chiamata tre volte e poi scartata, mentre il giorno dopo il bot
// fissava l'appuntamento.
export const TRACKB_GIVEUP_H = 288;

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

/** ISO 8601 con offset esplicito Europe/Rome (es. 2026-08-07T09:00:00+02:00): il CRM
 * rifiuta con 400 le date senza offset. */
export function toRomeIso(ms: number): string {
  const d = new Date(ms);
  const local = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Rome',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(d).replace(' ', 'T');
  const tzName = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Rome', timeZoneName: 'longOffset' })
    .formatToParts(d).find((p) => p.type === 'timeZoneName')?.value ?? '';
  const m = tzName.match(/GMT([+-]\d{2}:\d{2})/);
  return local + (m ? m[1] : '+02:00');
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
  // "Abbiamo davvero smesso di lavorarlo" vuol dire due cose insieme: silenzio oltre la
  // resa E nessun invio ancora previsto. Finché il nudge gratuito è da spendere e la sua
  // finestra non è passata, il lead è ancora nostro e non si restituisce.
  const abbiamoFinito = nudgesSent >= 1 || silH >= NUDGE1_MAX_H;
  // La resa classifica sempre (non è un invio: kill-switch e fascia non contano).
  if (silH >= TRACKB_GIVEUP_H && abbiamoFinito) return { kind: 'classify' };
  if (!sequenceEnabled || !inSendWindow(nowMs)) return { kind: 'wait' };
  // Unico richiamo rimasto: free-text dentro la finestra 24h (silenzio in [18,24)).
  // Persa quella finestra non si insegue più con un template: si aspetta la resa.
  if (nudgesSent === 0 && silH >= NUDGE1_MIN_H && silH < NUDGE1_MAX_H) return { kind: 'nudge_free' };
  return { kind: 'wait' };
}

// Nudge free-text della persona (Mario/Marta): richiamo gentile, mai pressante.
const NUDGE_VARIANTS: ((name: string, persona: string) => string)[] = [
  (n, p) => `Ciao${n}, sono ${p}! Ancora qui se ti va di riprendere il discorso da dove eravamo rimasti. Nessuna fretta!`,
  (n, p) => `Ehi${n}, sono ${p}: ci eravamo persi a metà chiacchierata! Se ti va di continuare, io sono qui.`,
  (n, p) => `Ciao${n}, sono ${p}! Se ti è rimasto qualche dubbio o vuoi riprendere il discorso, scrivimi pure quando ti è comodo.`,
];

export function pickNudgeText(conversationId: number, firstName: string | null, personaName: string = 'Mario'): string {
  const clean = firstNameOf(firstName);
  const name = clean ? ` ${clean}` : '';
  return NUDGE_VARIANTS[conversationId % 3](name, personaName);
}
