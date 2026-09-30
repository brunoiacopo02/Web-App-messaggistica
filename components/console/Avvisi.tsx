'use client';

import { useEffect, useRef, useState } from 'react';
import type { AreaAvviso, AvvisoConsole } from '@/lib/console/avvisi';
import { ID_CRON, type IdCron } from '@/lib/console/azioni-tipi';
import { oraRoma } from '@/lib/console/thread';
import { FlussoAzione } from './FlussoAzione';
import { RegistroAzioni } from './RegistroAzioni';
import { RigaAvviso } from './RigaAvviso';
import { SkeletonRighe, useCaricamentoVisibile } from './ui/Skeleton';
import { Errore, Vuoto } from './ui/Stato';
import { useAvvisi, useRegistro, type RigaRegistro } from './useAvvisi';

const AREE: { area: AreaAvviso; nome: string }[] = [
  { area: 'lancio', nome: 'Lancio' },
  { area: 'crm', nome: 'CRM' },
  { area: 'twilio', nome: 'Twilio e invii' },
  { area: 'cron', nome: 'Cron' },
  { area: 'bot', nome: 'Mario' },
  { area: 'gdo', nome: 'GDO' },
];

type Gruppo = { chiave: string; nome: string; avvisi: AvvisoConsole[] };

/** Critici tutti insieme in cima, poi il resto per area nell'ordine fisso di `AREE`. */
export function raggruppaAvvisi(avvisi: readonly AvvisoConsole[]): Gruppo[] {
  const gruppi: Gruppo[] = [];
  const critici = avvisi.filter((a) => a.gravita === 'critico');
  if (critici.length > 0) gruppi.push({ chiave: 'critici', nome: 'Critici', avvisi: critici });
  for (const { area, nome } of AREE) {
    const g = avvisi.filter((a) => a.gravita !== 'critico' && a.area === area);
    if (g.length > 0) gruppi.push({ chiave: area, nome, avvisi: g });
  }
  return gruppi;
}

const giornoRoma = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' });

function azioniOggi(righe: RigaRegistro[] | null): number | null {
  if (!righe) return null;
  const oggi = giornoRoma.format(new Date());
  return righe.filter((r) => giornoRoma.format(new Date(r.created_at)) === oggi).length;
}

