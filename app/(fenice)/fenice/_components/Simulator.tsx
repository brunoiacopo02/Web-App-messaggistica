'use client';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

type Turn = { role: 'user' | 'assistant'; content: string };

export function Simulator() {
  const [history, setHistory] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [appointment, setAppointment] = useState(false);
  const [handoff, setHandoff] = useState(false);
  const started = useRef(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  async function ask(next: Turn[]) {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/fenice/sim', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ history: next }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error ?? 'Errore');
      setHistory([...next, { role: 'assistant', content: data.visibleReply }]);
      if (data.appointmentFixed) setAppointment(true);
      if (data.passToHuman) setHandoff(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Errore');
    } finally {
      setLoading(false);
    }
  }

  // Apertura di Mario al primo mount
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void ask([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [history, loading]);

  function send() {
    const text = input.trim();
    if (!text || loading) return;
    const next = [...history, { role: 'user' as const, content: text }];
    setHistory(next);
    setInput('');
    void ask(next);
  }

  function reset() {
    setHistory([]); setAppointment(false); setHandoff(false); setError(null);
    started.current = true;
    void ask([]);
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3">
        {history.map((t, i) => (
          <div key={i} className={cn('flex', t.role === 'user' ? 'justify-end' : 'justify-start')}>
            <div className={cn(
              'max-w-[75%] rounded-2xl px-4 py-2 text-sm whitespace-pre-wrap',
              t.role === 'user' ? 'bg-emerald-600 text-white' : 'bg-zinc-100 dark:bg-zinc-800',
            )}>
              {t.content}
            </div>
          </div>
        ))}
        {loading && <div className="text-xs text-zinc-400">Mario sta scrivendo…</div>}
        {error && <div className="text-sm text-red-600">{error}</div>}
        <div ref={bottomRef} />
      </div>

      <div className="border-t px-6 py-3 space-y-2">
        <div className="flex gap-2">
          {appointment && <Badge className="bg-emerald-600">✅ Appuntamento fissato</Badge>}
          {handoff && <Badge variant="destructive">🔔 Passaggio a operatore</Badge>}
        </div>
        <div className="flex gap-2">
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
            placeholder="Scrivi come lead…"
            disabled={loading}
          />
          <Button onClick={send} disabled={loading || !input.trim()}>Invia</Button>
          <Button variant="outline" onClick={reset} disabled={loading}>Reset</Button>
        </div>
      </div>
    </div>
  );
}
