'use client';

import { useEffect, useRef } from 'react';

/** Un gestore che restituisce `false` dice "non ho fatto niente": il tasto torna al browser
 *  (niente preventDefault). `undefined`/`true` = gestito. */
type Gestore = () => boolean | void;

export interface GestoriTastiera {
  onSu?: Gestore;
  onGiu?: Gestore;
  onApri?: Gestore;
  onEsc?: Gestore;
  onPalette?: Gestore;
  onScheda?: Gestore;
  /** `/`: porta il focus sulla ricerca. */
  onCerca?: Gestore;
}

/** Elementi che il browser attiva da solo con Invio: link, bottoni (righe della lista comprese,
 *  che col clic si aprono già), summary. Invio su di loro resta al browser. */
const ATTIVABILI = 'a[href], button, [role="button"], [role="link"], [role="menuitem"], [role="tab"], summary, input, select, textarea, [contenteditable]';

function suAttivabile(t: EventTarget | null): boolean {
  return t instanceof Element && !!t.closest(ATTIVABILI);
}

function staScrivendo(t: EventTarget | null): boolean {
  if (!(t instanceof Element)) return false;
  if (t.closest('input, textarea, select')) return true;
  const ce = t.closest('[contenteditable]');
  return !!ce && ce.getAttribute('contenteditable') !== 'false';
}

/** Palette, pannello dell'Assistente, sheet, dialog e menu aperti (Radix mette `data-state="open"`
 *  sul contenuto): finché uno è sopra, la lista dietro non si muove e Esc resta a lui. */
const OVERLAY_APERTO =
  '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], [role="menu"][data-state="open"], [aria-modal="true"]';

function overlayAperto(): boolean {
  return document.querySelector(OVERLAY_APERTO) !== null;
}

/** Scorciatoie della console: j/k o frecce per scorrere, Enter apre, Escape chiude, `]` scheda
 *  lead, `/` ricerca, Ctrl/Cmd+K palette. Mentre si scrive in un campo tutto tace, e con palette,
 *  pannello o dialog aperti tace tutto tranne Ctrl+K; Invio su un link
 *  o un bottone resta al browser. Il default si blocca solo se il gestore ha fatto qualcosa (un
 *  gestore che torna `false` lascia passare il tasto). Un solo listener su `document`; i gestori si
 *  leggono da un ref, così cambiarli non lo riaggancia. */
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
        if (g.onPalette && g.onPalette() !== false) e.preventDefault();
        return;
      }
      if (mod || e.altKey) return;
      // Con un overlay aperto j/k/Invio/Esc/]/ sono suoi (o del browser), non della lista dietro.
      if (overlayAperto()) return;

      const azione: Record<string, Gestore | undefined> = {
        j: g.onGiu, ArrowDown: g.onGiu,
        k: g.onSu, ArrowUp: g.onSu,
        Enter: g.onApri, Escape: g.onEsc, ']': g.onScheda, '/': g.onCerca,
      };
      const f = azione[e.key];
      if (!f) return;
      if (e.key === 'Enter' && suAttivabile(e.target)) return;
      if (f() !== false) e.preventDefault();
    }
    document.addEventListener('keydown', suTasto);
    return () => document.removeEventListener('keydown', suTasto);
  }, []);
}
