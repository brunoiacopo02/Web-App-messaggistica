'use client';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { RefreshCw, Sparkles, MessageSquare, Search, CalendarClock } from 'lucide-react';
import { ChatStatusPill } from '@/components/fenice/status';
import { StatCard } from '@/components/fenice/StatCard';

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
  report: { status: string | null; startedAt: string | null; lastMessageAt: string; scheduledAt: string | null; inbound: number; outbound: number; total: number };
  summary: string | null;
  summaryAt: string | null;
  messages: Msg[];
};

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

/** Data appuntamento in stile agenda: "Ven 26 Giu · 08:00". */
function fmtAppt(iso: string | null): string | null {
  if (!iso) return null;
  try {
    const d = new Date(iso);
    const day = d.toLocaleDateString('it-IT', { weekday: 'short', day: '2-digit', month: 'short' });
    const time = d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
    return `${day.charAt(0).toUpperCase() + day.slice(1)} · ${time}`;
  } catch {
    return null;
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
      {/* ── Lead list ──────────────────────────────────────────── */}
      <div className="flex w-72 shrink-0 flex-col border-r border-border/70 bg-card/30">
        <div className="border-b border-border/70 p-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Cerca nome o numero…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="h-9 rounded-xl pl-9"
            />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {filtered.length === 0 && <div className="p-4 text-sm text-muted-foreground">Nessun lead.</div>}
          {filtered.map((r) => {
            const active = selected === r.id;
            return (
              <button
                key={r.id}
                onClick={() => setSelected(r.id)}
                className={cn(
                  'flex w-full flex-col gap-1 rounded-xl px-3 py-2.5 text-left transition-colors',
                  active ? 'fenice-rail bg-brand/10' : 'hover:bg-muted',
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium">{r.name || r.phone}</span>
                  <ChatStatusPill status={r.status} />
                </div>
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span className="truncate">{r.name ? r.phone : 'senza nome'}</span>
                  <span className="shrink-0 tabular-nums">{fmt(r.lastMessageAt)}</span>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Detail: report + chat ──────────────────────────────── */}
      <div className="flex min-w-0 flex-1 flex-col">
        {selected == null ? (
          <EmptyDetail />
        ) : (
          <>
            <div className="space-y-4 border-b border-border/70 p-4 md:p-5">
              {detail && (
                <>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <div className="font-display text-lg font-bold tracking-tight">
                        {[detail.lead.firstName, detail.lead.lastName].filter(Boolean).join(' ') || detail.lead.phone}
                      </div>
                      <div className="text-sm text-muted-foreground">
                        {detail.lead.phone}{detail.lead.email ? ` · ${detail.lead.email}` : ''}
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {fmtAppt(detail.report.scheduledAt) && (
                        <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap text-emerald-700 dark:text-emerald-300">
                          <CalendarClock className="size-3.5" />
                          Appuntamento: {fmtAppt(detail.report.scheduledAt)}
                        </span>
                      )}
                      <ChatStatusPill status={detail.report.status} />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    <StatCard label="Messaggi lead" value={detail.report.inbound} tone="sky" />
                    <StatCard label="Risposte Mario" value={detail.report.outbound} tone="ember" />
                    <StatCard label="Attivo dal" value={fmt(detail.report.startedAt)} />
                    <StatCard label="Ultima attività" value={fmt(detail.report.lastMessageAt)} />
                  </div>

                  {/* AI summary */}
                  <div className="rounded-2xl border border-brand/20 bg-brand/[0.05] p-4">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-1.5 text-sm font-semibold">
                        <Sparkles className="size-4 text-brand" /> Riassunto AI
                      </div>
                      <Button size="sm" variant="outline" onClick={summarize} disabled={summarizing} className="rounded-lg">
                        <RefreshCw className={cn('mr-1 size-3.5', summarizing && 'animate-spin')} />
                        {detail.summary ? 'Rigenera' : 'Genera'}
                      </Button>
                    </div>
                    {detail.summary ? (
                      <>
                        <p className="mt-2 whitespace-pre-wrap text-sm text-foreground/90">{detail.summary}</p>
                        <div className="mt-2 text-xs text-muted-foreground">Generato il {fmt(detail.summaryAt)}</div>
                      </>
                    ) : (
                      <p className="mt-2 text-sm text-muted-foreground">
                        {summarizing ? 'Mario sta leggendo la conversazione…' : 'Nessun riassunto. Clicca “Genera”.'}
                      </p>
                    )}
                  </div>
                </>
              )}
              {loading && !detail && <div className="text-sm text-muted-foreground">Carico…</div>}
              {error && (
                <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-600 dark:text-rose-300">
                  {error}
                </div>
              )}
            </div>

            {/* Chat */}
            <div className="flex-1 space-y-2.5 overflow-y-auto bg-muted/30 p-4 md:p-5">
              {detail?.messages.length === 0 && (
                <div className="text-sm text-muted-foreground">Nessun messaggio.</div>
              )}
              {detail?.messages.map((m) => (
                <div key={m.id} className={cn('flex', m.direction === 'out' ? 'justify-end' : 'justify-start')}>
                  <div
                    className={cn(
                      'max-w-[78%] whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2 text-sm shadow-sm',
                      m.direction === 'out'
                        ? 'rounded-br-sm bg-brand text-brand-foreground'
                        : 'rounded-bl-sm border border-border/70 bg-card',
                    )}
                  >
                    {m.is_template && (
                      <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide opacity-70">template</div>
                    )}
                    {m.body}
                    <div className={cn('mt-1 text-[10px]', m.direction === 'out' ? 'text-brand-foreground/70' : 'text-muted-foreground')}>
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

function EmptyDetail() {
  return (
    <div className="grid flex-1 place-items-center text-muted-foreground">
      <div className="flex flex-col items-center gap-3">
        <span className="grid size-14 place-items-center rounded-2xl border border-border/70 bg-card">
          <MessageSquare className="size-6 text-brand" />
        </span>
        <span className="text-sm">Seleziona un lead per vedere la chat e il report.</span>
      </div>
    </div>
  );
}
