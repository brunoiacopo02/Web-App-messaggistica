'use client';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { marioDelayMs } from '@/lib/mario-latency';

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
  const [pending, setPending] = useState(0); // messaggi lead in coda non ancora gestiti

  const modelHistory = useRef<Turn[]>([]); // cronologia logica passata all'API (incrementale)
  const queue = useRef<string[]>([]);      // messaggi lead in attesa di risposta
  const processing = useRef(false);
  const started = useRef(false);
  const skipResolve = useRef<(() => void) | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Attesa 5-40s con countdown visibile e possibilità di saltarla.
  function delayWithCountdown(): Promise<void> {
    const ms = marioDelayMs();
    return new Promise<void>((resolve) => {
      let remaining = Math.ceil(ms / 1000);
      setCountdown(remaining);
      const cleanup = () => {
        clearInterval(tick);
        setCountdown(null);
        skipResolve.current = null;
      };
      const tick = setInterval(() => {
        remaining -= 1;
        if (remaining <= 0) {
          cleanup();
          resolve();
        } else {
          setCountdown(remaining);
        }
      }, 1000);
      skipResolve.current = () => {
        cleanup();
        resolve();
      };
    });
  }

  function skip() {
    skipResolve.current?.();
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

  // Processa la coda un messaggio alla volta: ogni messaggio del lead riceve la
  // sua risposta, in ordine, dopo l'attesa. Niente sovrapposizioni / impallamenti.
  async function runProcessor() {
    if (processing.current) return;
    processing.current = true;
    while (queue.current.length > 0) {
      const text = queue.current.shift()!;
      modelHistory.current = [...modelHistory.current, { role: 'user', content: text }];
      await delayWithCountdown();
      const data = await callMario(modelHistory.current);
      setPending((p) => Math.max(0, p - 1));
      if (!data) {
        // errore: interrompo, lo stato resta per ritentare
        processing.current = false;
        return;
      }
      modelHistory.current = [...modelHistory.current, { role: 'assistant', content: data.visibleReply }];
      setTurns((t) => [...t, { role: 'assistant', content: data.visibleReply }]);
      applyFlags(data);
    }
    processing.current = false;
  }

  async function openConversation() {
    const data = await callMario([]);
    if (data) {
      modelHistory.current = [{ role: 'assistant', content: data.visibleReply }];
      setTurns([{ role: 'assistant', content: data.visibleReply }]);
      applyFlags(data);
    }
  }

  // Apertura di Mario al primo mount (senza latenza).
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void openConversation();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [turns, thinking, countdown]);

  function send() {
    const text = input.trim();
    if (!text) return; // input MAI disabilitato: il lead può mandarne più di fila
    setTurns((t) => [...t, { role: 'user', content: text }]); // mostra subito il messaggio
    queue.current.push(text);
    setPending((p) => p + 1);
    setInput('');
    void runProcessor();
  }

  function reset() {
    queue.current = [];
    modelHistory.current = [];
    processing.current = false;
    skipResolve.current = null;
    setTurns([]);
    setAppointment(false);
    setHandoff(false);
    setError(null);
    setCountdown(null);
    setThinking(false);
    setPending(0);
    started.current = true;
    void openConversation();
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
          {pending > 0 && <Badge variant="secondary">{pending} in coda</Badge>}
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
