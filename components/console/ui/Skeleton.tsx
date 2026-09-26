'use client';

import { useEffect, useState } from 'react';

interface SkeletonRigheProps {
  righe: number;
  altezza: number;
}

/** Skeleton a righe (regola 20 dell'anti-slop): compare solo dopo 200 ms, per non lampeggiare sui
 *  caricamenti rapidi. Chi la monta deve tenere `isLoading` vero per almeno 400 ms una volta apparsa
 *  (questo componente non può impedire uno smontaggio deciso dal chiamante). Niente `animate-pulse`:
 *  è un blocco statico sulla superficie sopra quella di sfondo. */
export function SkeletonRighe({ righe, altezza }: SkeletonRigheProps) {
  const [visibile, setVisibile] = useState(false);

  useEffect(() => {
    const id = setTimeout(() => setVisibile(true), 200);
    return () => clearTimeout(id);
  }, []);

  if (!visibile) return null;

  return (
    <div aria-hidden="true" style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      {Array.from({ length: righe }, (_, i) => (
        <div key={i} className="skel-riga" style={{ height: altezza }} />
      ))}
    </div>
  );
}
