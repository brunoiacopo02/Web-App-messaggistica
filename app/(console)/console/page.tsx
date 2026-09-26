import { Suspense } from 'react';
import { ListaChat } from '@/components/console/ListaChat';
import { Vuoto } from '@/components/console/ui/Stato';

/** Banco di lavoro: lista 360 px | thread | cabina 320 px. Thread e cabina arrivano nei Task 7 e 11. */
export default function ConsolePage() {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '360px minmax(0,1fr) 320px', height: '100%', minHeight: 0 }}>
      <Suspense fallback={<section className="list" aria-busy="true" />}>
        <ListaChat />
      </Suspense>
      <section className="thread" aria-label="Conversazione">
        <Vuoto titolo="Seleziona una chat" testo="La conversazione si apre qui. Scorri la lista con j e k, apri con Invio." />
      </section>
      <aside className="cabina" aria-label="Cabina" />
    </div>
  );
}
