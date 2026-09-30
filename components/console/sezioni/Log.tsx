'use client';

import Link from 'next/link';
import { Fragment, useEffect, useRef, useState, type FormEvent } from 'react';
import { ChevronDown, ChevronRight, Search } from 'lucide-react';
import { LIVELLI_LOG, queryLog, type FiltriLog, type LivelloLog, type RigaLog, type RispostaLog } from '@/lib/console/log';
import { dataOraBreve } from '@/lib/console/thread';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { SkeletonRighe, useCaricamentoVisibile } from '../ui/Skeleton';
import { Errore, Vuoto } from '../ui/Stato';
import { Tag, type Tono } from '../ui/Tag';

type Filtri = Omit<FiltriLog, 'prima'>;
type Pagina = { chiave: string; righe: RigaLog[]; prossimo: string; finestraDa: string; piena: boolean };

const LIVELLO: Record<LivelloLog, { tono: Tono; nome: string }> = {
  info: { tono: 'neutro', nome: 'info' },
  warn: { tono: 'attesa', nome: 'avviso' },
  error: { tono: 'errore', nome: 'errore' },
};

const MOTIVO: Record<string, string> = {
  filtri_non_validi: 'Un filtro non è valido: il tipo accetta lettere, numeri e _ . : -, la chat solo un numero.',
  lettura_lenta: 'La lettura ha superato 8 secondi. Restringi con un tipo o un livello e riprova.',
};

function chiaveDi(f: Filtri): string {
  return queryLog(f);
}

function convDi(payload: unknown): number | null {
  const v = (payload as { conversationId?: unknown } | null)?.conversationId;
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
}

function giorno(iso: string): string {
  return new Date(iso).toLocaleDateString('it-IT', { timeZone: 'Europe/Rome', day: '2-digit', month: '2-digit' });
}

async function leggi(f: Filtri, prima: string | null): Promise<RispostaLog> {
  const r = await fetch(`/api/console/log${queryLog({ ...f, prima })}`, { cache: 'no-store' });
  const j = (await r.json().catch(() => ({}))) as Partial<RispostaLog> & { errore?: string };
  if (!r.ok) throw new Error(MOTIVO[j.errore ?? ''] ?? `Il server ha risposto ${r.status}. I dati non sono cambiati: riprova.`);
  return { righe: j.righe ?? [], prossimo: j.prossimo ?? '', finestraDa: j.finestraDa ?? '', piena: j.piena ?? false };
}

