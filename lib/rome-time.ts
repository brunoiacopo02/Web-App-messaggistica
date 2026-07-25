/** Offset corrente di Europe/Rome per `date`, es. "+02:00" (DST) o "+01:00". */
export function romeOffset(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Rome',
    timeZoneName: 'longOffset',
  }).formatToParts(date);
  const raw = parts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT+01:00';
  const off = raw.replace('GMT', '').trim();
  return off === '' ? '+00:00' : off;
}

/** Ora locale (0–23) di `date` nel fuso Europe/Rome. */
export function romeHour(date: Date): number {
  const h = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Rome',
    hour: '2-digit',
    hourCycle: 'h23',
  }).format(date);
  return parseInt(h, 10);
}

/** Riga di contesto da iniettare nel prompt così Mario risolve date relative. */
export function romeNowContext(date: Date): string {
  const f = new Intl.DateTimeFormat('it-IT', {
    timeZone: 'Europe/Rome',
    weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  }).format(date);
  return `Adesso in Italia è ${f} (fuso ${romeOffset(date)}). Usa questo per calcolare date assolute.`;
}

const romeDateFmt = new Intl.DateTimeFormat('it-IT', {
  timeZone: 'Europe/Rome', weekday: 'long', day: 'numeric', month: 'long',
});
const romeHourFmt = new Intl.DateTimeFormat('it-IT', {
  timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

/**
 * Data/ora leggibile in Europe/Rome per chi legge le note CRM, es. "venerdì 1 agosto
 * alle 15:00". Un timestamptz di Postgres arriva già normalizzato in UTC: senza questa
 * conversione chi telefona leggerebbe l'orario sbagliato (es. le 13:00 UTC per una call
 * fissata alle 15:00 italiane). Su un ISO non parsabile ritorna la stringa originale
 * invece di esplodere: meglio un dato grezzo che un errore in una nota CRM.
 */
export function formatRomeDateTime(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  const d = new Date(ms);
  return `${romeDateFmt.format(d)} alle ${romeHourFmt.format(d)}`;
}

/**
 * Stesso istante, indipendentemente dal fuso con cui le due stringhe ISO sono scritte:
 * una timestamptz Postgres (round-trip in UTC) e un tag del modello (fuso locale
 * imposto dal prompt) rappresentano spesso lo stesso momento con offset diversi, quindi
 * un confronto testuale fallisce sempre. Non parsabile ⇒ false (mai un falso "uguale").
 */
export function sameInstant(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return false;
  return ta === tb;
}
