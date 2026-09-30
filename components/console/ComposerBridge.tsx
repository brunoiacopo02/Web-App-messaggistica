'use client';

import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';

/** Il composer della chat aperta, visto da fuori (l'Assistente): di quale chat è, se Mario è in
 *  pausa, e come mettergli un testo nel campo. `impostaBozza` riempie soltanto: non invia mai. */
export type ComposerAperto = { conversationId: number; inPausa: boolean; impostaBozza: (testo: string) => void };

type Store = {
  registra: (c: ComposerAperto) => () => void;
  iscrivi: (f: () => void) => () => void;
  leggi: () => ComposerAperto | null;
};

function creaStore(): Store {
  let attuale: ComposerAperto | null = null;
  const ascoltatori = new Set<() => void>();
  const emetti = () => ascoltatori.forEach((f) => f());
  return {
    registra(c) {
      attuale = c;
      emetti();
      return () => {
        // Un composer smontato dopo che ne è montato un altro non cancella il nuovo.
        if (attuale !== c) return;
        attuale = null;
        emetti();
      };
    },
    iscrivi(f) {
      ascoltatori.add(f);
      return () => ascoltatori.delete(f);
    },
    leggi: () => attuale,
  };
}

const Ctx = createContext<Store | null>(null);

export function ComposerBridgeProvider({ children }: { children: ReactNode }) {
  const [store] = useState(creaStore);
  return <Ctx.Provider value={store}>{children}</Ctx.Provider>;
}

const nessuno = () => null;
const nienteDaAscoltare = () => () => {};

/** Il composer aperto in questo momento, o `null` (nessuna chat aperta, o fuori dal provider). */
export function useComposerBridge(): ComposerAperto | null {
  const store = useContext(Ctx);
  return useSyncExternalStore(store?.iscrivi ?? nienteDaAscoltare, store?.leggi ?? nessuno, nessuno);
}

/** Usato dal Composer: si registra finché è montato su una chat. Fuori dal provider non fa niente. */
export function useRegistraComposer(conversationId: number | undefined, inPausa: boolean, imposta: (testo: string) => void) {
  const store = useContext(Ctx);
  const impostaRef = useRef(imposta);
  useEffect(() => {
    impostaRef.current = imposta;
  });
  useEffect(() => {
    if (!store || conversationId == null) return;
    return store.registra({ conversationId, inPausa, impostaBozza: (t) => impostaRef.current(t) });
  }, [store, conversationId, inPausa]);
}

/** Dopo un'azione eseguita fuori dalla chat (palette, Assistente): la chat aperta rilegge subito il
 *  suo stato (Mario in pausa o no) invece di aspettare il giro di polling da 30 s. */
export const CHAT_CAMBIATA = 'console:chat-cambiata';

export function segnalaChatCambiata() {
  window.dispatchEvent(new Event(CHAT_CAMBIATA));
}