/** Log di sistema: `event_log` a pagine da 100, filtri tipo/livello/chat, payload JSON su richiesta. */
export function Log() {
  const [filtri, setFiltri] = useState<Filtri>({ tipo: null, livello: null, conv: null });
  const [bozzaTipo, setBozzaTipo] = useState('');
  const [bozzaConv, setBozzaConv] = useState('');
  const [pagina, setPagina] = useState<Pagina | null>(null);
  const [errore, setErrore] = useState<{ chiave: string; testo: string } | null>(null);
  const [altre, setAltre] = useState<'no' | 'carico' | string>('no');
  const [aperte, setAperte] = useState<Set<number>>(() => new Set());
  const seq = useRef(0);

  const [giro, setGiro] = useState(0);
  const chiave = chiaveDi(filtri);
  const chiaveGiro = `${chiave}#${giro}`;

  // La prima pagina si rilegge a ogni cambio di filtri (o a "Riprova", che fa un giro nuovo);
  // lo stato si scrive solo nelle callback della promessa, e una risposta superata si scarta.
  useEffect(() => {
    let vivo = true;
    const k = chiaveDi(filtri);
    leggi(filtri, null).then(
      (p) => {
        if (!vivo) return;
        setPagina({ chiave: k, ...p });
        setErrore(null);
      },
      (e: unknown) => {
        if (vivo) setErrore({ chiave: `${k}#${giro}`, testo: e instanceof Error ? e.message : String(e) });
      },
    );
    return () => {
      vivo = false;
    };
  }, [filtri, giro]);

  const inCorso = pagina?.chiave !== chiave && errore?.chiave !== chiaveGiro;
  const skeleton = useCaricamentoVisibile(inCorso);
  const righe = pagina?.chiave === chiave ? pagina.righe : null;

  function applica(e?: FormEvent) {
    e?.preventDefault();
    const conv = bozzaConv.trim();
    seq.current++;
    setAltre('no');
    setAperte(new Set());
    setFiltri((f) => ({ ...f, tipo: bozzaTipo.trim() || null, conv: /^\d+$/.test(conv) ? Number(conv) : null }));
  }

  function livello(l: LivelloLog | null) {
    seq.current++;
    setAltre('no');
    setAperte(new Set());
    setFiltri((f) => ({ ...f, livello: l }));
  }

  async function caricaAltre() {
    if (!pagina || pagina.chiave !== chiave) return;
    const n = ++seq.current;
    setAltre('carico');
    try {
      const p = await leggi(filtri, pagina.prossimo);
      if (n !== seq.current) return;
      setPagina((prec) => (prec && prec.chiave === chiave ? { ...prec, ...p, righe: [...prec.righe, ...p.righe] } : prec));
      setAltre('no');
    } catch (e) {
      if (n !== seq.current) return;
      setAltre(e instanceof Error ? e.message : String(e));
    }
  }

  function apri(id: number) {
    setAperte((s) => {
      const x = new Set(s);
      if (x.has(id)) x.delete(id);
      else x.add(id);
      return x;
    });
  }

  const tipiVisti = [...new Set((righe ?? []).map((r) => r.type))].sort();

  let corpo: React.ReactNode;
  if (righe === null) {
    corpo = errore?.chiave === chiaveGiro ? (
      <Errore titolo="Non riesco a leggere il log" testo={errore.testo} onRiprova={() => setGiro((g) => g + 1)} />
    ) : (
      <div aria-busy="true">{skeleton && <SkeletonRighe righe={12} altezza={32} />}</div>
    );
  } else if (righe.length === 0 && pagina) {
    corpo = (
      <Vuoto
        titolo="Nessun evento con questi filtri"
        testo={`Ho guardato dal ${giorno(pagina.finestraDa)} a oggi. Puoi cercare nei 7 giorni prima o togliere un filtro.`}
        azione={<Button onClick={() => void caricaAltre()} caricamento={altre === 'carico'}>Cerca nei 7 giorni prima</Button>}
      />
    );
  } else {
    corpo = (
      <>
        <div className="tbl-wrap">
          <table className="tbl log-tbl">
            <thead>
              <tr>
                <th scope="col" className="log-x"><span className="sr-only">Dettaglio</span></th>
                <th scope="col">Ora</th>
                <th scope="col">Livello</th>
                <th scope="col">Tipo</th>
                <th scope="col">Messaggio</th>
                <th scope="col">Chat</th>
              </tr>
            </thead>
            <tbody>
              {righe.map((r) => {
                const aperta = aperte.has(r.id);
                const conv = convDi(r.payload);
                const liv = LIVELLO[r.level as LivelloLog] ?? { tono: 'neutro' as Tono, nome: r.level };
                return (
                  <Fragment key={r.id}>
                    <tr className={aperta ? 'log-aperta' : undefined}>
                      <td className="log-x">
                        <button
                          type="button"
                          className="iconbtn"
                          aria-expanded={aperta}
                          aria-controls={`p-${r.id}`}
                          aria-label={aperta ? 'Chiudi il payload' : 'Apri il payload'}
                          onClick={() => apri(r.id)}
                        >
                          {aperta ? <ChevronDown size={16} strokeWidth={1.75} /> : <ChevronRight size={16} strokeWidth={1.75} />}
                        </button>
                      </td>
                      <td className="mono">{dataOraBreve(r.created_at) ?? r.created_at}</td>
                      <td><Tag tono={liv.tono}>{liv.nome}</Tag></td>
                      <td className="mono log-tipo">{r.type}</td>
                      <td className="log-msg" title={r.message ?? undefined}>{r.message ?? <span className="muted">senza messaggio</span>}</td>
                      <td className="mono">{conv ? <Link href={`/console?chat=${conv}`}>{conv}</Link> : <span className="muted">–</span>}</td>
                    </tr>
                    {aperta && (
                      <tr className="log-det" id={`p-${r.id}`}>
                        <td />
                        <td colSpan={5}>
                          {r.message && <p className="log-det-msg">{r.message}</p>}
                          <pre className="log-json mono">{r.payload === null || r.payload === undefined ? 'payload vuoto' : JSON.stringify(r.payload, null, 2)}</pre>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="log-piede">
          <span className="muted">
            {righe.length} eventi{pagina ? `, dal ${giorno(pagina.piena ? righe[righe.length - 1].created_at : pagina.finestraDa)}` : ''}
          </span>
          <Button onClick={() => void caricaAltre()} caricamento={altre === 'carico'}>
            {pagina?.piena ? 'Carica i 100 precedenti' : 'Cerca nei 7 giorni prima'}
          </Button>
          {altre !== 'no' && altre !== 'carico' && <span className="log-ko" role="alert">{altre}</span>}
        </div>
      </>
    );
  }

  return (
    <div className="avv log">
      <header className="avv-hd">
        <h1>Log</h1>
        <span className="avv-agg">Eventi di sistema, dal più recente. Un clic sulla freccia apre il payload.</span>
      </header>

      <form className="log-filtri" onSubmit={applica} role="search" aria-label="Filtri del log">
        <Input
          className="log-in"
          aria-label="Tipo evento"
          placeholder="Tipo, es. fenice_ai_reply"
          list="log-tipi"
          spellCheck={false}
          value={bozzaTipo}
          onChange={(e) => setBozzaTipo(e.target.value)}
          prima={<Search size={16} strokeWidth={1.75} className="ico" />}
        />
        <datalist id="log-tipi">
          {tipiVisti.map((t) => <option key={t} value={t} />)}
        </datalist>
        <Input
          className="log-in log-in-conv"
          aria-label="Id chat"
          placeholder="Id chat"
          inputMode="numeric"
          value={bozzaConv}
          onChange={(e) => setBozzaConv(e.target.value)}
        />
        <Button type="submit">Filtra</Button>
        <div className="log-liv" role="group" aria-label="Livello">
          <button type="button" className="btn filtro" aria-pressed={filtri.livello === null} onClick={() => livello(null)}>Tutti</button>
          {LIVELLI_LOG.map((l) => (
            <button key={l} type="button" className="btn filtro" aria-pressed={filtri.livello === l} onClick={() => livello(l)}>
              {LIVELLO[l].nome}
            </button>
          ))}
        </div>
      </form>

      {corpo}
    </div>
  );
}
