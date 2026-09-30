'use client';

import { Fragment, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Bot, Clock, RotateCcw, Send, TriangleAlert, UserRound } from 'lucide-react';
import { raggruppa, type Msg } from '@/lib/console/thread';
import { Bolla } from '../Bolla';
import { Button } from '../ui/Button';
import { Tag } from '../ui/Tag';
import { useOra } from '../useOra';
import { useSimulatore, type Turno } from './useSimulatore';

/** Risposte tipiche di un lead, le stesse del simulatore vecchio: per provare il flusso senza scrivere. */
const RISPOSTE_RAPIDE = ['Sì, sono interessato', 'Quanto costa?', 'Come funziona?', 'Non ora, grazie'];

const ICONA = { size: 16, strokeWidth: 1.75, className: 'ico', 'aria-hidden': true } as const;

/** Il turno del simulatore nella forma di un messaggio del thread: il lead entra, Mario esce. */
function comeMessaggio(t: Turno): Msg {
  return {
    id: t.id,
    direction: t.role === 'user' ? 'in' : 'out',
    body: t.content,
    created_at: t.at,
    is_template: false,
    twilio_status: null,
    twilio_error_code: null,
    sender: t.role === 'user' ? null : 'bot',
  };
}

const nienteDaAscoltare = () => () => {};

/**
 * Simulatore di Mario: tu scrivi come il lead, Mario risponde con la stessa logica e la stessa
 * rotta del simulatore di `/fenice`. Il thread usa le bolle della chat (Task 7). Niente parte su
 * WhatsApp: la rotta genera soltanto la risposta.
 */
export function Simulatore() {
  const sim = useSimulatore();
  const [testo, setTesto] = useState('');
  const now = useOra();
  // Gli orari dei turni nascono nel browser: il thread si disegna solo dopo l'idratazione.
  const nelBrowser = useSyncExternalStore(nienteDaAscoltare, () => true, () => false);

  const voci = useMemo(() => raggruppa(sim.turni.map(comeMessaggio), now), [sim.turni, now]);

  const scorri = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = scorri.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [voci, sim.pensa, sim.attesa, sim.errore]);

  function manda(t: string) {
    if (sim.invia(t)) setTesto('');
  }

  return (
    <section className="thread sim" aria-label="Simulatore di Mario">
      <div className="th">
        <div className="who">
          <div className="who-l1"><h1 className="sim-t">Simulatore</h1></div>
          <div className="who-l2 sim-sub">Sei il lead: Mario risponde come in produzione, ma non parte nulla su WhatsApp.</div>
        </div>
        <span className="sp" />
        <Button onClick={sim.ricomincia}>
          <RotateCcw {...ICONA} />
          Ricomincia
        </Button>
      </div>

      <div ref={scorri} className="msgs" role="log" aria-label="Messaggi del simulatore">
        {nelBrowser && (
          <>
            {voci.map((v, i) => {
              if (v.tipo === 'giorno') return <div key={`g${i}`} className="day">{v.etichetta}</div>;
              return (
                <Fragment key={`b${v.messaggi[0].id}`}>
                  {v.lato === 'bot' && (
                    <div className="who-lbl r">
                      <Bot {...ICONA} />
                      Mario
                    </div>
                  )}
                  {v.messaggi.map((m, j) => (
                    <Bolla key={m.id} m={m} primo={j === 0} consegna={false} />
                  ))}
                </Fragment>
              );
            })}

            {sim.attesa !== null && (
              <div className="typing sim-attesa" role="status">
                <Clock {...ICONA} />
                <span>Mario risponde tra <span className="num">{sim.attesa}</span> s</span>
                <button type="button" className="sim-salta" onClick={sim.saltaAttesa}>Rispondi ora</button>
              </div>
            )}
            {sim.pensa && sim.attesa === null && (
              <div className="typing" role="status">
                <Bot {...ICONA} />
                Mario sta scrivendo…
              </div>
            )}
            {sim.errore && (
              <div className="sys error" role="alert">
                <TriangleAlert {...ICONA} />
                <span>Mario non ha risposto: {sim.errore}. Scrivi un altro messaggio per riprovare, o ricomincia.</span>
              </div>
            )}
          </>
        )}
      </div>

      <div className="composer">
        <div className="cmp-top">
          <span className="own">
            <UserRound {...ICONA} />
            Scrivi come se fossi il lead. Puoi mandarne più di fila: Mario li legge insieme.
          </span>
          <span className="sp" />
          {sim.appuntamento && <Tag tono="ok">Appuntamento fissato</Tag>}
          {sim.passaggio && <Tag tono="urgente">Passaggio a operatore</Tag>}
          {sim.inAttesa > 0 && <Tag tono="neutro">{sim.inAttesa} in attesa di risposta</Tag>}
        </div>
        <div className="sim-rapide" role="group" aria-label="Risposte rapide">
          {RISPOSTE_RAPIDE.map((r) => (
            <button key={r} type="button" className="btn filtro" onClick={() => sim.invia(r)}>{r}</button>
          ))}
        </div>
        <div className="cmp">
          <textarea
            aria-label="Messaggio del lead"
            placeholder="Scrivi come il lead…"
            value={testo}
            onChange={(e) => setTesto(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                manda(testo);
              }
            }}
          />
          <Button variante="primario" className="tall" disabled={!testo.trim()} onClick={() => manda(testo)}>
            <Send {...ICONA} />
            Invia come lead
          </Button>
        </div>
      </div>
    </section>
  );
}
