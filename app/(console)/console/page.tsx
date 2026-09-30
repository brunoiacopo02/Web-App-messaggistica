import { Suspense } from 'react';
import { ListaChat } from '@/components/console/ListaChat';
import { ChatAperta } from '@/components/console/ChatAperta';

/** Banco di lavoro: lista 360 px | thread | cabina 320 px (avvisi urgenti e scheda lead, in `ChatAperta`). */
export default function ConsolePage() {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '360px minmax(0,1fr) 320px', height: '100%', minHeight: 0 }}>
      <Suspense fallback={<section className="list" aria-busy="true" />}>
        <ListaChat />
      </Suspense>
      <Suspense
        fallback={
          <>
            <section className="thread" aria-label="Conversazione" />
            <aside className="cabina" aria-label="Cabina" />
          </>
        }
      >
        <ChatAperta />
      </Suspense>
    </div>
  );
}