function AzioniManuali({ onEseguita }: { onEseguita: () => void }) {
  const [cron, setCron] = useState<IdCron>('bot-followups');
  return (
    <section className="avv-gruppo" aria-labelledby="azioni-manuali">
      <div className="avv-gh">
        <h2 id="azioni-manuali">Azioni manuali</h2>
      </div>
      <p className="avv-intro">Ogni azione parte da una prova a vuoto: vedi cosa farebbe, poi confermi.</p>
      <div className="avv-manuali">
        <FlussoAzione rif={{ azione: 'rinvia_esiti_403', params: {}, etichetta: 'Rinvia gli esiti rifiutati' }} onEseguita={onEseguita} />
        <FlussoAzione
          rif={{ azione: 'recupera_agende_consegnate', params: {}, etichetta: 'Recupera le agende consegnate' }}
          onEseguita={onEseguita}
        />
        <div className="avv-cron">
          <label className="sel">
            <span>Cron</span>
            <select value={cron} onChange={(e) => setCron(e.target.value as IdCron)}>
              {ID_CRON.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          {/* Cambiare cron riparte da zero: una prova vale solo per il cron su cui è stata fatta. */}
          <FlussoAzione key={cron} rif={{ azione: 'rilancia_cron', params: { cron }, etichetta: `Rilancia ${cron}` }} onEseguita={onEseguita} />
        </div>
      </div>
    </section>
  );
}

/** Pagina Avvisi: testata con i numeri, avvisi raggruppati, azioni manuali e registro. */
/** `/console/avvisi#id` (le fonti dell'Assistente): gli avvisi arrivano dopo il caricamento, quindi
 *  lo scorrimento nativo all'ancora non trova l'elemento. Appena la lista c'è, scorre all'avviso
 *  e gli dà il focus; una volta sola per ancora, così i giri di polling non riportano lassù. */
export function useScorriAllAncora(pronto: boolean) {
  const fatta = useRef<string | null>(null);
  useEffect(() => {
    if (!pronto) return;
    const vai = () => {
      let id = '';
      try {
        id = decodeURIComponent(window.location.hash.slice(1));
      } catch {
        return;
      }
      if (!id || fatta.current === id) return;
      const el = document.getElementById(id);
      if (!el) return;
      fatta.current = id;
      el.scrollIntoView({ block: 'start' });
      el.focus({ preventScroll: true });
    };
    vai();
    window.addEventListener('hashchange', vai);
    return () => window.removeEventListener('hashchange', vai);
  }, [pronto]);
}

export function Avvisi() {
  const avvisi = useAvvisi();
  const registro = useRegistro();
  const [tab, setTab] = useState<'avvisi' | 'registro'>('avvisi');
  const skeleton = useCaricamentoVisibile(avvisi.dati === null && !avvisi.errore);

  const lista = avvisi.dati;
  useScorriAllAncora(lista !== null && lista.length > 0);
  const critici = lista?.filter((a) => a.gravita === 'critico').length ?? null;
  const oggi = azioniOggi(registro.dati);
  const rileggiTutto = () => {
    void avvisi.rileggi();
    void registro.rileggi();
  };

  let corpo: React.ReactNode;
  if (lista === null) {
    corpo = avvisi.errore ? (
      <Errore
        titolo="Non riesco a leggere gli avvisi"
        testo="La richiesta al server non è andata a buon fine. Gli avvisi non sono cambiati: riprova tra un momento."
        onRiprova={() => void avvisi.rileggi()}
      />
    ) : (
      <div aria-busy="true">{skeleton && <SkeletonRighe righe={5} altezza={96} />}</div>
    );
  } else if (lista.length === 0) {
    corpo = <Vuoto titolo="Nessun avviso aperto." testo="Qui compaiono gli errori del bot, dei cron e degli invii." />;
  } else {
    corpo = raggruppaAvvisi(lista).map((g) => (
      <section key={g.chiave} className="avv-gruppo" aria-labelledby={`g-${g.chiave}`}>
        <div className="avv-gh">
          <h2 id={`g-${g.chiave}`}>{g.nome}</h2>
          <span className="num muted">{g.avvisi.length}</span>
        </div>
        {g.avvisi.map((a) => (
          <RigaAvviso key={a.id} a={a} onCambio={rileggiTutto} />
        ))}
      </section>
    ));
  }

  return (
    <div className="avv">
      <header className="avv-hd">
        <h1>Avvisi</h1>
        <dl className="avv-kv">
          <div>
            <dt>aperti</dt>
            <dd className="num">{lista?.length ?? '–'}</dd>
          </div>
          <div>
            <dt>critici</dt>
            <dd className={`num${critici ? ' avv-kv-crit' : ''}`}>{critici ?? '–'}</dd>
          </div>
          <div>
            <dt>azioni oggi</dt>
            <dd className="num">{oggi ?? '–'}</dd>
          </div>
        </dl>
        <span className="sp" />
        {avvisi.aggiornatoAt && (
          <span className={avvisi.errore ? 'avv-agg avv-agg-ko' : 'avv-agg'}>
            {avvisi.errore ? 'ultima lettura non riuscita, riprovo tra 30 s; dati delle ' : 'aggiornati alle '}
            <span className="mono">{oraRoma(avvisi.aggiornatoAt)}</span>
          </span>
        )}
      </header>

      <div className="avv-tabs" role="tablist" aria-label="Sezioni">
        <button type="button" role="tab" id="tab-avvisi" aria-controls="pan-avvisi" aria-selected={tab === 'avvisi'} onClick={() => setTab('avvisi')}>
          Avvisi aperti
        </button>
        <button type="button" role="tab" id="tab-registro" aria-controls="pan-registro" aria-selected={tab === 'registro'} onClick={() => setTab('registro')}>
          Registro azioni
        </button>
      </div>

      {tab === 'avvisi' ? (
        <div role="tabpanel" id="pan-avvisi" aria-labelledby="tab-avvisi" className="avv-pan">
          {corpo}
          <AzioniManuali onEseguita={rileggiTutto} />
        </div>
      ) : (
        <div role="tabpanel" id="pan-registro" aria-labelledby="tab-registro" className="avv-pan">
          <RegistroAzioni righe={registro.dati} errore={registro.errore} onRiprova={() => void registro.rileggi()} />
        </div>
      )}
    </div>
  );
}
