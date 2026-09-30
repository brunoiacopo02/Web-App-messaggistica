import { Suspense } from 'react';
import { Analisi } from '@/components/console/sezioni/Analisi';

/** Segmenti dei lead di Mario, report di conversione e analisi AI (porta `/fenice/lead`). */
export default function AnalisiPage() {
  return (
    <Suspense fallback={<div className="avv an" aria-busy="true" />}>
      <Analisi />
    </Suspense>
  );
}
