'use client';

import { toast as sonnerToast } from 'sonner';

/** Notifiche della console (sonner, montato in `Shell.tsx`). Il testo riprende il verbo dell'azione
 *  ("Rinvia esiti" → "Esiti rinviati"), mai un messaggio generico. */
export const toast = {
  ok: (testo: string) => sonnerToast.success(testo),
  errore: (testo: string) => sonnerToast.error(testo),
};
