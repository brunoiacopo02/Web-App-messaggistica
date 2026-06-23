'use client';

import { useEffect, useState } from 'react';
import { ArrowUpRight, BarChart3, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ReasonPill } from '@/components/fenice/status';
import { StatCard } from '@/components/fenice/StatCard';
import { StatusLegend } from '@/components/fenice/StatusLegend';

type Tab = 'ATTIVA' | 'MAI_RISPOSTO' | 'FERMA' | 'REPORT' | 'ANALISI';

const SEGMENT_TABS: { key: Tab; label: string }[] = [
  { key: 'ATTIVA', label: 'Attive' },
  { key: 'MAI_RISPOSTO', label: 'Mai risposto' },
  { key: 'FERMA', label: 'Ferme' },
  { key: 'REPORT', label: 'Report' },
  { key: 'ANALISI', label: 'Analisi AI' },
];

const LIST_TABS: Tab[] = ['ATTIVA', 'MAI_RISPOSTO', 'FERMA'];

interface SegRow { id: number; phone: string; name: string; segment: string; reason: string | null; lastMessageAt: string; status: string | null; }
interface Counts { PRESO: number; MAI_RISPOSTO: number; ATTIVA: number; FERMA: number; total: number; }

export function LeadPipeline() {
  const [tab, setTab] = useState<Tab>('ATTIVA');
  const [period, setPeriod] = useState('all');
  const [counts, setCounts] = useState<Counts | null>(null);
  const [rows, setRows] = useState<SegRow[]>([]);
  const [report, setReport] = useState<any>(null);
  const [analysis, setAnalysis] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    (async () => {
      try {
        if (tab === 'REPORT') {
          setCounts(null);
          const r = await fetch(`/api/fenice/report?period=${period}`).then((x) => x.json());
          if (active) setReport(r);
        } else if (tab === 'ANALISI') {
          setCounts(null);
          const r = await fetch('/api/fenice/analysis').then((x) => x.json());
          if (active) setAnalysis(r);
        } else {
          const r = await fetch(`/api/fenice/segments?segment=${tab}&period=${period}`).then((x) => x.json());
          if (active) { setCounts(r.counts); setRows(r.rows ?? []); }
        }
      } catch { /* ignore */ } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [tab, period]);

  const isList = LIST_TABS.includes(tab);

  return (
    <div className="mx-auto w-full max-w-4xl space-y-5">
      {/* Tabs + period */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="inline-flex flex-wrap gap-1 rounded-xl border border-border/70 bg-card p-1">
          {SEGMENT_TABS.map((t) => {
            const active = tab === t.key;
            const count = counts && t.key in counts ? (counts as any)[t.key] : null;
            return (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={cn(
                  'rounded-lg px-3 py-1.5 text-sm font-medium transition-colors',
                  active ? 'bg-brand text-brand-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {t.label}
                {count != null && (
                  <span className={cn('ml-1.5 tabular-nums', active ? 'opacity-80' : 'opacity-60')}>{count}</span>
                )}
              </button>
            );
          })}
        </div>
        <select
          value={period}
          onChange={(e) => setPeriod(e.target.value)}
          className="ml-auto h-9 rounded-xl border border-border/70 bg-card px-3 text-sm"
        >
          <option value="7">Ultimi 7 giorni</option>
          <option value="30">Ultimi 30 giorni</option>
          <option value="all">Tutto</option>
        </select>
      </div>

      {isList && <StatusLegend />}

      {loading && <p className="text-sm text-muted-foreground">Caricamento…</p>}

      {/* ── Report ─────────────────────────────────────────────── */}
      {!loading && tab === 'REPORT' && report?.ok && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatCard label="Totale lead" value={report.total} icon={BarChart3} />
            <StatCard label="Presi" value={report.presi} tone="emerald" />
            <StatCard label="Non presi" value={report.nonPresi} tone="amber" />
            <StatCard label="Conversione" value={`${(report.conversionRate * 100).toFixed(1)}%`} tone="ember" />
          </div>
          <div className="rounded-2xl border border-border/70 bg-card p-4 text-sm text-muted-foreground">
            Mai risposto: <b className="text-foreground">{report.maiRisposto}</b> — pari al{' '}
            <b className="text-foreground">{(report.maiRispostoShareOfNonPresi * 100).toFixed(0)}%</b> dei non presi.
          </div>
          <div className="overflow-hidden rounded-2xl border border-border/70 bg-card">
            <div className="border-b border-border/70 px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Conversione per funnel
            </div>
            <div className="divide-y divide-border/60">
              {report.byFunnel.map((f: any) => (
                <div key={f.funnel} className="flex items-center justify-between px-4 py-2.5 text-sm">
                  <span className="font-medium">{f.funnel}</span>
                  <span className="tabular-nums text-muted-foreground">{f.presi}/{f.total} presi</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── AI analysis ────────────────────────────────────────── */}
      {!loading && tab === 'ANALISI' && analysis?.ok && (
        <div className="space-y-4">
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Sparkles className="size-3.5 text-brand" />
            {analysis.generatedAt
              ? `Aggiornato il ${new Date(analysis.generatedAt).toLocaleString('it-IT')}`
              : 'Nessuna analisi ancora generata'}
          </p>
          {analysis.report && (
            <>
              <div className="grid gap-4 md:grid-cols-2">
                <AnalysisList title="Obiezioni principali" rows={analysis.report.topObjections} labelKey="category" />
                <AnalysisList title="Dove si bloccano" rows={analysis.report.dropoffStages} labelKey="stage" />
              </div>
              <div className="rounded-2xl border border-brand/20 bg-brand/[0.05] p-4">
                <div className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
                  <Sparkles className="size-4 text-brand" /> Lettura di Mario
                </div>
                <p className="whitespace-pre-wrap text-sm text-foreground/90">{analysis.report.narrative}</p>
              </div>
            </>
          )}
        </div>
      )}

      {/* ── Segment lists ──────────────────────────────────────── */}
      {!loading && isList && (
        <div className="overflow-hidden rounded-2xl border border-border/70 bg-card">
          {rows.length === 0 ? (
            <p className="px-4 py-10 text-center text-sm text-muted-foreground">Nessun lead in questo segmento.</p>
          ) : (
            <div className="divide-y divide-border/60">
              {rows.map((r) => (
                <div key={r.id} className="flex items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-muted/50">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">{r.name || r.phone}</div>
                    <div className="truncate text-xs text-muted-foreground">{r.phone}</div>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    {r.reason && <ReasonPill reason={r.reason} />}
                    <a
                      href={`/fenice/conversazioni?id=${r.id}`}
                      className="inline-flex items-center gap-0.5 text-xs font-medium text-brand hover:underline"
                    >
                      Apri <ArrowUpRight className="size-3.5" />
                    </a>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function AnalysisList({ title, rows, labelKey }: { title: string; rows: any[]; labelKey: string }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-border/70 bg-card">
      <div className="border-b border-border/70 px-4 py-2.5 text-sm font-semibold">{title}</div>
      <div className="divide-y divide-border/60">
        {rows.map((o: any) => (
          <div key={o[labelKey]} className="flex items-center justify-between px-4 py-2 text-sm">
            <span className="text-muted-foreground">{o[labelKey]}</span>
            <span className="tabular-nums font-medium">{o.count}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
