'use client';

import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react';
import type { Regia } from '@/lib/console/regia';

const OGNI = 30_000;

export type StatoRegia = { regia: Regia | null; errore: boolean };

/** Un solo polling di `/api/console/regia` per tutta la console (barra di regia e sotto-fasi della
 *  Nav). Parte col primo abbonato, si ferma con l'ultimo; a scheda nascosta non interroga e al
 *  ritorno in primo piano rinfresca subito. Stesso schema di `useConteggi`. */
let stato: StatoRegia = { regia: null, errore: false };
const ascoltatori = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let inVolo = false;

function emetti(s: StatoRegia) {
  stato = s;
  for (const f of ascoltatori) f();
}

async function carica() {
  if (inVolo || document.visibilityState !== 'visible') return;
  inVolo = true;
  try {
    const r = await fetch('/api/console/regia', { cache: 'no-store' });
    if (!r.ok) throw new Error(String(r.status));
    emetti({ regia: (await r.json()) as Regia, errore: false });
  } catch {
    // Teniamo l'ultima fotografia buona: meglio numeri di 30 s fa che una barra vuota.
    emetti({ regia: stato.regia, errore: true });
  } finally {
    inVolo = false;
  }
}

function suVisibilita() {
  if (document.visibilityState === 'visible') void carica();
}

function iscrivi(f: () => void) {
  ascoltatori.add(f);
  if (ascoltatori.size === 1) {
    void carica();
    timer = setInterval(() => void carica(), OGNI);
    document.addEventListener('visibilitychange', suVisibilita);
  }
  return () => {
    ascoltatori.delete(f);
    if (ascoltatori.size === 0) {
      if (timer) clearInterval(timer);
      timer = null;
      document.removeEventListener('visibilitychange', suVisibilita);
    }
  };
}

const INIZIALE: StatoRegia = { regia: null, errore: false };

const RegiaCtx = createContext<StatoRegia>(INIZIALE);

export function RegiaProvider({ children }: { children: ReactNode }) {
  const valore = useSyncExternalStore(iscrivi, () => stato, () => INIZIALE);
  return <RegiaCtx.Provider value={valore}>{children}</RegiaCtx.Provider>;
}

export function useRegia(): StatoRegia {
  return useContext(RegiaCtx);
}
