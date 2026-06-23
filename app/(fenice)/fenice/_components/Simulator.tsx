'use client';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Flame, RotateCcw } from 'lucide-react';
import { StatusPill } from '@/components/fenice/status';
import { cn } from '@/lib/utils';
import { marioDelayMs } from '@/lib/mario-latency';
import { feniceOpening } from '@/lib/fenice-opening';
import { splitMarioMessages } from '@/lib/mario-split';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Risposte tipiche di un lead: scorciatoie per testare il flusso di Mario senza digitare.
const PRESET_REPLIES = ['Sì, sono interessato', 'Quanto costa?', 'Come funziona?', 'Non ora, grazie'];

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

  // Mostra la risposta come messaggi separati (ogni a-capo = nuova bolla), con breve
  // pausa e "sta scrivendo" tra l'uno e l'altro: sembra una persona che scrive a raffica.
  async function appendAssistantChunks(text: string) {
    const parts = splitMarioMessages(text);
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) {
        setThinking(true);
        await sleep(Math.min(2200, 500 + parts[i].length * 25));
        setThinking(false);
      }
      const content = parts[i];
      setTurns((t) => [...t, { role: 'assistant', content }]);
    }
  }

  // Una risposta sola a tutti i messaggi accumulati. Se durante la generazione il lead
  // ne manda altri, finiscono nel buffer e fanno scattare un altro round.
  async function fireReply() {
    if (inFlight.current) return;
    inFlight.current = true;
    const data = await callMario(modelHistory.current);
    if (data) {
      modelHistory.current = [...modelHistory.current, { role: 'assistant', content: data.visibleReply }];
      await appendAssistantChunks(data.visibleReply);
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

  function send(preset?: string) {
    const text = (preset ?? input).trim();
    if (!text) return; // input MAI disabilitato: il lead può mandarne più di fila
    setTurns((t) => [...t, { role: 'user', content: text }]); // mostra subito il messaggio
    setPending((p) => p + 1);
    if (inFlight.current) {
      buffer.current.push(text); // arrivato mentre Mario genera: round successivo
    } else {
      modelHistory.current = [...modelHistory.current, { role: 'user', content: text }];
      scheduleReply(); // (ri)avvia la finestra: i messaggi della finestra vengono accorpati
    }
    if (!preset) setInput('');
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
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex-1 overflow-y-auto px-4 py-6 md:px-6">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-3">
          <div className="mb-1 flex items-center gap-2 self-center rounded-full border border-border/70 bg-card/60 px-3 py-1 text-xs text-muted-foreground">
            <span className="size-1.5 rounded-full bg-brand" />
            Stai impersonando il lead — Mario è l’assistente
          </div>

          {turns.map((t, i) => (
            <div key={i} className={cn('flex gap-2', t.role === 'user' ? 'justify-end' : 'justify-start')}>
              {t.role === 'assistant' && (
                <span className="mt-auto grid size-7 shrink-0 place-items-center rounded-lg bg-brand/12 text-brand">
                  <Flame className="size-3.5" />
                </span>
              )}
              <div
                className={cn(
                  'max-w-[78%] whitespace-pre-wrap rounded-2xl px-4 py-2 text-sm shadow-sm',
                  t.role === 'user'
                    ? 'rounded-br-sm bg-brand text-brand-foreground'
                    : 'rounded-bl-sm border border-border/70 bg-card',
                )}
              >
                {t.content}
              </div>
            </div>
          ))}

          {countdown !== null && (
            <div className="flex items-center gap-2 self-start rounded-full bg-muted px-3 py-1 text-xs text-muted-foreground">
              <span>Mario risponde tra {countdown}s</span>
              <button
                type="button"
                onClick={skip}
                className="font-medium text-brand underline-offset-2 hover:underline"
              >
                salta attesa
              </button>
            </div>
          )}
          {thinking && countdown === null && <TypingDots />}
          {error && (
            <div className="self-start rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-600 dark:text-rose-300">
              {error}
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      <div className="border-t border-border/70 bg-card/50 px-4 py-3 md:px-6">
        <div className="mx-auto w-full max-w-3xl space-y-2">
          {(appointment || handoff || pending > 0) && (
            <div className="flex flex-wrap gap-2">
              {appointment && <StatusPill label="Appuntamento fissato" tone="emerald" />}
              {handoff && <StatusPill label="Passaggio a operatore" tone="rose" />}
              {pending > 0 && <StatusPill label={`${pending} in attesa`} tone="ember" />}
            </div>
          )}
          <div className="flex flex-wrap gap-1.5">
            {PRESET_REPLIES.map((preset) => (
              <button
                key={preset}
                type="button"
                onClick={() => send(preset)}
                className="rounded-full border border-border/70 bg-card px-3 py-1 text-xs text-muted-foreground transition-colors hover:border-brand/40 hover:text-brand"
              >
                {preset}
              </button>
            ))}
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
              className="h-10 rounded-xl"
            />
            <Button onClick={() => send()} disabled={!input.trim()} className="h-10 rounded-xl">
              Invia
            </Button>
            <Button variant="outline" onClick={reset} className="h-10 rounded-xl" title="Ricomincia da capo">
              <RotateCcw className="size-4" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function TypingDots() {
  return (
    <div className="flex items-center gap-2 self-start">
      <span className="grid size-7 place-items-center rounded-lg bg-brand/12 text-brand">
        <Flame className="size-3.5" />
      </span>
      <div className="flex items-center gap-1 rounded-2xl rounded-bl-sm border border-border/70 bg-card px-3 py-2.5">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="size-1.5 rounded-full bg-muted-foreground/60 fenice-pulse"
            style={{ animationDelay: `${i * 0.18}s` }}
          />
        ))}
      </div>
    </div>
  );
}
