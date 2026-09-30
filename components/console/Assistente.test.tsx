// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const cerca = vi.hoisted(() => ({ qs: '' }));
vi.mock('next/navigation', () => ({ usePathname: () => '/console', useSearchParams: () => new URLSearchParams(cerca.qs) }));

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
  cerca.qs = '';
});

function Apri({ domanda }: { domanda?: string }) {
  const { apri } = useApriAssistente();
  return (
    <button type="button" onClick={() => apri(domanda)}>
      apri
    </button>
  );
}

function monta(conComposer: { id: number; inPausa: boolean; lastInboundAt?: string } | null) {
  return render(
    <div data-console>
      <ComposerBridgeProvider>
        <AssistenteProvider>
          <Apri domanda="Com'è andata la chat 7?" />
          {conComposer && (
            <Composer
              conversationId={conComposer.id}
              inPausa={conComposer.inPausa}
              lastInboundAt={conComposer.lastInboundAt ?? new Date().toISOString()}
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

it('bozza con la finestra 24h chiusa: niente "Metti nel composer" né toast, dice perché', async () => {
  const dueGiorniFa = new Date(Date.now() - 48 * 3600_000).toISOString();
  monta({ id: 7, inPausa: true, lastInboundAt: dueGiorniFa });
  await chiedi();
  expect(screen.queryByRole('button', { name: 'Metti nel composer' })).toBeNull();
  expect(screen.getByText(/finestra 24h di questa chat è chiusa/)).toBeTruthy();
  expect((screen.getByLabelText('Messaggio al lead') as HTMLTextAreaElement).value).toBe('');
});

function ApriEInvia({ domanda }: { domanda: string }) {
  const { apri } = useApriAssistente();
  return (
    <button type="button" onClick={() => apri(domanda, { invia: true })}>
      {`invia ${domanda}`}
    </button>
  );
}

it('apri(domanda, { invia: true }) con un turno in corso precompila il campo invece di perdere la domanda', async () => {
  // Uno stream che non finisce mai: il primo turno resta in corso.
  fetchFinto.mockImplementation(async (url: string) => {
    if (url === '/api/console/assistente') {
      return new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(enc.encode(riga({ tipo: 'testo', testo: 'Sto...' }))); } }), { status: 200 });
    }
    if (url === '/api/console/viste') return Response.json({ conteggi: {} });
    if (url === '/api/console/avvisi') return Response.json({ avvisi: [] });
    return new Response('{}', { status: 404 });
  });
  render(
    <div data-console>
      <ComposerBridgeProvider>
        <AssistenteProvider>
          <ApriEInvia domanda="prima" />
          <ApriEInvia domanda="seconda" />
          <PannelloAssistente />
        </AssistenteProvider>
      </ComposerBridgeProvider>
    </div>,
  );
  await act(async () => {
    fireEvent.click(screen.getByText('invia prima'));
  });
  await screen.findByText('Sto...');
  await act(async () => {
    fireEvent.click(screen.getByText('invia seconda'));
  });
  const campo = screen.getByLabelText("Domanda all'Assistente") as HTMLTextAreaElement;
  expect(campo.value).toBe('seconda');
  const chiamate = fetchFinto.mock.calls.filter(([u]) => u === '/api/console/assistente');
  expect(chiamate).toHaveLength(1);
});

it('i suggerimenti leggono gli avvisi una volta, senza polling', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    monta(null);
    fireEvent.click(screen.getByText('apri'));
    await screen.findByLabelText("Domanda all'Assistente");
    await act(async () => {
      vi.advanceTimersByTime(95_000);
    });
    const letture = fetchFinto.mock.calls.filter(([u]) => u === '/api/console/avvisi');
    expect(letture).toHaveLength(1);
  } finally {
    vi.useRealTimers();
  }
});

it('la fonte chat e la bozza tengono la vista in cui si è', async () => {
  cerca.qs = 'vista=lancio&fase=attesa&chat=3';
  monta(null);
  await chiedi();
  const link = Array.from(screen.getByLabelText('Fonti').querySelectorAll('a')).map((a) => a.getAttribute('href'));
  expect(link[0]).toBe('/console?vista=lancio&fase=attesa&chat=7');
  expect(screen.getByRole('link', { name: 'Apri la chat 7…' }).getAttribute('href')).toBe('/console?vista=lancio&fase=attesa&chat=7');
});
