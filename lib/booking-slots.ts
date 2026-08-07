import { romeOffset, romeHour } from './rome-time';
import { bookingBlackout, isBookableDate, type BlackoutRange } from './booking-blackout';

// Calcolo degli unici due giorni in cui Mario può fissare l'appuntamento:
// "il giorno dopo" e "il giorno dopo ancora", saltando SEMPRE la domenica e i
// giorni in cui Fenice è chiusa (vedi booking-blackout.ts).

const WD_EN_TO_NUM: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

type Ymd = { y: number; m: number; d: number; wd: number };

const pad = (n: number) => String(n).padStart(2, '0');

/** Estrae anno/mese/giorno/giorno-settimana di `date` nel fuso Europe/Rome. */
function romeYmd(date: Date): Ymd {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Rome',
    year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return { y: +get('year'), m: +get('month'), d: +get('day'), wd: WD_EN_TO_NUM[get('weekday')] ?? 0 };
}

/** Somma `n` giorni di calendario usando un'ancora UTC a mezzogiorno (immune dalla DST). */
function addDays(v: Ymd, n: number): Ymd {
  const a = new Date(Date.UTC(v.y, v.m - 1, v.d, 12));
  a.setUTCDate(a.getUTCDate() + n);
  return { y: a.getUTCFullYear(), m: a.getUTCMonth() + 1, d: a.getUTCDate(), wd: a.getUTCDay() };
}

/** Primo giorno strettamente successivo a `v` che non sia domenica. */
function nextNonSunday(v: Ymd): Ymd {
  const n = addDays(v, 1);
  return n.wd === 0 ? addDays(n, 1) : n;
}

function labelIt(v: Ymd): string {
  const a = new Date(Date.UTC(v.y, v.m - 1, v.d, 12));
  const wd = new Intl.DateTimeFormat('it-IT', { timeZone: 'UTC', weekday: 'long' }).format(a);
  return `${wd} ${pad(v.d)}/${pad(v.m)}/${v.y}`;
}

const isoDate = (v: Ymd) => `${v.y}-${pad(v.m)}-${pad(v.d)}`;

/** Oltre questo orizzonte smettiamo di cercare: una env assurda non deve azzerare l'agenda. */
const MAX_SEARCH_DAYS = 60;

type Step = {
  /** Il giorno trovato. */
  day: Ymd;
  /** Ultimo giorno CHIUSO scavalcato per arrivarci (le domeniche non contano). */
  chiusuraScavalcata: Ymd | null;
};

/**
 * Primo giorno successivo a `v` che non sia domenica né chiuso.
 *
 * Se entro `MAX_SEARCH_DAYS` non trova niente, ignora le chiusure e torna al calcolo
 * semplice: meglio un bot che fissa nel giorno sbagliato che un bot che non fissa più.
 */
function nextBookable(v: Ymd, ranges: BlackoutRange[]): Step {
  let chiusuraScavalcata: Ymd | null = null;
  let candidate = addDays(v, 1);
  for (let i = 0; i < MAX_SEARCH_DAYS; i++) {
    const chiuso = !isBookableDate(isoDate(candidate), ranges);
    if (candidate.wd !== 0 && !chiuso) return { day: candidate, chiusuraScavalcata };
    if (chiuso) chiusuraScavalcata = candidate;
    candidate = addDays(candidate, 1);
  }
  return { day: nextNonSunday(v), chiusuraScavalcata: null };
}

export type BookingDay = { label: string; date: string };

export type BookingDays = {
  day1: BookingDay;
  day2: BookingDay;
  /** day1 è il giorno immediatamente successivo all'ancora: nessun salto per arrivarci. */
  day1Imminente: boolean;
  /** Ultimo giorno chiuso scavalcato PRIMA di day1: siamo dentro la chiusura. */
  chiusuraPrimaDiDay1: BookingDay | null;
  /** Ultimo giorno chiuso scavalcato TRA day1 e day2: la chiusura arriva subito dopo day1. */
  chiusuraDopoDay1: BookingDay | null;
};

const toBookingDay = (v: Ymd): BookingDay => ({ label: labelIt(v), date: isoDate(v) });

