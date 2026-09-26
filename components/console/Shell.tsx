'use client';

import { Suspense, useEffect, type ReactNode } from 'react';
import { Toaster } from 'sonner';
import { TemaToggle, useTema } from './TemaToggle';
import { Nav } from './Nav';
import { BarraRegia } from './BarraRegia';
import { RegiaProvider } from './RegiaProvider';

interface ShellProps {
  email: string;
  regia?: ReactNode;
  nav?: ReactNode;
  children: ReactNode;
}

/** Guscio della console: griglia a due righe (regia in alto, resto sotto) e due
 *  colonne nella riga inferiore (nav a sinistra, contenuto a destra). `regia` è la barra di regia
 *  (Task 8) e `nav` la navigazione delle viste (Task 6), se non se ne passano altre. Il
 *  `RegiaProvider` tiene un solo polling della regia per la barra e per le sotto-fasi della Nav. */
export function Shell({ email, regia, nav, children }: ShellProps) {
  const [tema] = useTema();

  useEffect(() => {
    document.querySelector('[data-console]')?.setAttribute('data-theme', tema);
  }, [tema]);

  return (
    <RegiaProvider>
      <div style={{ display: 'grid', gridTemplateRows: 'auto 1fr', height: '100%', minHeight: 0 }}>
        <div>{regia ?? <BarraRegia />}</div>
        <div style={{ display: 'grid', gridTemplateColumns: '232px 1fr', minHeight: 0 }}>
          <nav className="nav" aria-label="Navigazione console">
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 1 }}>
              {nav ?? (
                <Suspense fallback={null}>
                  <Nav />
                </Suspense>
              )}
            </div>
            <div className="foot">
              <span className="dot-ok" aria-hidden="true" />
              <span className="mono muted" style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {email}
              </span>
              <TemaToggle />
            </div>
          </nav>
          <div style={{ minWidth: 0, minHeight: 0, overflow: 'auto' }}>{children}</div>
        </div>
        <Toaster
          className="toaster"
          theme={tema}
          position="bottom-right"
          richColors
          closeButton
        />
      </div>
    </RegiaProvider>
  );
}
