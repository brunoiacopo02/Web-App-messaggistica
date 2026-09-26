'use client';

import { useSyncExternalStore } from 'react';

/** Ora corrente che avanza ogni 30 s, condivisa da tutta la console: basta per "21:14" / "Ieri" /
 *  la finestra 24h, e non ridisegna le liste a vuoto. */
const PASSO = 30_000;
let oraCorrente = new Date();
function iscriviOra(f: () => void) {
  // Store di modulo: se nessuno era iscritto l'ora può essere ferma da minuti. Chi si iscrive la
  // riallinea; React rilegge lo snapshot dopo la subscribe e ridisegna se è cambiato.
  if (Date.now() - oraCorrente.getTime() >= PASSO) oraCorrente = new Date();
  const id = setInterval(() => {
    oraCorrente = new Date();
    f();
  }, PASSO);
  return () => clearInterval(id);
}

export function useOra(): Date {
  return useSyncExternalStore(iscriviOra, () => oraCorrente, () => oraCorrente);
}
