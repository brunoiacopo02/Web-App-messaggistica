// Latenza "umana" prima di una risposta di Mario. Modulo client-safe (nessun
// import server/SDK) così è usabile sia dal simulatore (client) sia dal webhook.
export const MARIO_MIN_DELAY_MS = 5_000;
export const MARIO_MAX_DELAY_MS = 20_000;

/** Ritorna un ritardo casuale in ms nell'intervallo [5s, 20s]. */
export function marioDelayMs(rand: () => number = Math.random): number {
  const span = MARIO_MAX_DELAY_MS - MARIO_MIN_DELAY_MS;
  return Math.floor(MARIO_MIN_DELAY_MS + rand() * span);
}
