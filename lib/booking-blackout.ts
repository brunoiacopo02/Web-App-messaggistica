// Giorni in cui Fenice non fa appuntamenti: il bot non deve proporli.
//
// 07/08/2026 — Fenice Academy accetta appuntamenti fino a lunedì 10 agosto compreso,
// poi non c'è nessuno fino a lunedì 17: si riparte martedì 18. Senza questo blocco
// `computeBookingDays` proporrebbe "domani e dopodomani" per tutta la settimana chiusa,
// fissando call a cui non si presenta nessuno da parte nostra.

/** Intervallo di giorni chiusi, date ISO `YYYY-MM-DD`, estremi INCLUSI. */
export type BlackoutRange = { from: string; to: string };

/** Vale se `BOOKING_BLACKOUT` non è impostata: la chiusura funziona anche senza config. */
export const BLACKOUT_DEFAULT: BlackoutRange[] = [{ from: '2026-08-11', to: '2026-08-17' }];

/** True solo per una data ISO esistente davvero (2026-02-30 e 2026-13-45 sono false). */
function isRealIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/**
 * Parsa `2026-08-11:2026-08-17,2026-12-24:2026-12-26`.
 *
 * - `undefined` → `null`: nessuna configurazione, decide il chiamante.
 * - stringa vuota → `[]`: blocco disattivato di proposito, senza toccare il codice.
 * - qualunque sporcizia (anche in un solo intervallo) → `null`: una env scritta male non
 *   deve valere come "nessuna chiusura", perché il bot tornerebbe a fissare nel vuoto.
 */
export function parseBlackout(raw: string | undefined): BlackoutRange[] | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (!trimmed) return [];

  const ranges: BlackoutRange[] = [];
  for (const chunk of trimmed.split(',')) {
    const [from, to, ...rest] = chunk.trim().split(':');
    if (rest.length > 0) return null;
    if (!from || !to) return null;
    if (!isRealIsoDate(from) || !isRealIsoDate(to)) return null;
    if (from > to) return null;
    ranges.push({ from, to });
  }
  return ranges;
}

/** Gli intervalli in vigore: l'env se è scritta bene, altrimenti il default. */
export function bookingBlackout(env: string | undefined): BlackoutRange[] {
  return parseBlackout(env) ?? BLACKOUT_DEFAULT;
}

/** True se la data ISO NON cade in nessun intervallo chiuso (confronto lessicografico:
 * sull'ISO 8601 coincide con quello cronologico). */
export function isBookableDate(isoDate: string, ranges: BlackoutRange[]): boolean {
  return !ranges.some((r) => isoDate >= r.from && isoDate <= r.to);
}
