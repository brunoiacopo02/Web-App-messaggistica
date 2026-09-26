'use client';

import { useState } from 'react';
import { useTastiera } from './useTastiera';

interface Opzioni {
  /** Id delle righe nell'ordine della lista. */
  ids: readonly number[];
  /** Vista + filtri: al cambio il cursore riparte da capo. */
  chiave: string;
  /** Chat aperta (dall'URL). */
  chat: number | null;
  apri: (id: number) => void;
  chiudi: () => void;
  onCerca?: () => void;
  /** Porta in vista la riga all'indice dato (scroll della lista virtualizzata). */
  mostra?: (indice: number) => void;
}

/**
 * Cursore da tastiera della lista chat, separato dalla chat aperta: j/k/frecce spostano solo
 * l'evidenziazione (niente fetch, niente "letto" su ogni chat attraversata); Invio apre la riga
 * evidenziata (o la prima, se non c'è né cursore né chat aperta); Escape chiude la chat aperta,
 * altrimenti toglie il cursore, altrimenti lascia il tasto al browser.
 */
export function useCursoreLista({ ids, chiave, chat, apri, chiudi, onCerca, mostra }: Opzioni) {
  const [stato, setStato] = useState<{ chiave: string; id: number } | null>(null);
  const cursore = stato && stato.chiave === chiave && ids.includes(stato.id) ? stato.id : null;

  function sposta(passo: 1 | -1): boolean {
    if (ids.length === 0) return false;
    const partenza = cursore ?? chat;
    const i = partenza == null ? -1 : ids.indexOf(partenza);
    const j = i < 0 ? 0 : Math.min(ids.length - 1, Math.max(0, i + passo));
    setStato({ chiave, id: ids[j] });
    mostra?.(j);
    return true;
  }

  useTastiera({
    onGiu: () => sposta(1),
    onSu: () => sposta(-1),
    onApri: () => {
      const id = cursore ?? (chat == null ? ids[0] : undefined);
      if (id == null) return false;
      apri(id);
      return true;
    },
    onEsc: () => {
      if (chat != null) {
        chiudi();
        return true;
      }
      if (cursore != null) {
        setStato(null);
        return true;
      }
      return false;
    },
    onCerca: onCerca
      ? () => {
          onCerca();
          return true;
        }
      : undefined,
  });

  return {
    cursore,
    /** Allinea il cursore a una riga aperta col clic, così j/k ripartono da lì. */
    punta: (id: number) => setStato({ chiave, id }),
  };
}
