'use client';

import { useSyncExternalStore } from 'react';

export type Tema = 'dark' | 'light';

const CHIAVE = 'console-tema';
const listeners = new Set<() => void>();

function leggiTema(): Tema {
  try {
    const salvato = localStorage.getItem(CHIAVE);
    return salvato === 'dark' || salvato === 'light' ? salvato : 'dark';
  } catch {
    /* localStorage non disponibile (privacy mode, quota, ecc.): resta il default scuro */
    return 'dark';
  }
}

function sottoscrivi(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshotServer(): Tema {
  return 'dark';
}

/** Tema della console: parte scuro, ricorda la scelta in localStorage e resta
 *  sincronizzato fra tutti gli usi (esterno a React, letto con useSyncExternalStore
 *  così da non dover impostare lo stato dentro un effetto). Non deve mai lanciare. */
export function useTema(): [Tema, (t: Tema) => void] {
  const tema = useSyncExternalStore(sottoscrivi, leggiTema, snapshotServer);

  const setTema = (t: Tema) => {
    try {
      localStorage.setItem(CHIAVE, t);
    } catch {
      /* localStorage non disponibile: gli ascoltatori vengono comunque avvisati */
    }
    listeners.forEach((listener) => listener());
  };

  return [tema, setTema];
}

/** Bottone che alterna chiaro/scuro. Lo Shell riflette il cambio su [data-console]. */
export function TemaToggle() {
  const [tema, setTema] = useTema();

  return (
    <button
      type="button"
      className="btn ghost"
      onClick={() => setTema(tema === 'dark' ? 'light' : 'dark')}
      aria-label="Cambia tema"
    >
      {tema === 'dark' ? 'Tema chiaro' : 'Tema scuro'}
    </button>
  );
}
