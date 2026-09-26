'use client';

import type { ButtonHTMLAttributes } from 'react';

type Variante = 'normale' | 'primario' | 'fantasma' | 'pericolo';

const CLASSE: Record<Variante, string> = {
  normale: 'btn',
  primario: 'btn pri',
  fantasma: 'btn ghost',
  pericolo: 'btn danger',
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variante?: Variante;
  /** Disabilita il bottone e mostra aria-busy, senza cambiare il testo (niente spinner che sposta il layout). */
  caricamento?: boolean;
}

/** Bottone della console: classi `.btn`/`.btn.pri`/`.btn.ghost`/`.btn.danger` del mockup. */
export function Button({
  variante = 'normale',
  caricamento = false,
  className,
  disabled,
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      type="button"
      {...rest}
      className={[CLASSE[variante], className].filter(Boolean).join(' ')}
      disabled={disabled || caricamento}
      aria-busy={caricamento || undefined}
    >
      {children}
    </button>
  );
}
