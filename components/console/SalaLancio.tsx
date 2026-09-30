'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import type { AvvisoConsole } from '@/lib/console/avvisi';
import type { Regia } from '@/lib/console/regia';
import { ETICHETTA_FASE } from '@/lib/console/viste';
import { LANCIO_FASI } from '@/lib/lancio-fase';
import { GraficoOre } from './GraficoOre';
import { useRegia } from './RegiaProvider';
import { RigaAvviso } from './RigaAvviso';
import { Vuoto } from './ui/Stato';
import { useAvvisi } from './useAvvisi';

const fmt = new Intl.NumberFormat('it-IT');
const pct = new Intl.NumberFormat('it-IT', { style: 'percent', maximumFractionDigits: 0 });
const FMT_HM = new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const FMT_GIORNO = new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', weekday: 'long', day: 'numeric', month: 'numeric' });

const quandoEvento = (iso: string) => `${FMT_GIORNO.format(new Date(iso))}, ore ${FMT_HM.format(new Date(iso))}`;

/** Gli avvisi che riguardano la sala: quelli del lancio e quelli degli invii Twilio. */
export const avvisoDelLancio = (a: AvvisoConsole) => a.area === 'lancio' || a.id.startsWith('twilio_');

function Numero({ etichetta, valore, grave, children }: { etichetta: string; valore: number; grave?: boolean; children?: ReactNode }) {
  return (
    <div className={grave ? 'sala-n bad' : 'sala-n'}>
      <dt>{etichetta}</dt>
      <dd>{fmt.format(valore)}</dd>
      {children ? <dd className="sala-n-s">{children}</dd> : null}
    </div>
  );
}

function Numeri({ regia }: { regia: Regia }) {
  const n = regia.numeri;
  return (
    <dl className="sala-numeri" aria-label="Numeri del lancio">
      <Numero etichetta="Iscritti" valore={n.iscritti} />
      <Numero etichetta="Hanno bloccato il posto" valore={n.postoBloccato} />
      <Numero etichetta="Link inviati" valore={n.linkInviati} />
      <Numero etichetta="Consegnati oggi" valore={n.consegnatiOggi} />
      <Numero etichetta="Falliti oggi" valore={n.fallitiOggi} grave={n.fallitiOggi > 0}>
        {n.fallitiOggi > 0 ? <Link href="/console?vista=errori">Apri le chat con errori…</Link> : null}
      </Numero>
      <Numero etichetta="Restituiti" valore={regia.perFase.restituito ?? 0} />
    </dl>
  );
}

