'use client';

import { useEffect, useRef, useState } from 'react';

const RITARDO_COMPARSA = 200;
const DURATA_MINIMA = 400;

/** Anti-flicker dei caricamenti (regola 20 dell'anti-slop): torna `false` per i primi 200 ms di
 *  `caricamento`, poi `true`; una volta diventato visibile resta `true` per almeno 400 ms anche se
 *  `caricamento` torna `false` prima. Un caricamento che finisce entro i 200 ms non compare mai. Un
 *  nuovo caricamento (dopo che quello precedente è sparito) riparte da zero.
 *
 *  Lo stato cambia solo dentro callback di `setTimeout`, mai in modo sincrono nel corpo dell'effetto
 *  (regola `react-hooks/set-state-in-effect`): anche quando il tempo residuo è già zero, la modifica
 *  passa comunque da un timer (`setTimeout(fn, 0)`). */
export function useCaricamentoVisibile(caricamento: boolean): boolean {
  const [visibile, setVisibile] = useState(false);
  const mostratoAlRef = useRef<number | null>(null);

  useEffect(() => {
    if (caricamento) {
      const id = setTimeout(() => {
        mostratoAlRef.current = Date.now();
        setVisibile(true);
      }, RITARDO_COMPARSA);
      return () => clearTimeout(id);
    }

    if (mostratoAlRef.current === null) {
      // Non era ancora comparso (il timer di comparsa è stato ripulito dal cleanup sopra): niente da nascondere.
      return;
    }
    const trascorso = Date.now() - mostratoAlRef.current;
    const restante = Math.max(0, DURATA_MINIMA - trascorso);
    const id = setTimeout(() => {
      setVisibile(false);
      mostratoAlRef.current = null;
    }, restante);
    return () => clearTimeout(id);
  }, [caricamento]);

  return visibile;
}

interface SkeletonRigheProps {
  righe: number;
  altezza: number;
}

/** Skeleton a righe, puramente presentazionale: chi la usa decide quando montarla con
 *  `useCaricamentoVisibile`. Niente `animate-pulse`: un blocco statico sulla superficie sopra quella
 *  di sfondo. */
export function SkeletonRighe({ righe, altezza }: SkeletonRigheProps) {
  return (
    <div aria-hidden="true" style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      {Array.from({ length: righe }, (_, i) => (
        <div key={i} className="skel-riga" style={{ height: altezza }} />
      ))}
    </div>
  );
}
