// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ usePathname: () => '/console' }));

const { AssistenteProvider, PannelloAssistente, useApriAssistente } = await import('./Assistente');
const { ComposerBridgeProvider } = await import('./ComposerBridge');
const { Composer } = await import('./Composer');

const enc = new TextEncoder();
const riga = (e: unknown) => `data: ${JSON.stringify(e)}\n\n`;

function sse(eventi: unknown[]) {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const e of eventi) c.enqueue(enc.encode(riga(e)));
        c.close();
      },
    }),
    { status: 200 },
  );
}

const PROPOSTA = { azione: 'pausa_mario', params: { conversationId: 7 }, etichetta: 'Metti in pausa Mario' };
let fetchFinto: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchFinto = vi.fn(async (url: string) => {
    if (url === '/api/console/assistente') {
      return sse([
        { tipo: 'strumento', nome: 'leggi_chat', sintesi: 'Letta la chat 7' },
        { tipo: 'proposta', proposta: PROPOSTA },
        { tipo: 'bozza', bozza: { conversationId: 7, testo: 'Ciao Giulia, ti scrivo io.' } },
        { tipo: 'testo', testo: 'Mario ha smesso di rispondere alle 20:38.' },
        { tipo: 'citazioni', citazioni: [{ tipo: 'chat', id: 7, etichetta: 'Giulia Rossi' }, { tipo: 'avviso', id: 'crm:403', etichetta: 'Esiti rifiutati' }] },
        { tipo: 'fine' },
      ]);
    }
    if (url === '/api/console/viste') return Response.json({ conteggi: { errori: 41, serve_te: 2 } });
    if (url === '/api/console/avvisi') return Response.json({ avvisi: [] });
    return new Response('{}', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchFinto);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function Apri({ domanda }: { domanda?: string }) {
  const { apri } = useApriAssistente();
  return (
    <button type="button" onClick={() => apri(domanda)}>
      apri
    </button>
  );
}

function monta(conComposer: { id: number; inPausa: boolean } | null) {
  return render(
    <div data-console>
      <ComposerBridgeProvider>
        <AssistenteProvider>
          <Apri domanda="Com'è andata la chat 7?" />
          {conComposer && (
            <Composer
              conversationId={conComposer.id}
              inPausa={conComposer.inPausa}
              lastInboundAt={new Date().toISOString()}
              now={new Date()}
              pausaInCorso={false}
              onPausa={() => {}}
              onInvia={async () => true}
            />
          )}
          <PannelloAssistente />
        </AssistenteProvider>
      </ComposerBridgeProvider>
    </div>,
  );
}

async function chiedi() {
  fireEvent.click(screen.getByText('apri'));
  const campo = (await screen.findByLabelText("Domanda all'Assistente")) as HTMLTextAreaElement;
  // apri(domanda) precompila il campo: non parte finché l'admin non chiede.
  expect(campo.value).toBe("Com'è andata la chat 7?");
  expect(fetchFinto).not.toHaveBeenCalledWith('/api/console/assistente', expect.anything());
  await act(async () => {
    fireEvent.keyDown(campo, { key: 'Enter' });
  });
  await screen.findByText('Mario ha smesso di rispondere alle 20:38.');
}

it('proposta: solo il flusso con prova a vuoto, nessun bottone che conferma subito', async () => {
  monta(null);
  await chiedi();
  expect(screen.getByRole('button', { name: 'Prova a vuoto: Metti in pausa Mario' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: /^Conferma/ })).toBeNull();
  expect(fetchFinto).not.toHaveBeenCalledWith('/api/console/azioni/esegui', expect.anything());
  expect(fetchFinto).not.toHaveBeenCalledWith('/api/console/azioni/anteprima', expect.anything());
});

it('citazioni: chat verso ?chat=id, avviso verso /console/avvisi#id; il passo mostra la sintesi', async () => {
  monta(null);
  await chiedi();
  expect(screen.getByText('Letta la chat 7')).toBeTruthy();
  const fonti = screen.getByLabelText('Fonti');
  const link = Array.from(fonti.querySelectorAll('a')).map((a) => a.getAttribute('href'));
  expect(link).toEqual(['/console?chat=7', '/console/avvisi#crm%3A403']);
});

it('bozza senza la chat aperta: niente "Metti nel composer", solo il link alla chat', async () => {
  monta(null);
  await chiedi();
  expect(screen.queryByRole('button', { name: 'Metti nel composer' })).toBeNull();
  expect(screen.getByRole('link', { name: 'Apri la chat 7…' })).toBeTruthy();
});

it('bozza con la chat aperta e Mario in pausa: riempie il composer e non invia', async () => {
  monta({ id: 7, inPausa: true });
  await chiedi();
  fireEvent.click(screen.getByRole('button', { name: 'Metti nel composer' }));
  const composer = screen.getByLabelText('Messaggio al lead') as HTMLTextAreaElement;
  expect(composer.value).toBe('Ciao Giulia, ti scrivo io.');
  await waitFor(() => expect(screen.queryByLabelText("Domanda all'Assistente")).toBeNull());
  const inviati = fetchFinto.mock.calls.filter(([u]) => String(u).includes('/api/chat/messages'));
  expect(inviati).toHaveLength(0);
});

it('bozza su un altra chat aperta: il bottone non compare', async () => {
  monta({ id: 9, inPausa: true });
  await chiedi();
  expect(screen.queryByRole('button', { name: 'Metti nel composer' })).toBeNull();
});
