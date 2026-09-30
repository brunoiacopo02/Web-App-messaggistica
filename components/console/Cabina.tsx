'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { oraRoma } from '@/lib/console/thread';
import { FlussoAzione } from './FlussoAzione';
import { GRAVITA } from './RigaAvviso';
import { useAvvisi } from './useAvvisi';

/** Quanti avvisi stanno nella cabina: il resto è nella pagina Avvisi. */
const IN_CABINA = 3;

/** Colonna destra della pagina chat: i primi avvisi critici e di attenzione in alto, sotto la
 *  scheda del lead della chat aperta (`children`). */
export function Cabina({ children }: { children?: ReactNode }) {
  const { dati, errore, rileggi } = useAvvisi();
  const urgenti = (dati ?? []).filter((a) => a.gravita !== 'info');
  const primi = urgenti.slice(0, IN_CABINA);

  let stato: ReactNode = null;
  if (dati === null) stato = errore ? <p className="cab-nota">Avvisi non letti: riprovo tra 30 s.</p> : null;
  else if (urgenti.length === 0) stato = <p className="cab-nota">Nessun avviso critico o di attenzione aperto.</p>;

  return (
    <aside className="cabina" aria-label="Cabina">
      <div className="ch">
        <h2>Avvisi</h2>
        {dati !== null && <span className="muted num">{dati.length} aperti</span>}
        <span className="sp" />
        <Link href="/console/avvisi">Tutti gli avvisi</Link>
      </div>
      {stato}
      {primi.map((a) => {
        const g = GRAVITA[a.gravita];
        const Icona = g.icona;
        const primaria = a.azioni[0];
        return (
          <div key={a.id} className={`alert ${g.classe}`}>
            <div className="al-top">
              <Icona size={16} strokeWidth={1.75} className="ico" aria-hidden="true" />
              {g.parola}
              {a.ultimoAt && <span className="when mono">{oraRoma(a.ultimoAt)}</span>}
            </div>
            <div className="al-t">
              <Link className="cab-link" href={`/console/avvisi#${a.id}`}>
                {a.titolo}
              </Link>{' '}
              <span className="mono cab-n">{a.conteggio}</span>
            </div>
            {primaria && (
              <div className="al-act">
                <FlussoAzione rif={primaria} onEseguita={() => void rileggi()} />
                {a.azioni.length > 1 && (
                  <Link className="btn ghost" href={`/console/avvisi#${a.id}`}>
                    Altre {a.azioni.length - 1} azioni…
                  </Link>
                )}
              </div>
            )}
          </div>
        );
      })}
      {children}
    </aside>
  );
}
