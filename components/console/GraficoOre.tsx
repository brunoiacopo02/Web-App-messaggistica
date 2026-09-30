'use client';

import { oraRoma, type ConsegneOra } from '@/lib/console/regia';
import { useOra } from './useOra';

const fmt = new Intl.NumberFormat('it-IT');
const due = (n: number) => String(n).padStart(2, '0');

/** Nella barra c'è posto per un'etichetta ogni due ore dalle 8 alle 20; nella sala per tutte le pari. */
const ASSE_BARRA = new Set([8, 10, 12, 14, 16, 18, 20]);
const ASSE_GRANDE = new Set(Array.from({ length: 12 }, (_, i) => i * 2));
const PASSO = 10;
const ALTEZZA_BARRA = 26;

interface GraficoOreProps {
  perOra: ConsegneOra[];
  /** Altezza del grafico in px: 26 nella barra di regia, 180 nella sala del lancio. */
  altezza?: number;
}

/** Consegne ora per ora di oggi (ora di Roma): barra piena = inviati, rosso in cima = falliti,
 *  ora corrente in ember come nel mockup. Nella versione grande annota l'ora corrente sopra la
 *  sua barra. Senza invii dice che non è partito ancora niente invece di disegnare 24 tacche. */
export function GraficoOre({ perOra, altezza = ALTEZZA_BARRA }: GraficoOreProps) {
  const ora = oraRoma(useOra());
  const grande = altezza > ALTEZZA_BARRA;
  const max = Math.max(1, ...perOra.map((o) => o.inviati));
  const picco = perOra.reduce<ConsegneOra | null>((a, o) => (!a || o.inviati > a.inviati ? o : a), null);
  const conFalliti = perOra.filter((o) => o.falliti > 0).map((o) => o.ora);
  const vuoto = !picco || picco.inviati === 0;
  const h = (n: number) => (n / max) * altezza;
  const adesso = perOra.find((o) => o.ora === ora);

  const descr = vuoto
    ? 'Nessun invio oggi'
    : `Invii per ora di oggi: picco ${fmt.format(picco.inviati)} alle ${due(picco.ora)}${conFalliti.length ? `, falliti alle ${conFalliti.join(', ')}` : ''}`;

  return (
    <div className={grande ? 'tracker grande' : 'tracker'}>
      <div className="hd">
        <span>Consegne ora per ora<span className="hd-x">, oggi</span></span>
        {conFalliti.length ? <em>falliti alle {conFalliti.slice(-3).join(', ')}</em> : null}
      </div>
      {vuoto ? (
        <p className="go-vuoto" style={{ height: altezza }}>Ancora nessun invio oggi</p>
      ) : (
        <div className="go-area">
          {grande && adesso ? (
            // Ai bordi l'etichetta si appoggia verso l'interno invece di uscire dal grafico.
            <p className={`go-nota${ora <= 2 ? ' sx' : ora >= 21 ? ' dx' : ''}`} style={{ left: `${((ora + 0.5) / 24) * 100}%` }}>
              <b>Ore {due(ora)}</b> {fmt.format(adesso.inviati)} inviati
              {adesso.falliti > 0 ? <>, <span className="go-ko">{fmt.format(adesso.falliti)} falliti</span></> : null}
            </p>
          ) : null}
          <svg
            className="bars-svg"
            style={{ height: altezza }}
            viewBox={`0 0 ${24 * PASSO} ${altezza}`}
            preserveAspectRatio="none"
            role="img"
            aria-label={descr}
          >
            {perOra.map((o) => {
              // Una tacca minima anche a zero invii, come nel mockup: l'asse delle ore resta leggibile.
              const hOk = Math.max(1, h(o.inviati - o.falliti));
              const hKo = h(o.falliti);
              const x = o.ora * PASSO + 1;
              return (
                <g key={o.ora}>
                  <title>{`${due(o.ora)}:00 · ${fmt.format(o.inviati)} inviati, ${fmt.format(o.consegnati)} consegnati, ${fmt.format(o.falliti)} falliti`}</title>
                  <rect className={o.ora === ora ? 'b now' : 'b'} x={x} width={PASSO - 2} y={altezza - hOk} height={hOk} />
                  {o.falliti > 0 ? <rect className="ko" x={x} width={PASSO - 2} y={altezza - hOk - hKo} height={hKo} /> : null}
                </g>
              );
            })}
          </svg>
        </div>
      )}
      <div className="axis24" aria-hidden="true">
        {perOra.map((o) => <span key={o.ora}>{(grande ? ASSE_GRANDE : ASSE_BARRA).has(o.ora) ? due(o.ora) : ''}</span>)}
      </div>
    </div>
  );
}