/** I due (e soli due) giorni prenotabili a partire da `now`: niente domeniche, niente giorni chiusi. */
export function computeBookingDays(now: Date, ranges?: BlackoutRange[]): BookingDays {
  const chiusure = ranges ?? bookingBlackout(process.env.BOOKING_BLACKOUT);
  let today = romeYmd(now);
  // Dopo le 20:00 l'agenda del giorno corrente non è più prenotabile: entra in
  // vigore quella del giorno successivo. Anticipiamo l'anchor di un giorno.
  if (romeHour(now) >= 20) today = addDays(today, 1);

  const s1 = nextBookable(today, chiusure);
  const s2 = nextBookable(s1.day, chiusure);

  return {
    day1: toBookingDay(s1.day),
    day2: toBookingDay(s2.day),
    day1Imminente: isoDate(s1.day) === isoDate(addDays(today, 1)),
    chiusuraPrimaDiDay1: s1.chiusuraScavalcata ? toBookingDay(s1.chiusuraScavalcata) : null,
    chiusuraDopoDay1: s2.chiusuraScavalcata ? toBookingDay(s2.chiusuraScavalcata) : null,
  };
}

/** Un appuntamento a giorni di distanza ha la giornata intera libera; "domani" no, la mattina è andata. */
const fascia = (imminente: boolean) => (imminente ? 'dalle 15:00 alle 21:00' : 'dalle 09:00 alle 21:00');

const INTESTAZIONE = 'SLOT APPUNTAMENTO DISPONIBILI (la domenica non è mai disponibile, fuso Europe/Rome):';

// Il modello usava questi giorni anche per "correggere" la data di una call che il
// lead aveva già fissato con un collega: a chi diceva "domani alle 17" rispondeva col
// giorno dei propri slot. L'ambito va detto dove stanno i giorni, non solo nel prompt.
const AMBITO =
  'Questi slot valgono SOLO per gli appuntamenti che fissi TU adesso in chat. ' +
  'Se il lead ha già una call fissata, la sua data non si tocca: non correggerlo con questi giorni.';

/** Blocco da iniettare nel prompt: gli unici slot in cui Mario può fissare. */
export function bookingSlotsContext(now: Date): string {
  const { day1, day2, day1Imminente, chiusuraPrimaDiDay1, chiusuraDopoDay1 } = computeBookingDays(now);
  const off = romeOffset(now);
  const tag = `Nel tag [ESITO:APPUNTAMENTO|...] usa la data ISO 8601 del giorno scelto (${day1.date} oppure ${day2.date}) con l'ora concordata e fuso ${off}.`;

  // Forma A — la chiusura si apre subito dopo day1: quel giorno è l'ultimo utile prima dello stop.
  if (chiusuraDopoDay1) {
    return [
      INTESTAZIONE,
      `- ${day1.label}, ${fascia(day1Imminente)} (ultimo slot alle 21:00)`,
      `CHIUSURA: dopo ${day1.label} siamo chiusi fino a ${chiusuraDopoDay1.label} compreso, si riparte ${day2.label}.`,
      `Proponi SOLO ${day1.label}. Se serve dire perché, dì come stanno le cose: dopo quel giorno siamo chiusi per la settimana di ferragosto. È un fatto, non una leva di vendita: dillo semplicemente, senza spingere sulla fretta.`,
      `Solo se il lead dice che non può, proponi ${day2.label}, dalle 09:00 alle 21:00 (ultimo slot alle 21:00).`,
      tag,
      AMBITO,
    ].join('\n');
  }

  // Forma B — siamo dentro la chiusura: si riparte da day1, e il perché si dice.
  if (chiusuraPrimaDiDay1) {
    return [
      INTESTAZIONE,
      `- ${day1.label}, ${fascia(day1Imminente)} (ultimo slot alle 21:00)`,
      `- ${day2.label}, dalle 09:00 alle 21:00 (ultimo slot alle 21:00)`,
      `CHIUSURA: siamo chiusi fino a ${chiusuraPrimaDiDay1.label} compreso, la prima data utile è ${day1.label}. Se il lead chiede una data prima, dì come stanno le cose: siamo fermi per la settimana di ferragosto. È un fatto, non una leva di vendita.`,
      `Puoi fissare l'appuntamento SOLO in uno di questi due giorni e dentro queste fasce orarie. Nessun altro giorno o orario è ammesso.`,
      tag,
      AMBITO,
    ].join('\n');
  }

  // Forma normale — nessuna chiusura in vista: parola per parola com'è sempre stato.
  return [
    INTESTAZIONE,
    `- ${day1.label}, ${fascia(day1Imminente)} (ultimo slot alle 21:00)`,
    `- ${day2.label}, dalle 09:00 alle 21:00 (ultimo slot alle 21:00)`,
    `Puoi fissare l'appuntamento SOLO in uno di questi due giorni e dentro queste fasce orarie. Nessun altro giorno o orario è ammesso.`,
    tag,
    AMBITO,
  ].join('\n');
}
