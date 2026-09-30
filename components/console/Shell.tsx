'use client';

import { Suspense, useEffect, useState, type ReactNode } from 'react';
import { Toaster } from 'sonner';
import { SquareTerminal } from 'lucide-react';
import { TemaToggle, useTema } from './TemaToggle';
import { Nav } from './Nav';
import { BarraRegia } from './BarraRegia';
import { RegiaProvider } from './RegiaProvider';
import { AssistenteProvider, PannelloAssistente } from './Assistente';
import { ComposerBridgeProvider } from './ComposerBridge';
import { Palette } from './Palette';
import { Kbd } from './ui/Kbd';
import { useTastiera } from './useTastiera';

interface ShellProps {
  email: string;
  regia?: ReactNode;
  nav?: ReactNode;
  children: ReactNode;
}

/** Guscio della console: griglia a due righe (regia in alto, resto sotto) e due
 *  colonne nella riga inferiore (nav a sinistra, contenuto a destra). `regia` è la barra di regia
 *  (Task 8) e `nav` la navigazione delle viste (Task 6), se non se ne passano altre. Il
 *  `RegiaProvider` tiene un solo polling della regia per la barra e per le sotto-fasi della Nav.
 *  Qui vivono anche la palette (Ctrl+K), il pannello dell'Assistente e il ponte verso il composer. */
export function Shell({ email, regia, nav, children }: ShellProps) {
  const [tema] = useTema();
  const [palette, setPalette] = useState(false);
  // Mentre si scrive in un campo (il composer compreso) useTastiera tace: Ctrl+K resta al campo.
  useTastiera({ onPalette: () => setPalette(true) });

  const bottonePalette = (
    <button type="button" className="cmdbtn" onClick={() => setPalette(true)}>
      <SquareTerminal size={16} strokeWidth={1.75} className="ico" aria-hidden="true" />
      <span>Chiedi o cerca…</span>
      <Kbd>Ctrl K</Kbd>
    </button>
  );

  useEffect(() => {
    document.querySelector('[data-console]')?.setAttribute('data-theme', tema);
  }, [tema]);

  return (
    <RegiaProvider>
      <ComposerBridgeProvider>
        <AssistenteProvider>
          <div style={{ display: 'grid', gridTemplateRows: 'auto 1fr', height: '100%', minHeight: 0 }}>
            <div>{regia ?? <BarraRegia azioni={bottonePalette} />}</div>
            <div style={{ display: 'grid', gridTemplateColumns: '232px minmax(0, 1fr)', gridTemplateRows: 'minmax(0, 1fr)', minHeight: 0 }}>
              <nav className="nav" aria-label="Navigazione console">
                <div className="nav-voci">
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
          <PannelloAssistente />
          <Suspense fallback={null}>
            <Palette aperto={palette} onCambia={setPalette} />
          </Suspense>
        </AssistenteProvider>
      </ComposerBridgeProvider>
    </RegiaProvider>
  );
}
