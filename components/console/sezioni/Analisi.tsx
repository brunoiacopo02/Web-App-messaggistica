'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { parseAsStringLiteral, useQueryStates } from 'nuqs';
import { REASON_LEGEND, SEGMENT_LEGEND, reasonMeta } from '@/components/fenice/status';
import {
  ETICHETTA_PERIODO, ETICHETTA_SCHEDA, PERIODI, SCHEDE, SEGMENTO,
  dataAppuntamento, ordinaPresi, percentuale, tonoMotivo, urlLettura,
  type AnalisiAi, type Conteggi, type Periodo, type Report, type RigaSegmento, type Scheda,
} from '@/lib/console/analisi';
import { dataOraBreve } from '@/lib/console/thread';
import { formattaTelefono } from '@/lib/console/riga';
import { BarList } from '../ui/BarList';
import { SkeletonRighe, useCaricamentoVisibile } from '../ui/Skeleton';
import { Cifre } from '../ui/Cifre';
import { Errore, Vuoto } from '../ui/Stato';
import { Tag } from '../ui/Tag';

/**
 * Analisi dei lead di Mario: la pipeline di `/fenice/lead` (segmenti, report, analisi AI) con le
 * stesse rotte e gli stessi parametri. Scheda e periodo stanno nell'URL.
 */

const PARSER = {
  scheda: parseAsStringLiteral(SCHEDE).withDefault('attive'),
  periodo: parseAsStringLiteral(PERIODI).withDefault('all'),
};


type Dati =
  | { tipo: 'lista'; conteggi: Conteggi; righe: RigaSegmento[] }
  | { tipo: 'report'; report: Report }
  | { tipo: 'ai'; analisi: AnalisiAi };

type Letto = { chiave: string; dati: Dati };

async function leggi(scheda: Scheda, periodo: Periodo): Promise<Dati> {
  const r = await fetch(urlLettura(scheda, periodo));
  const j = (await r.json().catch(() => null)) as ({ ok?: boolean; error?: string } & Record<string, unknown>) | null;
  if (!r.ok || !j || j.ok === false) {
    throw new Error(j?.error ? `Il server ha risposto ${r.status}: ${j.error}. Riprova tra poco.` : `Il server ha risposto ${r.status}. Riprova tra poco.`);
  }
  if (scheda === 'report') return { tipo: 'report', report: j as unknown as Report };
  if (scheda === 'ai') return { tipo: 'ai', analisi: j as unknown as AnalisiAi };
  return { tipo: 'lista', conteggi: j.counts as Conteggi, righe: (j.rows as RigaSegmento[] | undefined) ?? [] };
}

