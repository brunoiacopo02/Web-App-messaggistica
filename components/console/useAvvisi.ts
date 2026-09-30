'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AvvisoConsole } from '@/lib/console/avvisi';

/** Avvisi e registro: polling a 30 s (brief Task 11), solo con la scheda del browser in primo piano. */
export const OGNI_AVVISI = 30_000;

type Lettura<T> = { dati: T | null; errore: boolean; aggiornatoAt: string | null };

/** Lettura a polling di un endpoint JSON della console. Un giro fallito non svuota i dati già
 *  in pagina: segna solo `errore`, e il giro dopo ci riprova. */
function usePolling<T>(url: string, estrai: (j: unknown) => T): Lettura<T> & { rileggi: () => Promise<void> } {
  const [stato, setStato] = useState<Lettura<T>>({ dati: null, errore: false, aggiornatoAt: null });
  const seq = useRef(0);
  const estraiRef = useRef(estrai);
  useEffect(() => {
    estraiRef.current = estrai;
  });

  const rileggi = useCallback(async () => {
    const n = ++seq.current;
    try {
      const r = await fetch(url, { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const dati = estraiRef.current(await r.json());
      if (n !== seq.current) return;
      setStato({ dati, errore: false, aggiornatoAt: new Date().toISOString() });
    } catch {
      if (n !== seq.current) return;
      setStato((s) => ({ ...s, errore: true }));
    }
  }, [url]);

  useEffect(() => {
    void rileggi();
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') void rileggi();
    }, OGNI_AVVISI);
    return () => clearInterval(id);
  }, [rileggi]);

  return { ...stato, rileggi };
}

export function useAvvisi() {
  return usePolling<AvvisoConsole[]>('/api/console/avvisi', (j) => (j as { avvisi?: AvvisoConsole[] }).avvisi ?? []);
}

export type RigaRegistro = {
  id: number;
  created_at: string;
  level: string | null;
  message: string | null;
  payload: {
    azione?: string;
    params?: Record<string, unknown>;
    esito?: { ok?: boolean; fatti?: number; falliti?: number; messaggio?: string };
    by?: string;
  } | null;
};

export function useRegistro() {
  return usePolling<RigaRegistro[]>('/api/console/azioni/registro', (j) => (j as { azioni?: RigaRegistro[] }).azioni ?? []);
}
