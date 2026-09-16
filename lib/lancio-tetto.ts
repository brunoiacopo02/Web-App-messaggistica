/**
 * Tetto orario dei benvenuti del lancio (spec §11.3).
 *
 * Il 15/09/2026 il numero del bot ha incassato 7.882 intake in un giorno ed e' uscito a
 * qualita' LOW. Il benvenuto del lancio parte in tempo reale dentro `enrollLancio`: una
 * campagna che spinge forte per un'ora rifarebbe lo stesso picco "a forma di blast", e
 * il rischio non e' il limite numerico di Meta ma la QUALITA' del numero, che si calcola
 * su 7 giorni e si perde in un pomeriggio.
 *
 * Quindi: oltre `LANCIO_WELCOME_MAX_PER_HOUR` benvenuti nell'ultima ora, il lead viene
 * comunque preso in carico e il benvenuto DIFFERITO, esattamente come col lancio spento.
 * Nessun lead si perde: lo riprende il cron `/api/cron/lancio-aperture`, che rispetta lo
 * stesso tetto e spalma la coda sui run successivi.
 *
 * Modulo PURO: niente env, niente DB, niente rete. Chi chiama legge e agisce.
 */

/** Default della spec: 200 benvenuti/ora. E' un tetto sul RITMO, non sul totale. */
export const TETTO_ORARIO_BENVENUTI_DEFAULT = 200;

/** La finestra su cui si conta: i 60 minuti appena passati, scorrevoli. */
export const FINESTRA_TETTO_MS = 60 * 60 * 1000;

/**
 * Il tetto dall'env, con lo stesso parsing di `LANCIO_APERTURE_MAX_PER_RUN`:
 * valore illeggibile (o assente, o zero) → default; valore negativo → 1, perche' un
 * tetto a zero spegnerebbe i benvenuti per sempre e per quello c'e' gia'
 * `lancio_attivo`, che e' un interruttore visibile dal pannello.
 */
export function leggiTettoOrario(raw: string | undefined | null): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n === 0) return TETTO_ORARIO_BENVENUTI_DEFAULT;
  return Math.max(1, Math.floor(n));
}

/**
 * C'e' ancora spazio sotto il tetto?
 *
 * Il confronto e' `<`: al pari (`inviatiUltimaOra === cap`) si e' gia' fuori, cosi' il
 * cap e' il numero massimo di benvenuti in un'ora e non quello che li fa diventare uno
 * di piu'.
 */
export function sottoTettoOrario(i: { inviatiUltimaOra: number; cap: number }): boolean {
  return i.inviatiUltimaOra < i.cap;
}
