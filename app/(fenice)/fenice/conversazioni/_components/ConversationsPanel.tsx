'use client';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { RefreshCw, Sparkles, MessageSquare } from 'lucide-react';

type Row = {
  id: number;
  status: string | null;
  phone: string;
  name: string;
  lastMessageAt: string;
  hasSummary: boolean;
};

type Msg = { id: number; direction: 'in' | 'out'; body: string; created_at: string; is_template: boolean };

type Detail = {
  lead: { phone: string; firstName: string; lastName: string; email: string };
  report: { status: string | null; startedAt: string | null; lastMessageAt: string; inbound: number; outbound: number; total: number };
  summary: string | null;
  summaryAt: string | null;
  messages: Msg[];
};

function StatusBadge({ status }: { status: string | null }) {
  if (status === 'booked') return <Badge className="bg-emerald-600">appuntamento</Badge>;
  if (status === 'handed_off') return <Badge variant="destructive">a operatore</Badge>;
  return <Badge variant="secondary">attivo</Badge>;
}

function fmt(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('it-IT', {
      day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return '—';
  }
}

export function ConversationsPanel({ rows }: { rows: Row[] }) {
  const searchParams = useSearchParams();
  const urlId = Number(searchParams.get('id'));
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<number | null>(
    Number.isFinite(urlId) && urlId > 0 ? urlId : (rows[0]?.id ?? null)
  );
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(false);
  const [summarizing, setSummarizing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const filtered = rows.filter((r) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return r.name.toLowerCase().includes(q) || r.phone.toLowerCase().includes(q);
  });

  async function load(id: number) {
    setLoading(true); setError(null); setDetail(null);
    try {
      const res = await fetch(`/api/fenice/conversation?id=${id}`);
      const data = await res.json();
      if (!data.ok) throw new Error(data.error ?? 'Errore');
      setDetail(data as Detail);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Errore');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (selected != null) load(selected);
  }, [selected]);

  async function summarize() {
    if (selected == null || summarizing) return;
    setSummarizing(true); setError(null);
    try {
      const res = await fetch('/api/fenice/conversation', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conversationId: selected }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error ?? 'Errore');
      setDetail((d) => (d ? { ...d, summary: data.summary, summaryAt: data.summaryAt } : d));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Errore');
    } finally {
      setSummarizing(false);
    }
  }

  return (
    <div className="flex h-full">
      {/* Lista lead */}
      <div className="w-72 shrink-0 border-r flex flex-col">
        <div className="p-3 border-b">
          <Input placeholder="Cerca nome o numero…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <div className="flex-1 overflow-y-auto">
          {filtered.length === 0 && (
            <div className="p-4 text-sm text-zinc-400">Nessun lead.</div>
          )}
          {filtered.map((r) => (
            <button
              key={r.id}
              onClick={() => setSelected(r.id)}
              className={cn(
                'w-full text-left px-3 py-2.5 border-b flex flex-col gap-1',
                selected === r.id ? 'bg-zinc-100 dark:bg-zinc-800' : 'hover:bg-zinc-50 dark:hover:bg-zinc-900',
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-sm truncate">{r.name || r.phone}</span>
                <StatusBadge status={r.status} />
              </div>
              <div className="flex items-center justify-between text-xs text-zinc-500">
                <span className="truncate">{r.name ? r.phone : 'senza nome'}</span>
                <span className="shrink-0">{fmt(r.lastMessageAt)}</span>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Dettaglio: report + chat */}
      <div className="flex-1 min-w-0 flex flex-col">
        {selected == null ? (
          <div className="flex-1 grid place-items-center text-zinc-400">
            <div className="flex flex-col items-center gap-2">
              <MessageSquare className="size-8" />
              <span>Seleziona un lead per vedere la chat e il report.</span>
            </div>
          </div>
        ) : (
          <>
            {/* Report */}
            <div className="border-b p-4 space-y-3">
              {detail && (
                <>
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <div>
                      <div className="font-semibold">
                        {[detail.lead.firstName, detail.lead.lastName].filter(Boolean).join(' ') || detail.lead.phone}
                      </div>
                      <div className="text-sm text-zinc-500">
                        {detail.lead.phone}{detail.lead.email ? ` · ${detail.lead.email}` : ''}
                      </div>
                    </div>
                    <StatusBadge status={detail.report.status} />
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                    <Stat label="Messaggi lead" value={String(detail.report.inbound)} />
                    <Stat label="Risposte Mario" value={String(detail.report.outbound)} />
                    <Stat label="Attivo dal" value={fmt(detail.report.startedAt)} />
                    <Stat label="Ultima attività" value={fmt(detail.report.lastMessageAt)} />
                  </div>

                  {/* Riassunto AI */}
                  <div className="rounded-lg border bg-zinc-50 dark:bg-zinc-900 p-3 space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-1.5 text-sm font-medium">
                        <Sparkles className="size-4 text-amber-500" /> Riassunto AI
                      </div>
                      <Button size="sm" variant="outline" onClick={summarize} disabled={summarizing}>
                        <RefreshCw className={cn('size-3.5 mr-1', summarizing && 'animate-spin')} />
                        {detail.summary ? 'Rigenera' : 'Genera'}
                      </Button>
                    </div>
                    {detail.summary ? (
                      <>
                        <p className="text-sm whitespace-pre-wrap text-zinc-700 dark:text-zinc-300">{detail.summary}</p>
                        <div className="text-xs text-zinc-400">Generato il {fmt(detail.summaryAt)}</div>
                      </>
                    ) : (
                      <p className="text-sm text-zinc-400">
                        {summarizing ? 'Mario sta leggendo la conversazione…' : 'Nessun riassunto. Clicca "Genera".'}
                      </p>
                    )}
                  </div>
                </>
              )}
              {loading && !detail && <div className="text-sm text-zinc-400">Carico…</div>}
              {error && <div className="text-sm text-red-600">{error}</div>}
            </div>

            {/* Chat */}
            <div className="flex-1 overflow-y-auto p-4 space-y-2 bg-zinc-50/50 dark:bg-zinc-950">
              {detail?.messages.length === 0 && (
                <div className="text-sm text-zinc-400">Nessun messaggio.</div>
              )}
              {detail?.messages.map((m) => (
                <div key={m.id} className={cn('flex', m.direction === 'out' ? 'justify-end' : 'justify-start')}>
                  <div
                    className={cn(
                      'max-w-[75%] rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap break-words',
                      m.direction === 'out'
                        ? 'bg-emerald-600 text-white rounded-br-sm'
                        : 'bg-white dark:bg-zinc-800 border rounded-bl-sm',
                    )}
                  >
                    {m.is_template && (
                      <div className="text-[10px] uppercase tracking-wide opacity-70 mb-0.5">template</div>
                    )}
                    {m.body}
                    <div className={cn('text-[10px] mt-1', m.direction === 'out' ? 'text-emerald-100' : 'text-zinc-400')}>
                      {fmt(m.created_at)}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border px-2.5 py-1.5">
      <div className="text-xs text-zinc-500">{label}</div>
      <div className="font-medium">{value}</div>
    </div>
  );
}
