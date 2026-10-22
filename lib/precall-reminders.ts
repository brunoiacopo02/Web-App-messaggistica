import { formatRomeDateTime, giornoRoma, romeDaysBetween, romeHour, romeOffset } from './rome-time';
import { SOGLIA_STESSO_GIORNO } from './gdo-recap';
import { templateName } from './name';

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

/** Il promemoria a 24h chiede "hai visto il video?". Se il lead l'ha gia visto,
 * o comunque ha scritto qualcosa dopo aver ricevuto il link, quella domanda e
 * rumore: si usa la variante senza domanda, quando e configurata. */
export function pickReminder24Template(input: {
  hasVideoWatchedEvent: boolean;
  inboundAfterVideoMs: number | null;
  novideoSid: string | null;
  defaultSid: string;
}): string {
  const giaVisto = input.hasVideoWatchedEvent || input.inboundAfterVideoMs !== null;
  if (giaVisto && input.novideoSid) return input.novideoSid;
  return input.defaultSid;
}

// ── Promemoria del giorno prima per i lead GDO ──────────────────────────────────
//
// Il lead fissato al telefono da un GDO non riceveva il "ti ricordo domani" del bot:
// quello parte solo per bot_outcome = 'APPUNTAMENTO'. Qui solo il T-24h (il T-3h resta
// del bot), con dentro la chiamata di Noemi. Decisione e testi, senza I/O.

/** Agenda più giovane di così: la call è vicina e l'ha già coperta il recap. */
const GDO_AGENDA_MIN_MS = 12 * H;
/** Recap uscito da meno di così: il promemoria ripeterebbe le stesse cose. */
const GDO_RECAP_RECENTE_MS = 12 * H;
/** Il lead ha scritto da meno di così: si sta parlando, il promemoria lo porta la chat. */
const GDO_CONVERSAZIONE_VIVA_MS = 6 * H;
/** Finestra di 24h di WhatsApp: dentro si scrive libero, fuori solo template. */
const GDO_FINESTRA_MS = 24 * H;
/** Sotto questo anticipo il promemoria non serve più. */
const GDO_ANTICIPO_MIN_MS = 1 * H;

export interface GdoReminder24Input {
  enabled: boolean;
  gdoAgendaAt: string | null;
  botOutcome: string | null;
  appuntamentoAt: string | null;
  videoSentAt: string | null;
  recapSentAt: string | null;
  lastInboundAtMs: number | null;
  aiPausedAt: string | null;
  cancelRequestedAt: string | null;
  /** Già partito per QUESTA data della call (uno spostamento lo riapre). */
  giaInviato: boolean;
  nowMs: number;
}

/** Un istante del giorno in cui chiama Noemi: il giorno prima se la call è
 * prima delle 15, altrimenti lo stesso giorno qualche ora prima (come `quandoNoemi`). */
function giornoNoemi(call: Date): { giorno: Date; pomeriggio: boolean } {
  const pomeriggio = romeHour(call) < SOGLIA_STESSO_GIORNO;
  return { giorno: pomeriggio ? new Date(call.getTime() - 24 * H) : call, pomeriggio };
}

/** Il promemoria T-24h di un lead GDO: in template, in testo libero, o niente. */
export function decideGdoReminder24(i: GdoReminder24Input): 'template' | 'testo' | null {
  if (!i.enabled || !i.gdoAgendaAt || i.botOutcome === 'APPUNTAMENTO') return null;
  if (i.aiPausedAt || i.cancelRequestedAt || i.giaInviato) return null;
  // Il promemoria chiede del video: senza video uscito non ha senso.
  if (!i.videoSentAt || !i.appuntamentoAt) return null;

  const callMs = Date.parse(i.appuntamentoAt);
  if (Number.isNaN(callMs) || callMs - i.nowMs < GDO_ANTICIPO_MIN_MS) return null;
  if (i.nowMs < reminderTargets(callMs).r24At) return null;

  const agendaMs = Date.parse(i.gdoAgendaAt);
  if (Number.isNaN(agendaMs) || i.nowMs - agendaMs < GDO_AGENDA_MIN_MS) return null;

  const recapMs = i.recapSentAt ? Date.parse(i.recapSentAt) : NaN;
  if (!Number.isNaN(recapMs) && i.nowMs - recapMs < GDO_RECAP_RECENTE_MS) return null;

  // Cron in ritardo su una call del mattino: il pomeriggio di Noemi è già passato e
  // "oggi pomeriggio" sarebbe falso. Meglio niente.
  const noemi = giornoNoemi(new Date(callMs));
  if (noemi.pomeriggio && romeDaysBetween(new Date(i.nowMs), noemi.giorno) < 0) return null;

  const daUltimoInbound = i.lastInboundAtMs === null ? null : i.nowMs - i.lastInboundAtMs;
  if (daUltimoInbound !== null && daUltimoInbound < GDO_CONVERSAZIONE_VIVA_MS) return null;
  return daUltimoInbound !== null && daUltimoInbound < GDO_FINESTRA_MS ? 'testo' : 'template';
}

/** Quando chiama Noemi, detto rispetto a oggi: "oggi pomeriggio", "domani, qualche ora prima"… */
function noemiRelativo(call: Date, nowMs: number): string {
  const noemi = giornoNoemi(call);
  const suffisso = noemi.pomeriggio ? ' pomeriggio' : ', qualche ora prima';
  const giorni = romeDaysBetween(new Date(nowMs), noemi.giorno);
  if (giorni === 0) return `oggi${suffisso}`;
  if (giorni === 1) return `domani${suffisso}`;
  return `${giornoRoma(noemi.giorno)} pomeriggio`;
}

export type GdoReminderVars = { '1': string; '2': string; '3': string };

/** Variabili del template `fenice_reminder_24h_gdo_v1`. */
export function gdoReminderVars(i: { nome: string | null; call: Date; nowMs: number }): GdoReminderVars {
  return {
    '1': templateName(i.nome),
    '2': formatRomeDateTime(i.call.toISOString()),
    '3': noemiRelativo(i.call, i.nowMs),
  };
}

/** Lo stesso testo del template, per la finestra aperta (testo libero). */
export function gdoReminderText(v: GdoReminderVars): string {
  return `Ciao ${v['1']}, ti ricordo la tua videochiamata con Fenice Academy: ${v['2']}. ` +
    `Prima ti chiama Noemi, una collega, ${v['3']} da un numero di cellulare: rispondi, ` +
    "serve a confermare la videochiamata. Se non l'hai ancora fatto, guarda il video che ti ho mandato qui.";
}
