import type { ReactNode } from 'react';

/** Tasto di scorciatoia, stile del mockup (selettore globale `kbd` in console.css). */
export function Kbd({ children }: { children: ReactNode }) {
  return <kbd>{children}</kbd>;
}
