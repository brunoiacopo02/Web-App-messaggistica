'use client';

import { useEffect, useRef } from 'react';

export interface GestoriTastiera {
  onSu?: () => void;
  onGiu?: () => void;
  onApri?: () => void;
  onEsc?: () => void;
  onPalette?: () => void;
  onScheda?: () => void;
  /** `/`: porta il focus sulla ricerca. */
  onCerca?: () => void;
}

function staScrivendo(t: EventTarget | null): boolean {
  if (!(t instanceof Element)) return false;
  if (t.closest('input, textarea, select')) return true;
  const ce = t.closest('[contenteditable]');
  return !!ce && ce.getAttribute('contenteditable') !== 'false';
}

/** Scorciatoie della console: j/k o frecce per scorrere, Enter apre, Escape chiude, `]` scheda
 *  lead, `/` ricerca, Ctrl/Cmd+K palette. Mentre si scrive in un campo tutto tace. Un solo listener
 *  su `document`; i gestori si leggono da un ref, così cambiarli non lo riaggancia. */
export function useTastiera(gestori: GestoriTastiera) {
  const ref = useRef(gestori);
  useEffect(() => {
    ref.current = gestori;
  });

  useEffect(() => {
    function suTasto(e: KeyboardEvent) {
      if (e.defaultPrevented || e.isComposing) return;
      if (staScrivendo(e.target) || staScrivendo(document.activeElement)) return;
      const g = ref.current;
      const mod = e.ctrlKey || e.metaKey;

      if (mod && !e.altKey && e.key.toLowerCase() === 'k') {
        if (!g.onPalette) return;
        e.preventDefault();
        g.onPalette();
        return;
      }
      if (mod || e.altKey) return;

      const azione: Record<string, (() => void) | undefined> = {
        j: g.onGiu, ArrowDown: g.onGiu,
        k: g.onSu, ArrowUp: g.onSu,
        Enter: g.onApri, Escape: g.onEsc, ']': g.onScheda, '/': g.onCerca,
      };
      const f = azione[e.key];
      if (!f) return;
      e.preventDefault();
      f();
    }
    document.addEventListener('keydown', suTasto);
    return () => document.removeEventListener('keydown', suTasto);
  }, []);
}
