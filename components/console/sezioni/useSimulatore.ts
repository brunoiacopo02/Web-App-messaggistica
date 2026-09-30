'use client';

import { useEffect, useRef, useState } from 'react';
import { marioDelayMs } from '@/lib/mario-latency';
import { feniceOpening } from '@/lib/fenice-opening';
import { splitMarioMessages } from '@/lib/mario-split';

/**
 * La logica del simulatore di `/fenice` (`Simulator.tsx`), invariata: stessa apertura dal template,
 * stessa finestra di attesa con debounce (`marioDelayMs`), stessi messaggi accorpati in un solo
 * round, stesso buffer per quelli scritti mentre Mario genera, stessa chiamata
 * `POST /api/fenice/sim` con `{ history }`, stesse bolle spezzate sugli a-capo. Cambia solo che
 * ogni turno porta l'orario, perché il thread della console lo mostra.
 *
 * Differenza voluta: l'apertura è lo stato iniziale (lazy) invece di un setState nell'effetto di
 * mount, che la regola `react-hooks/set-state-in-effect` non ammette. L'effetto è lo stesso.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type Turno = { id: number; role: 'user' | 'assistant'; content: string; at: string };
type TurnoModello = { role: 'user' | 'assistant'; content: string };
type RispostaMario = { visibleReply: string; appointmentFixed: boolean; passToHuman: boolean };

let prossimoId = 1;
const turno = (role: Turno['role'], content: string): Turno => ({ id: prossimoId++, role, content, at: new Date().toISOString() });

export function useSimulatore() {
  const [turni, setTurni] = useState<Turno[]>(() => [turno('assistant', feniceOpening())]);
  const [errore, setErrore] = useState<string | null>(null);
  const [appuntamento, setAppuntamento] = useState(false);
  const [passaggio, setPassaggio] = useState(false);
  const [pensa, setPensa] = useState(false);
  const [attesa, setAttesa] = useState<number | null>(null);
  const [inAttesa, setInAttesa] = useState(0);

  const storia = useRef<TurnoModello[] | null>(null);
  if (storia.current === null) storia.current = [{ role: 'assistant', content: turni[0].content }];
  const buffer = useRef<string[]>([]);
  const inVolo = useRef(false);
  const tick = useRef<ReturnType<typeof setInterval> | null>(null);
  const salta = useRef<(() => void) | null>(null);
  const token = useRef(0);

  // Il timer dell'attesa non sopravvive allo smontaggio della pagina.
  useEffect(() => () => {
    if (tick.current) clearInterval(tick.current);
  }, []);

  function fermaAttesa() {
    if (tick.current) {
      clearInterval(tick.current);
      tick.current = null;
    }
    setAttesa(null);
    salta.current = null;
  }

  function avviaAttesa(ms: number, fatto: () => void) {
    let restano = Math.ceil(ms / 1000);
    setAttesa(restano);
    tick.current = setInterval(() => {
      restano -= 1;
      if (restano <= 0) {
        fermaAttesa();
        fatto();
      } else {
        setAttesa(restano);
      }
    }, 1000);
    salta.current = () => {
      fermaAttesa();
      fatto();
    };
  }

  function saltaAttesa() {
    salta.current?.();
  }

  function programma() {
    const mio = ++token.current;
    fermaAttesa();
    avviaAttesa(marioDelayMs(), () => {
      if (token.current === mio) void rispondi();
    });
  }

  async function chiamaMario(history: TurnoModello[]): Promise<RispostaMario | null> {
    setPensa(true);
    setErrore(null);
    try {
      const res = await fetch('/api/fenice/sim', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ history }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error ?? 'Errore');
      return data as RispostaMario;
    } catch (e) {
      setErrore(e instanceof Error ? e.message : 'Errore');
      return null;
    } finally {
      setPensa(false);
    }
  }

  async function aggiungiBolle(testo: string) {
    const parti = splitMarioMessages(testo);
    for (let i = 0; i < parti.length; i++) {
      if (i > 0) {
        setPensa(true);
        await sleep(Math.min(2200, 500 + parti[i].length * 25));
        setPensa(false);
      }
      const t = turno('assistant', parti[i]);
      setTurni((x) => [...x, t]);
    }
  }

  async function rispondi() {
    if (inVolo.current) return;
    inVolo.current = true;
    const data = await chiamaMario(storia.current!);
    if (data) {
      storia.current = [...storia.current!, { role: 'assistant', content: data.visibleReply }];
      await aggiungiBolle(data.visibleReply);
      if (data.appointmentFixed) setAppuntamento(true);
      if (data.passToHuman) setPassaggio(true);
    }
    const rimasti = buffer.current.length;
    if (rimasti > 0) {
      storia.current = [...storia.current!, ...buffer.current.map((c) => ({ role: 'user' as const, content: c }))];
      buffer.current = [];
      setInAttesa(rimasti);
      inVolo.current = false;
      programma();
    } else {
      setInAttesa(0);
      inVolo.current = false;
    }
  }

  /** Un messaggio del lead: compare subito, e (ri)avvia la finestra in cui i messaggi si accorpano. */
  function invia(testo: string): boolean {
    const t = testo.trim();
    if (!t) return false;
    const nuovo = turno('user', t);
    setTurni((x) => [...x, nuovo]);
    setInAttesa((p) => p + 1);
    if (inVolo.current) {
      buffer.current.push(t);
    } else {
      storia.current = [...storia.current!, { role: 'user', content: t }];
      programma();
    }
    return true;
  }

  function ricomincia() {
    fermaAttesa();
    buffer.current = [];
    inVolo.current = false;
    token.current++;
    const apertura = feniceOpening();
    storia.current = [{ role: 'assistant', content: apertura }];
    setTurni([turno('assistant', apertura)]);
    setAppuntamento(false);
    setPassaggio(false);
    setErrore(null);
    setPensa(false);
    setInAttesa(0);
  }

  return { turni, errore, appuntamento, passaggio, pensa, attesa, inAttesa, invia, saltaAttesa, ricomincia };
}
