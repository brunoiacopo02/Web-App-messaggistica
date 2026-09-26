'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { MouseEvent } from 'react';
import {
  Archive, Bell, Bot, CalendarCheck, ChartLine, Clapperboard, FlaskConical, Headset, Inbox,
  Megaphone, RadioTower, ScrollText, Send, Settings, SquareTerminal, TriangleAlert, UserRound,
  type LucideIcon,
} from 'lucide-react';
import { VISTA_META, type Vista } from '@/lib/console/viste';
import { Kbd } from './ui/Kbd';
import { useConteggi } from './useConteggi';
import { useStatoConsole } from './statoUrl';

const ICONA_VISTA: Record<Vista, LucideIcon> = {
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

const GRUPPI: { titolo: string; viste: Vista[] }[] = [
  { titolo: 'Priorità', viste: ['serve_te', 'non_lette', 'errori'] },
  { titolo: 'Lancio 5/10', viste: ['lancio'] },
  { titolo: 'Mondi', viste: ['fissati_bot', 'mario', 'gdo', 'campagne', 'chiuse'] },
];

const SISTEMA: { etichetta: string; href: string; icona: LucideIcon; kbd?: string }[] = [
  { etichetta: 'Avvisi', href: '/console/avvisi', icona: Bell },
  { etichetta: 'Lancio', href: '/console/lancio', icona: Clapperboard },
  { etichetta: 'Assistente', href: '/console/assistente', icona: SquareTerminal, kbd: 'Ctrl K' },
  { etichetta: 'Impostazioni', href: '/console/impostazioni', icona: Settings },
  { etichetta: 'Analisi', href: '/console/analisi', icona: ChartLine },
  { etichetta: 'Simulatore', href: '/console/simulatore', icona: FlaskConical },
  { etichetta: 'Campagne', href: '/console/campagne', icona: Send },
  { etichetta: 'Log', href: '/console/log', icona: ScrollText },
];

const COLONNA = { display: 'flex', flexDirection: 'column', gap: 1 } as const;

const fmt = new Intl.NumberFormat('it-IT');

const conModificatori = (e: MouseEvent) => e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0;

/** Colonna di navigazione: viste con contatore (polling condiviso di `useConteggi`) e pagine di
 *  sistema. Sulla pagina `/console` il cambio vista resta sul client (nuqs, niente giro dal server);
 *  altrove il link porta a `/console?vista=…`. */
export function Nav() {
  const pathname = usePathname();
  const suConsole = pathname === '/console';
  const [{ vista, fase }, setStato] = useStatoConsole();
  const { conteggi } = useConteggi();

  function vai(e: MouseEvent, v: Vista) {
    if (!suConsole || conModificatori(e)) return;
    e.preventDefault();
    void setStato({ vista: v, fase: null, q: null });
  }

  return (
    <>
      {GRUPPI.map((g) => (
        <div key={g.titolo} style={COLONNA}>
          <div className="grp">{g.titolo}</div>
          {g.viste.map((v) => {
            const Icona = ICONA_VISTA[v];
            const n = conteggi?.[v];
            const urgente = VISTA_META[v].urgente && (n ?? 0) > 0;
            const corrente = suConsole && vista === v && !fase;
            return (
              <Link
                key={v}
                href={`/console?vista=${v}`}
                className={v === 'lancio' ? 'nv live' : 'nv'}
                aria-current={corrente ? 'page' : undefined}
                onClick={(e) => vai(e, v)}
              >
                <Icona size={16} strokeWidth={1.75} className="ico" aria-hidden="true" />
                <span>{VISTA_META[v].etichetta}</span>
                <span className={urgente ? 'c urg' : 'c'} aria-label={n === undefined ? undefined : `${n} chat`}>
                  {n === undefined ? '' : fmt.format(n)}
                </span>
              </Link>
            );
          })}
        </div>
      ))}

      <div style={COLONNA}>
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
