'use client';

import { useSyncExternalStore } from 'react';

/** Ora corrente che avanza ogni 30 s, condivisa da tutta la console: basta per "21:14" / "Ieri" /
 *  la finestra 24h, e non ridisegna le liste a vuoto. */
let oraCorrente = new Date();
function iscriviOra(f: () => void) {
  const id = setInterval(() => {
    oraCorrente = new Date();
    f();
  }, 30_000);
  return () => clearInterval(id);
}

export function useOra(): Date {
  return useSyncExternalStore(iscriviOra, () => oraCorrente, () => oraCorrente);
}
