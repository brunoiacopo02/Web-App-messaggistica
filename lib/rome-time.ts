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
