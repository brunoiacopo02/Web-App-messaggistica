'use client';

import { useSyncExternalStore } from 'react';
import type { Vista } from '@/lib/console/viste';

const OGNI = 10_000;

export type StatoConteggi = { conteggi: Record<Vista, number> | null; errore: boolean };

/** Un solo polling per tutta la console: Nav e intestazione della lista leggono lo stesso store,
 *  così i contatori non raddoppiano le richieste. Parte col primo abbonato, si ferma con l'ultimo;
 *  con la scheda nascosta non interroga, e al ritorno in primo piano rinfresca subito. */
let stato: StatoConteggi = { conteggi: null, errore: false };
const ascoltatori = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let inVolo = false;

function emetti(s: StatoConteggi) {
  stato = s;
  for (const f of ascoltatori) f();
}

async function carica() {
  if (inVolo || document.visibilityState !== 'visible') return;
  inVolo = true;
  try {
    const r = await fetch('/api/console/viste', { cache: 'no-store' });
    if (!r.ok) throw new Error(String(r.status));
    const j = (await r.json()) as { conteggi: Record<Vista, number> };
    emetti({ conteggi: j.conteggi, errore: false });
  } catch {
    // Teniamo gli ultimi numeri buoni: meglio un contatore di 10 s fa che uno vuoto.
    emetti({ conteggi: stato.conteggi, errore: true });
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

const INIZIALE: StatoConteggi = { conteggi: null, errore: false };

export function useConteggi(): StatoConteggi {
  return useSyncExternalStore(iscrivi, () => stato, () => INIZIALE);
}

/** Rinfresca i contatori fuori ciclo (es. appena arriva un messaggio). */
export function rinfrescaConteggi() {
  void carica();
}
