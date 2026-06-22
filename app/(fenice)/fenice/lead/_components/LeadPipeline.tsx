'use client';

import { useEffect, useState } from 'react';

type Tab = 'ATTIVA' | 'MAI_RISPOSTO' | 'FERMA' | 'REPORT' | 'ANALISI';

const SEGMENT_TABS: { key: Tab; label: string }[] = [
  { key: 'ATTIVA', label: 'Attive' },
  { key: 'MAI_RISPOSTO', label: 'Mai risposto' },
  { key: 'FERMA', label: 'Ferme' },
  { key: 'REPORT', label: 'Report' },
  { key: 'ANALISI', label: 'Analisi AI' },
];

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
      if (tab === 'REPORT') {
        const r = await fetch(`/api/fenice/report?period=${period}`).then((x) => x.json());
        if (active) setReport(r);
      } else if (tab === 'ANALISI') {
        const r = await fetch('/api/fenice/analysis').then((x) => x.json());
        if (active) setAnalysis(r);
      } else {
        const r = await fetch(`/api/fenice/segments?segment=${tab}&period=${period}`).then((x) => x.json());
        if (active) { setCounts(r.counts); setRows(r.rows ?? []); }
      }
      if (active) setLoading(false);
    })();
    return () => { active = false; };
  }, [tab, period]);

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        {SEGMENT_TABS.map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`px-3 py-1.5 rounded-md text-sm ${tab === t.key ? 'bg-black text-white' : 'bg-gray-100 text-gray-700'}`}>
            {t.label}
            {counts && t.key in counts ? ` (${(counts as any)[t.key]})` : ''}
          </button>
        ))}
        <select value={period} onChange={(e) => setPeriod(e.target.value)} className="ml-auto border rounded-md px-2 py-1 text-sm">
          <option value="7">Ultimi 7 giorni</option>
          <option value="30">Ultimi 30 giorni</option>
          <option value="all">Tutto</option>
        </select>
      </div>

      {loading && <p className="text-sm text-gray-500">Caricamento…</p>}

      {!loading && tab === 'REPORT' && report?.ok && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Stat label="Totale lead" value={report.total} />
            <Stat label="Presi" value={report.presi} />
            <Stat label="Non presi" value={report.nonPresi} />
            <Stat label="Conversione" value={`${(report.conversionRate * 100).toFixed(1)}%`} />
          </div>
          <p className="text-sm text-gray-600">
            Mai risposto: <b>{report.maiRisposto}</b> — pari al <b>{(report.maiRispostoShareOfNonPresi * 100).toFixed(0)}%</b> dei non presi.
          </p>
          <div className="border rounded-md divide-y">
            {report.byFunnel.map((f: any) => (
              <div key={f.funnel} className="flex justify-between px-3 py-2 text-sm">
                <span>{f.funnel}</span><span>{f.presi}/{f.total} presi</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {!loading && tab === 'ANALISI' && analysis?.ok && (
        <div className="space-y-3">
          <p className="text-xs text-gray-500">
            {analysis.generatedAt ? `Aggiornato il ${new Date(analysis.generatedAt).toLocaleString('it-IT')}` : 'Nessuna analisi ancora generata'}
          </p>
          {analysis.report && (
            <>
              <div className="border rounded-md p-3">
                <h3 className="text-sm font-semibold mb-2">Obiezioni principali</h3>
                {analysis.report.topObjections.map((o: any) => (
                  <div key={o.category} className="flex justify-between text-sm py-0.5">
                    <span>{o.category}</span><span>{o.count}</span>
                  </div>
                ))}
              </div>
              <div className="border rounded-md p-3">
                <h3 className="text-sm font-semibold mb-2">Dove si bloccano</h3>
                {analysis.report.dropoffStages.map((s: any) => (
                  <div key={s.stage} className="flex justify-between text-sm py-0.5">
                    <span>{s.stage}</span><span>{s.count}</span>
                  </div>
                ))}
              </div>
              <div className="border rounded-md p-3 whitespace-pre-wrap text-sm">{analysis.report.narrative}</div>
            </>
          )}
        </div>
      )}

      {!loading && (tab === 'ATTIVA' || tab === 'MAI_RISPOSTO' || tab === 'FERMA') && (
        <div className="border rounded-md divide-y">
          {rows.length === 0 && <p className="px-3 py-4 text-sm text-gray-500">Nessun lead in questo segmento.</p>}
          {rows.map((r) => (
            <div key={r.id} className="flex items-center justify-between px-3 py-2 text-sm">
              <div>
                <div className="font-medium">{r.name || r.phone}</div>
                <div className="text-gray-500 text-xs">{r.phone}{r.reason ? ` · ${r.reason}` : ''}</div>
              </div>
              <a href={`/fenice/conversazioni?id=${r.id}`} className="text-blue-600 text-xs">Apri</a>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="border rounded-md p-3">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-xl font-semibold">{value}</div>
    </div>
  );
}
