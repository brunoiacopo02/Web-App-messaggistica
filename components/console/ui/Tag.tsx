import type { ReactNode } from 'react';

export type Tono = 'neutro' | 'urgente' | 'errore' | 'attesa' | 'ok' | 'onda';

/** Badge di solo testo: lo stato non si comunica mai col solo colore (regola 4 dell'anti-slop). */
export function Tag({ tono, children }: { tono: Tono; children: ReactNode }) {
  return <span className={`tag ${tono}`}>{children}</span>;
}