/** "Dove sono ora": una barra per fase (la fase attuale di ogni iscritto), lunga quanto la sua quota degli iscritti. */
function Fasi({ perFase, iscritti }: { perFase: Regia['perFase']; iscritti: number }) {
  return (
    <section className="sala-sez" aria-labelledby="sala-fasi">
      <h2 id="sala-fasi">Dove sono ora</h2>
      <ul className="sala-fasi">
        {LANCIO_FASI.map((f) => {
          const n = perFase[f] ?? 0;
          const quota = iscritti > 0 ? n / iscritti : 0;
          return (
            <li key={f}>
              <Link href={`/console?vista=lancio&fase=${f}`} className="sala-fase">
                <span className="sala-fase-nm">{ETICHETTA_FASE[f]}</span>
                <span className="sala-fase-t" aria-hidden="true">
                  <i style={{ width: `${Math.min(100, quota * 100)}%` }} />
                </span>
                <span className="sala-fase-n">{fmt.format(n)}</span>
                <span className="sala-fase-q">{iscritti > 0 ? pct.format(quota) : '–'}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function AvvisiLancio() {
  const avvisi = useAvvisi();
  const lista = avvisi.dati?.filter(avvisoDelLancio) ?? null;

  let corpo: ReactNode;
  if (lista === null) {
    corpo = avvisi.errore ? (
      <p className="sala-msg">Non riesco a leggere gli avvisi: riprovo da solo fra 30 secondi.</p>
    ) : (
      <p className="sala-msg" aria-busy="true">Carico gli avvisi…</p>
    );
  } else if (lista.length === 0) {
    corpo = <Vuoto titolo="Nessun avviso sul lancio." testo="Qui compaiono i problemi del lancio e degli invii Twilio, con le azioni per rimediare." />;
  } else {
    corpo = lista.map((a) => <RigaAvviso key={a.id} a={a} onCambio={() => void avvisi.rileggi()} />);
  }

  return (
    <section className="sala-sez" aria-labelledby="sala-avvisi">
      <div className="avv-gh">
        <h2 id="sala-avvisi">Avvisi del lancio</h2>
        {lista ? <span className="num muted">{lista.length}</span> : null}
      </div>
      {corpo}
    </section>
  );
}

function Acceso({ si }: { si: boolean }) {
  return <span className={si ? 'sala-on' : 'sala-off'}>{si ? 'acceso' : 'spento'}</span>;
}

/** Lancio, pulsante del webinar e data dell'evento; si cambiano da Impostazioni. */
function StatoLancio({ regia }: { regia: Regia }) {
  return (
    <div className="sala-stato">
      <dl aria-label="Stato del lancio">
        <div>
          <dt>Lancio</dt>
          <dd><Acceso si={regia.attivo} /></dd>
        </div>
        <div>
          <dt>Pulsante del webinar</dt>
          <dd><Acceso si={regia.pulsanteAttivo} /></dd>
        </div>
        <div>
          <dt>Evento</dt>
          <dd>{regia.eventoAt ? quandoEvento(regia.eventoAt) : <span className="sala-off">data non impostata</span>}</dd>
        </div>
      </dl>
      <Link href="/console/impostazioni">Impostazioni…</Link>
    </div>
  );
}

/** Sala del lancio: numeri, consegne ora per ora in grande, fasi raggiunte, avvisi del lancio
 *  con le azioni di rimedio e stato degli interruttori. I dati sono quelli della barra di regia
 *  (un solo polling a 30 s via `RegiaProvider`); gli avvisi hanno il loro polling. */
export function SalaLancio() {
  const { regia, errore } = useRegia();

  let corpo: ReactNode;
  if (!regia) {
    corpo = errore ? (
      <p className="sala-msg">Regia non raggiungibile: riprovo da sola fra 30 secondi.</p>
    ) : (
      <p className="sala-msg" aria-busy="true">Carico i numeri del lancio…</p>
    );
  } else if (!regia.attivo) {
    corpo = (
      <Vuoto
        titolo="Nessun lancio attivo. Si accende da Impostazioni."
        testo="A lancio spento non ci sono numeri, fasi né avvisi da seguire."
        azione={<Link className="btn" href="/console/impostazioni">Apri le impostazioni…</Link>}
      />
    );
  } else {
    corpo = (
      <>
        <StatoLancio regia={regia} />
        <Numeri regia={regia} />
        <section className="sala-sez sala-grafico" aria-label="Consegne ora per ora">
          <GraficoOre perOra={regia.perOra} altezza={180} />
        </section>
        <div className="sala-due">
          <Fasi perFase={regia.perFase} iscritti={regia.numeri.iscritti} />
          <AvvisiLancio />
        </div>
      </>
    );
  }

  return (
    <div className="sala">
      <header className="avv-hd">
        <h1>Lancio</h1>
        <span className="muted">Webinar Web Dev AI</span>
        <span className="sp" />
        {regia ? (
          <span className={errore ? 'avv-agg avv-agg-ko' : 'avv-agg'}>
            {errore ? 'ultima lettura non riuscita, riprovo tra 30 s; dati delle ' : 'aggiornati alle '}
            <span className="mono">{FMT_HM.format(new Date(regia.generatoAt))}</span>
          </span>
        ) : null}
      </header>
      {corpo}
    </div>
  );
}
