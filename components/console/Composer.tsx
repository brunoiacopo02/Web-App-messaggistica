'use client';

import { useRef, useState } from 'react';
import { Bot, Clock, Pause, Send, UserRound } from 'lucide-react';
import { finestra24h } from '@/lib/console/thread';
import { Button } from './ui/Button';

interface ComposerProps {
  inPausa: boolean;
  lastInboundAt: string | null;
  now: Date;
  pausaInCorso: boolean;
  onPausa: () => void;
  /** Invia il testo; `true` se è partito (il campo si svuota), `false` se resta da rimandare. */
  onInvia: (testo: string) => Promise<boolean>;
}

function Finestra({ lastInboundAt, now }: { lastInboundAt: string | null; now: Date }) {
  const f = finestra24h(lastInboundAt, now);
  return (
    <span className={f.aperta ? 'win num' : 'win chiusa'}>
      <Clock size={16} strokeWidth={1.75} className="ico" aria-hidden="true" />
      {f.aperta ? `Finestra 24h: chiude ${f.chiudeAlle}` : 'Finestra chiusa: serve un template'}
    </span>
  );
}

/** Si scrive solo a Mario in pausa: la rotta di invio risponde 409 `bot_attivo` altrimenti, e
 *  due voci sulla stessa chat confonderebbero il lead e il modello. */
export function Composer({ inPausa, lastInboundAt, now, pausaInCorso, onPausa, onInvia }: ComposerProps) {
  const [testo, setTesto] = useState('');
  const [invio, setInvio] = useState(false);
  // Guardia sincrona: due Ctrl+Invio nello stesso giro di eventi vedono ancora `invio` a false.
  const inCorso = useRef(false);
  const aperta = finestra24h(lastInboundAt, now).aperta;
  const puoInviare = inPausa && aperta && testo.trim() !== '' && !invio;

  async function invia() {
    if (!puoInviare || inCorso.current) return;
    inCorso.current = true;
    setInvio(true);
    try {
      if (await onInvia(testo.trim())) setTesto('');
    } finally {
      inCorso.current = false;
      setInvio(false);
    }
  }

  if (!inPausa) {
    return (
      <div className="composer">
        <div className="cmp-top">
          <span className="own">
            <Bot size={16} strokeWidth={1.75} className="ico" aria-hidden="true" />
            Mario gestisce questa chat.
          </span>
          <span className="sp" />
          <Finestra lastInboundAt={lastInboundAt} now={now} />
        </div>
        <div className="cmp">
          <textarea disabled placeholder="Per scrivere tu, metti in pausa Mario" aria-label="Messaggio al lead" />
          <Button className="tall" caricamento={pausaInCorso} onClick={onPausa}>
            <Pause size={16} strokeWidth={1.75} className="ico" aria-hidden="true" />
            Metti in pausa Mario per scrivere…
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="composer">
      <div className="cmp-top">
        <span className="own">
          <UserRound size={16} strokeWidth={1.75} className="ico" aria-hidden="true" />
          Mario è in pausa: scrivi tu.
        </span>
        <span className="sp" />
        <Finestra lastInboundAt={lastInboundAt} now={now} />
      </div>
      <div className="cmp">
        <textarea
          value={testo}
          disabled={!aperta}
          maxLength={4096}
          aria-label="Messaggio al lead"
          placeholder={aperta ? 'Scrivi al lead. Ctrl+Invio invia, Invio va a capo.' : 'Finestra chiusa: il testo libero non parte, serve un template'}
          onChange={(e) => setTesto(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              void invia();
            }
            if (e.key === 'Escape') e.currentTarget.blur();
          }}
        />
        <Button variante="primario" className="tall" caricamento={invio} disabled={!puoInviare} onClick={() => void invia()}>
          <Send size={16} strokeWidth={1.75} className="ico" aria-hidden="true" />
          Invia
        </Button>
      </div>
    </div>
  );
}