export function Analisi() {
  const [{ scheda, periodo }, setStato] = useQueryStates(PARSER);
  const [giro, setGiro] = useState(0);
  const [letto, setLetto] = useState<Letto | null>(null);
  const [errore, setErrore] = useState<{ chiave: string; testo: string } | null>(null);
  /** Gli ultimi conteggi per segmento e il periodo a cui si riferiscono (restano sulle schede). */
  const [conteggi, setConteggi] = useState<{ periodo: Periodo; c: Conteggi } | null>(null);

  const chiave = `${scheda}|${periodo}|${giro}`;

  // Una lettura a ogni cambio di scheda, periodo o "Riprova"; lo stato si scrive solo nelle callback
  // della promessa e una risposta superata si scarta.
  useEffect(() => {
    let vivo = true;
    const k = `${scheda}|${periodo}|${giro}`;
    leggi(scheda, periodo).then(
      (dati) => {
        if (!vivo) return;
        setLetto({ chiave: k, dati });
        setErrore(null);
        if (dati.tipo === 'lista' && dati.conteggi) setConteggi({ periodo, c: dati.conteggi });
      },
      (e: unknown) => {
        if (vivo) setErrore({ chiave: k, testo: e instanceof Error ? e.message : String(e) });
      },
    );
    return () => {
      vivo = false;
    };
  }, [scheda, periodo, giro]);

  const dati = letto?.chiave === chiave ? letto.dati : null;
  const inErrore = errore?.chiave === chiave;
  const skeleton = useCaricamentoVisibile(!dati && !inErrore);
  const numeri = conteggi?.periodo === periodo ? conteggi.c : null;
  const lista = scheda in SEGMENTO;

  let corpo: React.ReactNode;
  if (inErrore) {
    corpo = <Errore titolo="Non riesco a leggere i lead" testo={errore.testo} onRiprova={() => setGiro((g) => g + 1)} />;
  } else if (!dati) {
    corpo = <div aria-busy="true">{skeleton && <SkeletonRighe righe={10} altezza={32} />}</div>;
  } else if (dati.tipo === 'lista') {
    corpo = <Lista scheda={scheda} righe={scheda === 'presi' ? ordinaPresi(dati.righe) : dati.righe} />;
  } else if (dati.tipo === 'report') {
    corpo = <ReportLead report={dati.report} periodo={periodo} />;
  } else {
    corpo = <LetturaAi analisi={dati.analisi} />;
  }

  return (
    <div className="avv an">
      <header className="avv-hd">
        <h1>Analisi</h1>
        <span className="avv-agg">I lead di Mario per fase del funnel, la conversione e le obiezioni lette dall&apos;AI.</span>
      </header>

      <div className="an-barra">
        <div className="seg" role="tablist" aria-label="Segmenti e analisi">
          {SCHEDE.map((s) => {
            const seg = SEGMENTO[s];
            const n = seg && numeri ? numeri[seg] : null;
            return (
              <button
                key={s}
                type="button"
                role="tab"
                aria-selected={scheda === s}
                aria-controls="an-pannello"
                onClick={() => void setStato({ scheda: s })}
              >
                {ETICHETTA_SCHEDA[s]}
                {n != null && <span className="num seg-n"><Cifre n={n} /></span>}
              </button>
            );
          })}
        </div>
        <label className="sel an-per">
          <select aria-label="Periodo" value={periodo} onChange={(e) => void setStato({ periodo: e.target.value as Periodo })}>
            {PERIODI.map((p) => <option key={p} value={p}>{ETICHETTA_PERIODO[p]}</option>)}
          </select>
        </label>
      </div>

      <div id="an-pannello" role="tabpanel" aria-label={ETICHETTA_SCHEDA[scheda]} className="an-pan">
        {lista && <Legenda />}
        {corpo}
      </div>
    </div>
  );
}

