'use client';

import { Fragment, useLayoutEffect, useMemo, useRef } from 'react';
import { Bot, Cog, History, PanelRight, PanelRightClose, Pause, Play, TriangleAlert, UserRound } from 'lucide-react';
import { formattaTelefono, nomeRiga } from '@/lib/console/riga';
import { intercala, oraRoma, raggruppa, testoEvento, type DettaglioChat, type Msg, type Voce } from '@/lib/console/thread';
import { Avatar } from './ui/Avatar';
import { Button } from './ui/Button';
import { Tag } from './ui/Tag';
import { Tooltip } from './ui/Tooltip';
import { Bolla } from './Bolla';
import { Composer } from './Composer';

/** Sotto questa distanza dal fondo il thread segue i messaggi nuovi; più su, chi legge resta dov'è. */
const SOGLIA_FONDO = 80;

function IconaAutore({ autore }: { autore: string }) {
  const p = { size: 16, strokeWidth: 1.75, className: 'ico', 'aria-hidden': true } as const;
  if (autore === 'Mario') return <Bot {...p} />;
  if (autore === 'Automazione') return <Cog {...p} />;
  return <UserRound {...p} />;
}

function RigaSistema({ evento }: { evento: Extract<Voce, { tipo: 'sistema' }>['evento'] }) {
  const grave = evento.livello === 'warn' || evento.livello === 'error';
  const p = { size: 16, strokeWidth: 1.75, className: 'ico', 'aria-hidden': true } as const;
  return (
    <div className={grave ? `sys ${evento.livello}` : 'sys'}>
      {grave ? <TriangleAlert {...p} /> : <History {...p} />}
      <span>{testoEvento(evento.tipo, evento.testo)}</span>
      <span className="mono">{oraRoma(evento.at)}</span>
    </div>
  );
}

interface ThreadProps {
  dettaglio: DettaglioChat;
  messaggi: Msg[];
  now: Date;
  pausaInCorso: boolean;
  onPausa: (pausa: boolean) => void;
  onInvia: (testo: string) => Promise<boolean>;
  schedaAperta: boolean;
  onScheda: () => void;
}

/** La chat aperta: intestazione, messaggi con righe di sistema al loro orario, composer. */
export function Thread({ dettaglio, messaggi, now, pausaInCorso, onPausa, onInvia, schedaAperta, onScheda }: ThreadProps) {
  const { conv, lead } = dettaglio;
  const { principale, secondario } = nomeRiga(lead);
  const inPausa = conv.aiPausedAt != null;

  const voci = useMemo(() => intercala(raggruppa(messaggi, now), dettaglio.eventi, now), [messaggi, dettaglio.eventi, now]);

  const scorri = useRef<HTMLDivElement>(null);
  const inFondo = useRef(true);
  const aperta = useRef<number | null>(null);

  // All'apertura in fondo, senza animazione; poi segue i nuovi solo se chi legge era già in fondo.
  useLayoutEffect(() => {
    const el = scorri.current;
    if (!el) return;
    if (aperta.current !== conv.id || inFondo.current) {
      el.scrollTop = el.scrollHeight;
      aperta.current = conv.id;
      inFondo.current = true;
    }
  }, [voci, conv.id]);

  const telefono = lead.telefono ? formattaTelefono(lead.telefono) : null;

  return (
    <section className="thread" aria-label={`Chat con ${principale}`}>
      <div className="th">
        <Avatar nome={lead.nome} telefono={lead.telefono} grande />
        <div className="who">
          <div className="who-l1">
            <b className={secondario ? 'mono' : undefined}>{principale}</b>
            {telefono && !secondario && <span className="mono tel">{telefono}</span>}
            {secondario && <span className="sec">{secondario}</span>}
          </div>
          {conv.contesto && (
            <div className="who-l2">
              <Tag tono={conv.contesto.tono}>{conv.contesto.testo}</Tag>
            </div>
          )}
        </div>
        <span className="sp" />
        {inPausa ? (
          <Button variante="primario" caricamento={pausaInCorso} onClick={() => onPausa(false)}>
            <Play size={16} strokeWidth={1.75} className="ico" aria-hidden="true" />
            <span className="th-lbl">Ridai a Mario</span>
          </Button>
        ) : (
          <Button caricamento={pausaInCorso} onClick={() => onPausa(true)}>
            <Pause size={16} strokeWidth={1.75} className="ico" aria-hidden="true" />
            <span className="th-lbl">Metti in pausa Mario</span>
          </Button>
        )}
        <Tooltip contenuto={schedaAperta ? 'Chiudi la scheda lead (])' : 'Apri la scheda lead (])'}>
          <button
            type="button"
            className="iconbtn"
            aria-label={schedaAperta ? 'Chiudi la scheda lead' : 'Apri la scheda lead'}
            aria-pressed={schedaAperta}
            onClick={onScheda}
          >
            {schedaAperta ? (
              <PanelRightClose size={16} strokeWidth={1.75} aria-hidden="true" />
            ) : (
              <PanelRight size={16} strokeWidth={1.75} aria-hidden="true" />
            )}
          </button>
        </Tooltip>
      </div>

      <div
        ref={scorri}
        className="msgs"
        role="log"
        aria-label="Messaggi"
        onScroll={(e) => {
          const el = e.currentTarget;
          inFondo.current = el.scrollHeight - el.scrollTop - el.clientHeight < SOGLIA_FONDO;
        }}
      >
        {dettaglio.eventiParziali && (
          <div className="sys" role="status">
            <History size={16} strokeWidth={1.75} className="ico" aria-hidden="true" />
            <span>Eventi non caricati: la lettura è lenta. Riapri la chat per riprovare.</span>
          </div>
        )}
        {voci.length === 0 && <p className="msgs-vuoto">Nessun messaggio in questa chat.</p>}
        {voci.map((v, i) => {
          if (v.tipo === 'giorno') return <div key={`g${i}`} className="day">{v.etichetta}</div>;
          if (v.tipo === 'sistema') return <RigaSistema key={`s${i}`} evento={v.evento} />;
          return (
            <Fragment key={`b${v.messaggi[0].id}`}>
              {v.lato === 'bot' && (
                <div className="who-lbl r">
                  <IconaAutore autore={v.autore} />
                  {v.autore}
                </div>
              )}
              {v.messaggi.map((m, j) => (
                <Bolla key={m.id} m={m} primo={j === 0} />
              ))}
            </Fragment>
          );
        })}
      </div>

      <Composer
        key={conv.id}
        inPausa={inPausa}
        lastInboundAt={conv.lastInboundAt}
        now={now}
        pausaInCorso={pausaInCorso}
        onPausa={() => onPausa(true)}
        onInvia={onInvia}
      />
    </section>
  );
}
