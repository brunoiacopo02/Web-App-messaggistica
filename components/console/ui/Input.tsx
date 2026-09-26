'use client';

import type { InputHTMLAttributes, ReactNode } from 'react';

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Icona o kbd a sinistra/destra del campo (es. lente di ricerca, `/`). */
  prima?: ReactNode;
  dopo?: ReactNode;
}

/** Campo di testo della console: contenitore `.field` con bordo e sfondo dei token, input trasparente dentro. */
export function Input({ prima, dopo, className, ...rest }: InputProps) {
  return (
    <div className={['field', className].filter(Boolean).join(' ')}>
      {prima}
      <input {...rest} />
      {dopo}
    </div>
  );
}