function Lista({ scheda, righe }: { scheda: Scheda; righe: RigaSegmento[] }) {
  if (righe.length === 0) {
    return (
      <Vuoto
        titolo={scheda === 'presi' ? 'Nessun appuntamento preso' : 'Nessun lead in questo segmento'}
        testo="Nel periodo scelto non c'è nessuno qui. Prova con un periodo più lungo o un altro segmento."
      />
    );
  }
  const presi = scheda === 'presi';
  return (
    <div className="tbl-wrap">
      <table className="tbl an-tbl">
        <thead>
          <tr>
            <th scope="col">Lead</th>
            <th scope="col">Telefono</th>
            <th scope="col">{presi ? 'Appuntamento' : 'Motivo'}</th>
            <th scope="col">Ultimo messaggio</th>
            <th scope="col"><span className="sr-only">Chat</span></th>
          </tr>
        </thead>
        <tbody>
          {righe.map((r) => {
            const motivo = r.reason ? reasonMeta(r.reason) : null;
            return (
              <tr key={r.id}>
                <td className="an-nm">{r.name || <span className="mono">{formattaTelefono(r.phone)}</span>}</td>
                <td className="mono">{r.name ? formattaTelefono(r.phone) : ''}</td>
                <td>
                  {presi ? (
                    <span className={r.scheduledAt ? 'mono' : 'muted'}>{dataAppuntamento(r.scheduledAt) ?? 'Data da definire'}</span>
                  ) : motivo && r.reason ? (
                    <Tag tono={tonoMotivo(r.reason)}>{motivo.label}</Tag>
                  ) : (
                    <span className="muted">–</span>
                  )}
                </td>
                <td className="mono muted">{r.lastMessageAt ? dataOraBreve(r.lastMessageAt) ?? '' : ''}</td>
                <td className="an-apri">
                  <Link href={`/console?chat=${r.id}`}>Apri</Link>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ReportLead({ report, periodo }: { report: Report; periodo: Periodo }) {
  return (
    <>
      <dl className="an-kv">
        <div><dt>Totale lead</dt><dd className="num"><Cifre n={report.total} /></dd></div>
        <div><dt>Presi</dt><dd className="num"><Cifre n={report.presi} /></dd></div>
        <div><dt>Non presi</dt><dd className="num"><Cifre n={report.nonPresi} /></dd></div>
        <div><dt>Conversione</dt><dd className="num">{percentuale(report.conversionRate)}</dd></div>
      </dl>
      <p className="an-nota">
        Mai risposto: <b className="num"><Cifre n={report.maiRisposto} /></b>, il{' '}
        <b className="num">{percentuale(report.maiRispostoShareOfNonPresi, 0)}</b> dei non presi
        {periodo === 'all' ? '.' : ` (${ETICHETTA_PERIODO[periodo].toLowerCase()}).`}
      </p>
      <section className="an-sez" aria-labelledby="an-funnel">
        <h2 id="an-funnel">Conversione per funnel</h2>
        {report.byFunnel.length === 0 ? (
          <p className="muted">Nessun lead nel periodo scelto.</p>
        ) : (
          <div className="tbl-wrap">
            <table className="tbl an-tbl">
              <thead>
                <tr>
                  <th scope="col">Funnel</th>
                  <th scope="col" className="r">Presi</th>
                  <th scope="col" className="r">Lead</th>
                  <th scope="col" className="r">Conversione</th>
                </tr>
              </thead>
              <tbody>
                {report.byFunnel.map((f) => (
                  <tr key={f.funnel}>
                    <td>{f.funnel}</td>
                    <td className="r num"><Cifre n={f.presi} /></td>
                    <td className="r num"><Cifre n={f.total} /></td>
                    <td className="r num">{f.total ? percentuale(f.presi / f.total) : '–'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

function LetturaAi({ analisi }: { analisi: AnalisiAi }) {
  const r = analisi.report;
  if (!r) {
    return (
      <Vuoto
        titolo="Nessuna analisi ancora generata"
        testo="L'analisi la scrive un job ogni ora sulle chat di Mario: qui compare l'ultima salvata."
      />
    );
  }
  return (
    <>
      <p className="avv-agg">
        {analisi.generatedAt ? <>Aggiornata <span className="mono">{dataOraBreve(analisi.generatedAt) ?? analisi.generatedAt}</span>, si rigenera ogni ora.</> : 'Data di generazione sconosciuta.'}
      </p>
      <div className="an-due">
        <section className="an-sez" aria-labelledby="an-obiezioni">
          <h2 id="an-obiezioni">Obiezioni principali</h2>
          <BarList
            titolo="Obiezioni principali"
            voci={(r.topObjections ?? []).map((o) => ({ etichetta: o.category, valore: o.count }))}
            vuoto="Nessuna obiezione registrata."
          />
        </section>
        <section className="an-sez" aria-labelledby="an-blocchi">
          <h2 id="an-blocchi">Dove si bloccano</h2>
          <BarList
            titolo="Dove si bloccano"
            voci={(r.dropoffStages ?? []).map((o) => ({ etichetta: o.stage, valore: o.count }))}
            vuoto="Nessun punto di blocco registrato."
          />
        </section>
      </div>
      {r.narrative && (
        <section className="an-sez" aria-labelledby="an-lettura">
          <h2 id="an-lettura">Lettura di Mario</h2>
          <p className="an-testo"><ConGrassetto testo={r.narrative} /></p>
        </section>
      )}
    </>
  );
}

/** Il testo dell'analisi arriva con il grassetto markdown (`**…**`): lo si mostra come grassetto,
 *  non come asterischi. Nient'altro del markdown viene interpretato. */
function ConGrassetto({ testo }: { testo: string }) {
  return testo.split(/\*\*(.+?)\*\*/g).map((pezzo, i) => (i % 2 === 1 ? <b key={i}>{pezzo}</b> : pezzo));
}

/** Il glossario degli stati, chiuso finché non serve (come `StatusLegend`). */
function Legenda() {
  return (
    <details className="an-leg">
      <summary>Cosa significano gli stati?</summary>
      <dl>
        {SEGMENT_LEGEND.map((s) => (
          <div key={s.key}><dt>{s.label}</dt><dd>{s.hint}</dd></div>
        ))}
        {REASON_LEGEND.map((s) => (
          <div key={s.key}><dt><Tag tono={tonoMotivo(s.key)}>{s.label}</Tag></dt><dd>{s.hint}</dd></div>
        ))}
      </dl>
    </details>
  );
}
