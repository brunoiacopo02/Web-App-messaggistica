import { romeOffset } from './rome-time';

const H = 3600_000;

export type ReminderKind = 'r24' | 'r3';

// Stessa granularità di sequence.ts (inSendWindow): estraiamo ora e minuto locali
// Europe/Rome via Intl, invece che assumere un offset fisso (qui serve anche il
// giorno solare per ricostruire l'istante clampato).
const romePartsFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Rome',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

type RomeParts = { y: number; m: number; d: number; hh: number; mm: number };

function romeParts(ms: number): RomeParts {
  const parts = romePartsFmt.formatToParts(new Date(ms));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return { y: get('year'), m: get('month'), d: get('day'), hh: get('hour'), mm: get('minute') };
}

/** Istante UTC (ms) corrispondente a y-m-d hh:mm in Europe/Rome, DST-safe:
 * come toRomeIso in sequence.ts ma nel verso opposto (locale -> ms), riusando
 * romeOffset di rome-time.ts per l'offset in vigore in quell'istante. */
function romeLocalMs(y: number, m: number, d: number, hh: number, mm: number): number {
  const guess = Date.UTC(y, m - 1, d, hh, mm, 0);
  const off = romeOffset(new Date(guess));
  const sign = off[0] === '-' ? -1 : 1;
  const [oh, om] = off.slice(1).split(':').map(Number);
  return guess - sign * (oh * 60 + om) * 60_000;
}

const WINDOW_START_MIN = 8 * 60 + 30;
const WINDOW_END_MIN = 20 * 60 + 30;

/** Clampa `ms` dentro la fascia 08:30-20:30 Europe/Rome dello stesso giorno solare Rome. */
function clampToSendWindow(ms: number): number {
  const p = romeParts(ms);
  const minsOfDay = p.hh * 60 + p.mm;
  if (minsOfDay < WINDOW_START_MIN) return romeLocalMs(p.y, p.m, p.d, 8, 30);
  if (minsOfDay >= WINDOW_END_MIN) return romeLocalMs(p.y, p.m, p.d, 20, 30);
  return ms;
}

/** R24 (24h prima) e R3 (3h prima) dell'appuntamento, clampati in fascia invii. */
export function reminderTargets(scheduledAtMs: number): { r24At: number; r3At: number } {
  return {
    r24At: clampToSendWindow(scheduledAtMs - 24 * H),
    r3At: clampToSendWindow(scheduledAtMs - 3 * H),
  };
}

/** Quale promemoria (se non già inviato) è dovuto adesso. R3 ha precedenza su R24:
 * un cron partito in ritardo deve saltare "ti ricordo domani" ed entrare
 * direttamente nella finestra delle 3h. Nessun invio negli ultimi 15 minuti o dopo. */
export function dueReminder(scheduledAtMs: number, nowMs: number, sent: ReminderKind[]): ReminderKind | null {
  if (nowMs >= scheduledAtMs - 15 * 60_000) return null;
  const { r24At, r3At } = reminderTargets(scheduledAtMs);
  if (nowMs >= r3At && !sent.includes('r3')) return 'r3';
  if (nowMs >= r24At && !sent.includes('r24')) return 'r24';
  return null;
}

const romeWeekdayFmt = new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', weekday: 'long' });

/** Etichetta leggibile dello slot: "oggi"/"domani"/nome del giorno + orario HH:MM. */
export function slotLabel(scheduledAtMs: number, nowMs: number): string {
  const appt = romeParts(scheduledAtMs);
  const now = romeParts(nowMs);
  const apptDayMs = Date.UTC(appt.y, appt.m - 1, appt.d);
  const nowDayMs = Date.UTC(now.y, now.m - 1, now.d);
  const dayDiff = Math.round((apptDayMs - nowDayMs) / (24 * 3600 * 1000));
  const time = `${String(appt.hh).padStart(2, '0')}:${String(appt.mm).padStart(2, '0')}`;
  if (dayDiff === 0) return `oggi alle ${time}`;
  if (dayDiff === 1) return `domani alle ${time}`;
  const dayName = romeWeekdayFmt.format(new Date(scheduledAtMs)).toLowerCase();
  return `${dayName} alle ${time}`;
}
