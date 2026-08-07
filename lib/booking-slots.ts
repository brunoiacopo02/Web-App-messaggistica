import { romeOffset, romeHour } from './rome-time';

// Calcolo degli unici due giorni in cui Mario può fissare l'appuntamento:
// "il giorno dopo" e "il giorno dopo ancora", saltando SEMPRE la domenica.
// Es. da venerdì → sabato e lunedì; da sabato → lunedì e martedì.

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

export type BookingDay = { label: string; date: string };

/** I due (e soli due) giorni prenotabili a partire da `now`, domenica esclusa. */
export function computeBookingDays(now: Date): { day1: BookingDay; day2: BookingDay } {
  let today = romeYmd(now);
  // Dopo le 20:00 l'agenda del giorno corrente non è più prenotabile: entra in
  // vigore quella del giorno successivo. Anticipiamo l'anchor di un giorno.
  if (romeHour(now) >= 20) today = addDays(today, 1);
  const d1 = nextNonSunday(today);
  const d2 = nextNonSunday(d1);
  return {
    day1: { label: labelIt(d1), date: isoDate(d1) },
    day2: { label: labelIt(d2), date: isoDate(d2) },
  };
}

/** Blocco da iniettare nel prompt: gli unici slot in cui Mario può fissare.
 *  I giorni si propongono UNO ALLA VOLTA, partendo dal primo: l'attesa mediana fra
 *  fissaggio e call è 44 ore e il 39% supera le 48h — più la call è lontana, più
 *  l'imprevisto di lavoro se la mangia (28% dei motivi di disdetta). */
export function bookingSlotsContext(now: Date): string {
  const { day1, day2 } = computeBookingDays(now);
  const off = romeOffset(now);
  return [
    'SLOT APPUNTAMENTO DISPONIBILI (la domenica non è mai disponibile, fuso Europe/Rome):',
    `- PROPONI SEMPRE PRIMA questo: ${day1.label}, dalle 15:00 alle 21:00 (ultimo slot alle 21:00)`,
    `- SOLO se il lead proprio non riesce nel giorno sopra: ${day2.label}, dalle 09:00 alle 21:00 (ultimo slot alle 21:00)`,
    `Proponi UN GIORNO ALLA VOLTA: parti da ${day1.label} e non nominare l'altro. Il secondo giorno esiste solo dopo che il lead ti ha detto che il primo non gli va bene, e prima di passarci prova a trovargli un orario dentro il primo. Più è vicina la call, meno probabilità c'è che gli capiti un imprevisto e la salti.`,
    `Puoi fissare l'appuntamento SOLO in uno di questi due giorni e dentro queste fasce orarie. Nessun altro giorno o orario è ammesso.`,
    `Nel tag [ESITO:APPUNTAMENTO|...] usa la data ISO 8601 del giorno scelto (${day1.date} oppure ${day2.date}) con l'ora concordata e fuso ${off}.`,
  ].join('\n');
}
