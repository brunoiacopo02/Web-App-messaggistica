'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Fragment, type MouseEvent } from 'react';
import {
  Archive, Bell, Bot, CalendarCheck, ChartLine, Clapperboard, FlaskConical, Headset, Inbox,
  Megaphone, RadioTower, ScrollText, Send, Settings, SquareTerminal, TriangleAlert, UserRound,
  type LucideIcon,
} from 'lucide-react';
import { ETICHETTA_FASE, VISTA_META, type Vista } from '@/lib/console/viste';
import type { LancioFase } from '@/lib/lancio-fase';
import { Kbd } from './ui/Kbd';
import { useConteggi } from './useConteggi';
import { useStatoConsole } from './statoUrl';
import { useRegia } from './RegiaProvider';
import { Cifre } from './ui/Cifre';

export const ICONA_VISTA: Record<Vista, LucideIcon> = {
  serve_te: UserRound,
  non_lette: Inbox,
  errori: TriangleAlert,
  lancio: RadioTower,
  fissati_bot: CalendarCheck,
  mario: Bot,
  gdo: Headset,
  campagne: Megaphone,
  chiuse: Archive,
};

/** Il primo gruppo non ha titolo, come nel mockup: sono le viste di ogni giorno, in cima. */
export const GRUPPI: { titolo: string | null; viste: Vista[] }[] = [
  { titolo: null, viste: ['serve_te', 'non_lette', 'errori'] },
  { titolo: 'Lancio 5/10', viste: ['lancio'] },
  { titolo: 'Mondi', viste: ['fissati_bot', 'mario', 'gdo', 'campagne', 'chiuse'] },
];

/** `kbd` solo per una scorciatoia vera, che porta proprio lì: Ctrl+K apre la palette, non
 *  l'Assistente, e per questo l'Assistente non ne ha. La palette mostra la stessa `kbd`. */
export const SISTEMA: { etichetta: string; href: string; icona: LucideIcon; kbd?: string }[] = [
  { etichetta: 'Avvisi', href: '/console/avvisi', icona: Bell },
  { etichetta: 'Lancio', href: '/console/lancio', icona: Clapperboard },
  { etichetta: 'Assistente', href: '/console/assistente', icona: SquareTerminal },
  { etichetta: 'Impostazioni', href: '/console/impostazioni', icona: Settings },
  { etichetta: 'Analisi', href: '/console/analisi', icona: ChartLine },
  { etichetta: 'Simulatore', href: '/console/simulatore', icona: FlaskConical },
  { etichetta: 'Campagne', href: '/console/campagne', icona: Send },
  { etichetta: 'Log', href: '/console/log', icona: ScrollText },
];

/** Le sotto-fasi del lancio mostrate sotto "Lancio" (le terminali e il follow-up restano nella vista). */
const SOTTO_FASI: LancioFase[] = ['attesa', 'posto_bloccato', 'link_inviato', 'post_pitch', 'scelta_fatta'];


const conModificatori = (e: MouseEvent) => e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0;

/** Colonna di navigazione: viste con contatore (polling condiviso di `useConteggi`) e pagine di
 *  sistema. Sulla pagina `/console` il cambio vista resta sul client (nuqs, niente giro dal server);
 *  altrove il link porta a `/console?vista=…`. */
export function Nav() {
  const pathname = usePathname();
  const suConsole = pathname === '/console';
  const [{ vista, fase }, setStato] = useStatoConsole();
  const { conteggi } = useConteggi();
  const { regia } = useRegia();
  const perFase = regia?.attivo ? regia.perFase : null;
  const iscritti = regia?.numeri.iscritti ?? 0;

  function vai(e: MouseEvent, v: Vista) {
    if (!suConsole || conModificatori(e)) return;
    e.preventDefault();
    void setStato({ vista: v, fase: null, q: null, solo: null });
  }

  function vaiAFase(e: MouseEvent, f: LancioFase) {
    if (!suConsole || conModificatori(e)) return;
    e.preventDefault();
    void setStato({ vista: 'lancio', fase: f, q: null, solo: null });
  }

  return (
    <>
      {GRUPPI.map((g) => (
        <div key={g.titolo ?? 'priorita'} className="nav-grp">
          {g.titolo ? <div className="grp">{g.titolo}</div> : null}
          {g.viste.map((v) => {
            const Icona = ICONA_VISTA[v];
            const n = conteggi?.[v];
            const urgente = VISTA_META[v].urgente && (n ?? 0) > 0;
            const corrente = suConsole && vista === v && !fase;
            return (
              <Fragment key={v}>
                <Link
                  href={`/console?vista=${v}`}
                  className={v === 'lancio' ? 'nv live' : 'nv'}
                  aria-current={corrente ? 'page' : undefined}
                  onClick={(e) => vai(e, v)}
                >
                  <Icona size={16} strokeWidth={1.75} className="ico" aria-hidden="true" />
                  <span>{VISTA_META[v].etichetta}</span>
                  <span className={urgente ? 'c urg' : 'c'} aria-label={n === undefined ? undefined : `${n} chat`}>
                    {n === undefined ? '' : <Cifre n={n} />}
                  </span>
                </Link>
                {v === 'lancio' && perFase ? (
                  <div className="phases">
                    {SOTTO_FASI.map((f) => {
                      const nf = perFase[f] ?? 0;
                      const larghezza = iscritti > 0 ? Math.round((nf / iscritti) * 100) : 0;
                      return (
                        <Link
                          key={f}
                          href={`/console?vista=lancio&fase=${f}`}
                          className="ph"
                          aria-current={suConsole && vista === 'lancio' && fase === f ? 'page' : undefined}
                          onClick={(e) => vaiAFase(e, f)}
                        >
                          <span>{ETICHETTA_FASE[f]}</span>
                          <span className="t" aria-hidden="true"><i style={{ width: `${larghezza}%` }} /></span>
                          <span className="n" aria-label={`${nf} chat`}><Cifre n={nf} /></span>
                        </Link>
                      );
                    })}
                  </div>
                ) : null}
              </Fragment>
            );
          })}
        </div>
      ))}

      <div className="nav-grp">
        <div className="grp">Sistema</div>
        {SISTEMA.map((s) => {
          const Icona = s.icona;
          return (
            <Link key={s.href} href={s.href} className="nv" aria-current={pathname === s.href ? 'page' : undefined}>
              <Icona size={16} strokeWidth={1.75} className="ico" aria-hidden="true" />
              <span>{s.etichetta}</span>
              {s.kbd ? <Kbd>{s.kbd}</Kbd> : <span />}
            </Link>
          );
        })}
      </div>
    </>
  );
}
