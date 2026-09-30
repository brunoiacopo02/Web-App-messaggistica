'use client';

import Link from 'next/link';
import { useSyncExternalStore, type ReactNode } from 'react';
import { statoOnda, type ConsegneOra, type Regia, type VoceScaletta } from '@/lib/console/regia';
import { GraficoOre } from './GraficoOre';
import { useRegia } from './RegiaProvider';
import { useOra } from './useOra';
import { Cifre } from './ui/Cifre';

const pct = new Intl.NumberFormat('it-IT', { style: 'percent', maximumFractionDigits: 1 });
const FMT_HM = new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const FMT_GIORNO = new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', weekday: 'long', day: 'numeric', month: 'numeric' });

const hm = (iso: string) => FMT_HM.format(new Date(iso));
const due = (n: number) => String(n).padStart(2, '0');

/** "domenica 5/10, ore 21:00" */
const quandoEvento = (iso: string) => `${FMT_GIORNO.format(new Date(iso))}, ore ${hm(iso)}`;

// ─────────── orologio al secondo, solo per la luce ───────────
// Store a parte: ogni secondo ridisegna solo `LuceOnda`, non la barra né la shell.
let adesso = new Date();
function iscriviSecondo(f: () => void) {
  adesso = new Date();
  const id = setInterval(() => {
    adesso = new Date();
    f();
  }, 1000);
  return () => clearInterval(id);
}
function useSecondo(): Date {
  return useSyncExternalStore(iscriviSecondo, () => adesso, () => adesso);
}

function Marchio() {
  return (
    <svg className="mark" viewBox="0 0 20 20" aria-hidden="true">
      <rect width="20" height="20" rx="5" fill="var(--ember)" />
      <path d="M6.5 15V5h7M6.5 10h5" stroke="var(--ember-ink)" strokeWidth="2" fill="none" strokeLinecap="round" />
    </svg>
  );
}

/** Luce di onda e timecode: ricalcola lo stato ogni secondo sul client, così il passaggio da
 *  "Alla live" a "In onda" non aspetta il polling. */
function LuceOnda({ eventoAt, chiusuraAt }: { eventoAt: string; chiusuraAt: string | null }) {
  const now = useSecondo();
  const { stato, secondi } = statoOnda(now, eventoAt);

  if (stato === 'in_onda') {
    const h = Math.floor(secondi / 3600);
    const m = Math.floor((secondi % 3600) / 60);
    return (
      <div className="onair">
        <div className="tally"><i aria-hidden="true" /><span>In onda</span></div>
        <div className="timecode" aria-label={`In onda da ${h} ore ${m} minuti`}>
          {due(h)}:{due(m)}:{due(secondi % 60)}
        </div>
      </div>
    );
  }
  if (stato === 'prima') {
    const ore = Math.floor(secondi / 3600);
    const min = Math.floor((secondi % 3600) / 60);
    return (
      <div className="onair">
        <div className="tally"><i aria-hidden="true" /><span>Alle {hm(eventoAt)}</span></div>
        <div className="timecode">
          {ore >= 1 ? (
            <><small>Tra</small> {ore}<small> {ore === 1 ? 'ora' : 'ore'} </small>{min}<small> min</small></>
          ) : (
            <><small>Tra</small> {due(min)}:{due(secondi % 60)}</>
          )}
        </div>
      </div>
    );
  }
  return (
    <div className="onair">
      <div className="tally"><i aria-hidden="true" /><span>Live finita</span></div>
      <div className="timecode"><small>{chiusuraAt ? `chiusa alle ${hm(chiusuraAt)}` : 'nessuna diretta ora'}</small></div>
    </div>
  );
}

// ─────────── scaletta ───────────
const PRIMA_MIN = 60;
const DOPO_MIN = 80;
/** Dove va l'etichetta di ogni voce: sopra/sotto la linea, e se allineata a sinistra del segno
 *  (inizio, vicinissimo al link). */
const POSIZIONE: Record<VoceScaletta['voce'], string> = {
  link: 'rd-lbl up',
  inizio: 'rd-lbl dn end',
  pitch: 'rd-lbl dn',
  chiusura: 'rd-lbl up',
};

function Scaletta({ eventoAt, scaletta }: { eventoAt: string; scaletta: VoceScaletta[] }) {
  const now = useOra();
  const t0 = Date.parse(eventoAt) - PRIMA_MIN * 60_000;
  const span = (PRIMA_MIN + DOPO_MIN) * 60_000;
  const pos = (ms: number) => Math.min(100, Math.max(0, ((ms - t0) / span) * 100));
  const inizio = pos(Date.parse(eventoAt));
  const testina = pos(now.getTime());
  const inOnda = now.getTime() >= Date.parse(eventoAt);
  return (
    <div className="rundown" aria-label={`Scaletta della serata, ora ${FMT_HM.format(now)}`}>
      <div className="rd-track" />
      <div className="rd-past" style={{ width: `${testina}%` }} />
      {inOnda ? <div className="rd-air" style={{ left: `${inizio}%`, width: `${Math.max(0, testina - inizio)}%` }} /> : null}
      {scaletta.map((v) => {
        const x = pos(Date.parse(v.at));
        return (
          <div key={v.voce}>
            <div className="rd-tick" style={{ left: `${x}%` }} />
            <span className={POSIZIONE[v.voce]} style={{ left: `${x}%` }}>
              <b>{hm(v.at)}</b> {v.etichetta.toLowerCase()}
            </span>
          </div>
        );
      })}
      <div className="rd-head" style={{ left: `${testina}%` }} title={`Ora: ${FMT_HM.format(now)}`} />
    </div>
  );
}

