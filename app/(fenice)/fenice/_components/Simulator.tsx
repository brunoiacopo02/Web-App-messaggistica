'use client';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { marioDelayMs } from '@/lib/mario-latency';
import { feniceOpening } from '@/lib/fenice-opening';

type Turn = { role: 'user' | 'assistant'; content: string };
type MarioResult = { visibleReply: string; appointmentFixed: boolean; passToHuman: boolean };

export function Simulator() {
  const [turns, setTurns] = useState<Turn[]>([]); // solo per il render
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [appointment, setAppointment] = useState(false);
  const [handoff, setHandoff] = useState(false);
  const [thinking, setThinking] = useState(false); // chiamata API in corso
  const [countdown, setCountdown] = useState<number | null>(null); // secondi all'attesa
  const [pending, setPending] = useState(0); // messaggi lead non ancora risposti

  const modelHistory = useRef<Turn[]>([]); // cronologia logica passata all'API
  const buffer = useRef<string[]>([]);     // messaggi digitati MENTRE Mario genera
  const inFlight = useRef(false);
  const started = useRef(false);
  const tick = useRef<ReturnType<typeof setInterval> | null>(null);
  const skipResolve = useRef<(() => void) | null>(null);
  const scheduleToken = useRef(0);
  const bottomRef = useRef<HTMLDivElement>(null);

  function clearCountdown() {
    if (tick.current) {
      clearInterval(tick.current);
      tick.current = null;
    }
    setCountdown(null);
    skipResolve.current = null;
  }

  // Attesa con countdown visibile e bottone "salta attesa".
  function startCountdown(ms: number, onDone: () => void) {
    let remaining = Math.ceil(ms / 1000);
    setCountdown(remaining);
    tick.current = setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        clearCountdown();
        onDone();
      } else {
        setCountdown(remaining);
      }
    }, 1000);
    skipResolve.current = () => {
      clearCountdown();
      onDone();
    };
  }

  function skip() {
    skipResolve.current?.();
  }

  // Debounce: (ri)avvia la finestra di attesa; al termine accorpa e risponde.
  function scheduleReply() {
    const myToken = ++scheduleToken.current;
    clearCountdown();
    startCountdown(marioDelayMs(), () => {
      if (scheduleToken.current === myToken) void fireReply();
    });
  }

  async function callMario(history: Turn[]): Promise<MarioResult | null> {
    setThinking(true);
    setError(null);
    try {
      const res = await fetch('/api/fenice/sim', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ history }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error ?? 'Errore');
      return data as MarioResult;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Errore');
      return null;
    } finally {
      setThinking(false);
    }
  }

  function applyFlags(data: MarioResult) {
    if (data.appointmentFixed) setAppointment(true);
    if (data.passToHuman) setHandoff(true);
  }

  // Una risposta sola a tutti i messaggi accumulati. Se durante la generazione il lead
  // ne manda altri, finiscono nel buffer e fanno scattare un altro round.
  async function fireReply() {
    if (inFlight.current) return;
    inFlight.current = true;
    const data = await callMario(modelHistory.current);
    if (data) {
      modelHistory.current = [...modelHistory.current, { role: 'assistant', content: data.visibleReply }];
      setTurns((t) => [...t, { role: 'assistant', content: data.visibleReply }]);
      applyFlags(data);
    }
    const remaining = buffer.current.length;
    if (remaining > 0) {
      modelHistory.current = [
        ...modelHistory.current,
        ...buffer.current.map((c) => ({ role: 'user' as const, content: c })),
      ];
      buffer.current = [];
      setPending(remaining);
      inFlight.current = false;
      scheduleReply();
    } else {
      setPending(0);
      inFlight.current = false;
    }
  }

  // L'apertura è il testo del template (come lo riceve il lead reale): nessuna
  // generazione separata, così non c'è ridondanza con la presentazione dello script.
  function openConversation() {
    const opening = feniceOpening();
    modelHistory.current = [{ role: 'assistant', content: opening }];
    setTurns([{ role: 'assistant', content: opening }]);
  }

  // Apertura di Mario al primo mount (senza latenza).
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    openConversation();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [turns, thinking, countdown]);

  function send() {
    const text = input.trim();
    if (!text) return; // input MAI disabilitato: il lead può mandarne più di fila
    setTurns((t) => [...t, { role: 'user', content: text }]); // mostra subito il messaggio
    setPending((p) => p + 1);
    if (inFlight.current) {
      buffer.current.push(text); // arrivato mentre Mario genera: round successivo
    } else {
      modelHistory.current = [...modelHistory.current, { role: 'user', content: text }];
      scheduleReply(); // (ri)avvia la finestra: i messaggi della finestra vengono accorpati
    }
    setInput('');
  }

  function reset() {
    clearCountdown();
    buffer.current = [];
    modelHistory.current = [];
    inFlight.current = false;
    scheduleToken.current++;
    setTurns([]);
    setAppointment(false);
    setHandoff(false);
    setError(null);
    setThinking(false);
    setPending(0);
    started.current = true;
    openConversation();
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3">
        {turns.map((t, i) => (
          <div key={i} className={cn('flex', t.role === 'user' ? 'justify-end' : 'justify-start')}>
            <div
              className={cn(
                'max-w-[75%] rounded-2xl px-4 py-2 text-sm whitespace-pre-wrap',
                t.role === 'user' ? 'bg-emerald-600 text-white' : 'bg-zinc-100 dark:bg-zinc-800',
              )}
            >
              {t.content}
            </div>
          </div>
        ))}
        {countdown !== null && (
          <div className="flex items-center gap-2 text-xs text-zinc-400">
            <span>Mario risponde tra {countdown}s…</span>
            <button type="button" onClick={skip} className="underline hover:text-zinc-600 dark:hover:text-zinc-200">
              salta attesa
            </button>
          </div>
        )}
        {thinking && countdown === null && <div className="text-xs text-zinc-400">Mario sta scrivendo…</div>}
        {error && <div className="text-sm text-red-600">{error}</div>}
        <div ref={bottomRef} />
      </div>

      <div className="border-t px-6 py-3 space-y-2">
        <div className="flex gap-2">
          {appointment && <Badge className="bg-emerald-600">✅ Appuntamento fissato</Badge>}
          {handoff && <Badge variant="destructive">🔔 Passaggio a operatore</Badge>}
          {pending > 0 && <Badge variant="secondary">{pending} in attesa</Badge>}
        </div>
        <div className="flex gap-2">
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            placeholder="Scrivi come lead… (puoi mandarne più di fila)"
          />
          <Button onClick={send} disabled={!input.trim()}>
            Invia
          </Button>
          <Button variant="outline" onClick={reset}>
            Reset
          </Button>
        </div>
      </div>
    </div>
  );
}
