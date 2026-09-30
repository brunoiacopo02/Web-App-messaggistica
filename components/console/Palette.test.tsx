// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';

const push = vi.fn();
vi.mock('next/navigation', () => ({ usePathname: () => '/console/avvisi', useRouter: () => ({ push }) }));

const { Palette } = await import('./Palette');
const { AssistenteProvider, PannelloAssistente } = await import('./Assistente');
const { ComposerBridgeProvider } = await import('./ComposerBridge');
const { Composer } = await import('./Composer');

let fetchFinto: ReturnType<typeof vi.fn>;

beforeAll(() => {
  // cmdk misura e scorre la voce selezionata: jsdom non ha né ResizeObserver né scrollIntoView.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= () => {};
});

beforeEach(() => {
  push.mockReset();
  fetchFinto = vi.fn(async (url: string) => {
    if (url.startsWith('/api/console/cerca')) return Response.json({ righe: [{ id: 31, nome: 'Giulia Rossi', telefono: '+393331234567' }] });
    if (url === '/api/console/assistente') return new Response('data: {"tipo":"fine"}\n\n', { status: 200 });
    return Response.json({});
  });
  vi.stubGlobal('fetch', fetchFinto);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function monta(composer: { id: number; inPausa: boolean } | null = null) {
  const onCambia = vi.fn();
  render(
    <NuqsTestingAdapter>
      <div data-console>
        <ComposerBridgeProvider>
          <AssistenteProvider>
            {composer && (
              <Composer
                conversationId={composer.id}
                inPausa={composer.inPausa}
                lastInboundAt={null}
                now={new Date()}
                pausaInCorso={false}
                onPausa={() => {}}
                onInvia={async () => true}
              />
            )}
            <Palette aperto onCambia={onCambia} />
            <PannelloAssistente />
          </AssistenteProvider>
        </ComposerBridgeProvider>
      </div>
    </NuqsTestingAdapter>,
  );
  return { onCambia };
}

it("il testo digitato diventa \"Chiedi all'Assistente: …\" e parte subito nel pannello", async () => {
  const { onCambia } = monta();
  fireEvent.change(screen.getByPlaceholderText(/Vai a, cerca una chat/), { target: { value: 'perché 41 invii falliti' } });
  fireEvent.click(await screen.findByText("Chiedi all'Assistente: perché 41 invii falliti"));
  expect(onCambia).toHaveBeenCalledWith(false);
  await waitFor(() => expect(fetchFinto).toHaveBeenCalledWith('/api/console/assistente', expect.anything()));
  const corpo = JSON.parse(String((fetchFinto.mock.calls.find(([u]) => u === '/api/console/assistente') as [string, RequestInit])[1].body));
  expect(corpo.messaggi).toEqual([{ ruolo: 'utente', testo: 'perché 41 invii falliti' }]);
  expect(await screen.findByText('perché 41 invii falliti')).toBeTruthy();
});

it('cerca le chat con /api/console/cerca e porta alla chat scelta', async () => {
  monta();
  fireEvent.change(screen.getByPlaceholderText(/Vai a, cerca una chat/), { target: { value: 'rossi' } });
  fireEvent.click(await screen.findByText('Giulia Rossi', {}, { timeout: 2000 }));
  expect(fetchFinto).toHaveBeenCalledWith('/api/console/cerca?q=rossi', expect.anything());
  expect(push).toHaveBeenCalledWith('/console?chat=31');
});

it('pausa sulla chat aperta: passa dalla prova a vuoto, niente parte senza conferma', async () => {
  monta({ id: 5, inPausa: false });
  fireEvent.click(await screen.findByText('Metti in pausa Mario…'));
  expect(screen.getByRole('button', { name: 'Prova a vuoto: Metti in pausa Mario' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: /^Conferma/ })).toBeNull();
  const azioni = fetchFinto.mock.calls.filter(([u]) => String(u).startsWith('/api/console/azioni'));
  expect(azioni).toHaveLength(0);
});

it("senza chat aperta il gruppo delle azioni non c'è", async () => {
  monta();
  await act(async () => {});
  expect(screen.queryByText('Azioni sulla chat aperta')).toBeNull();
  expect(screen.queryByText('Metti in pausa Mario…')).toBeNull();
});

it("nessuna voce promette Ctrl K per l'Assistente: Ctrl+K apre la palette", async () => {
  const { SISTEMA } = await import('./Nav');
  expect(SISTEMA.find((s) => s.etichetta === 'Assistente')?.kbd).toBeUndefined();
  monta();
  const voce = screen.getByRole('option', { name: /^Assistente/ });
  expect(voce.querySelector('kbd')).toBeNull();
  // Le scorciatoie che la palette mostra sono tasti (<kbd>), non testo.
  expect(screen.getAllByText('Esc').every((e) => e.tagName === 'KBD')).toBe(true);
});