// ─────────── numeri ───────────
function Kpi({ etichetta, valore, sotto, grave }: { etichetta: string; valore: number; sotto: ReactNode; grave?: boolean }) {
  return (
    <div className={grave ? 'kpi bad' : 'kpi'}>
      <div className="l">{etichetta}</div>
      <div className="v"><Cifre n={valore} /></div>
      <div className="s">{sotto}</div>
    </div>
  );
}

function Numeri({ n, perOra }: { n: Regia['numeri']; perOra: ConsegneOra[] }) {
  const inviatiOggi = perOra.reduce((a, o) => a + o.inviati, 0);
  const quota = (a: number, b: number) => (b > 0 ? pct.format(a / b) : '–');
  return (
    <>
      <Kpi etichetta="Iscritti" valore={n.iscritti} sotto="chat nel lancio" />
      <Kpi etichetta="Hanno bloccato il posto" valore={n.postoBloccato} sotto={`${quota(n.postoBloccato, n.iscritti)} degli iscritti`} />
      <Kpi etichetta="Link inviati" valore={n.linkInviati} sotto={`${quota(n.linkInviati, n.iscritti)} degli iscritti`} />
      <Kpi etichetta="Consegnati oggi" valore={n.consegnatiOggi} sotto={`${quota(n.consegnatiOggi, inviatiOggi)} degli invii`} />
      <Kpi
        etichetta="Falliti"
        valore={n.fallitiOggi}
        grave={n.fallitiOggi > 0}
        sotto={n.fallitiOggi > 0 ? <Link href="/console?vista=errori">Apri le chat con errori…</Link> : 'nessuno oggi'}
      />
    </>
  );
}

// ─────────── barra ───────────
const STATO_CSS: Record<Regia['stato']['stato'], string> = { prima: 'pre', in_onda: 'live', dopo: 'post', nessuno: 'post' };

function RigaMinima({ children, azioni }: { children: ReactNode; azioni?: ReactNode }) {
  return (
    <section className="regia-min" aria-label="Regia del lancio">
      <div className="brand"><Marchio /><b>Fenice</b><span>Mario</span></div>
      <div className="msg">{children}</div>
      {azioni && <div className="azioni">{azioni}</div>}
    </section>
  );
}

/** Barra di regia (mockup righe 404-482): luce di onda, scaletta, numeri del lancio e consegne
 *  ora per ora. A lancio spento o senza data dell'evento si riduce a una riga da 36 px.
 *  `azioni` occupa la colonna destra della prima riga: il bottone della palette. */
export function BarraRegia({ azioni }: { azioni?: ReactNode }) {
  const { regia, errore } = useRegia();

  if (!regia) {
    return (
      <RigaMinima azioni={azioni}>
        {errore ? 'Regia non raggiungibile: riprovo da sola fra 30 secondi.' : <span aria-busy="true">Carico la regia…</span>}
      </RigaMinima>
    );
  }
  if (!regia.attivo || !regia.eventoAt || regia.stato.stato === 'nessuno') {
    return (
      <RigaMinima azioni={azioni}>
        {regia.attivo ? 'Lancio acceso ma senza data dell\'evento' : 'Nessun lancio in corso'}
        {' · '}
        <Link href="/console/impostazioni">Impostazioni…</Link>
      </RigaMinima>
    );
  }

  const chiusura = regia.scaletta.find((v) => v.voce === 'chiusura')?.at ?? null;
  return (
    <section className="regia" aria-label="Regia del lancio" data-state={STATO_CSS[regia.stato.stato]}>
      <div className="r1">
        <div className="brand"><Marchio /><b>Fenice</b><span>Mario</span></div>
        <div className="show">
          <b>Webinar Web Dev AI</b>
          <span className="muted">{quandoEvento(regia.eventoAt)}</span>
        </div>
        <Scaletta eventoAt={regia.eventoAt} scaletta={regia.scaletta} />
        <div>{azioni}</div>
      </div>
      <div className="r2">
        <LuceOnda eventoAt={regia.eventoAt} chiusuraAt={chiusura} />
        <Numeri n={regia.numeri} perOra={regia.perOra} />
        <GraficoOre perOra={regia.perOra} />
      </div>
    </section>
  );
}
