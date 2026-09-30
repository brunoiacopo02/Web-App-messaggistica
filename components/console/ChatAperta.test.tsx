// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DettaglioChat } from '@/lib/console/thread';

// Il thread vero non serve: basta vedere quanti eventi riceve.
vi.mock('./Thread', () => ({
  Thread: ({ dettaglio }: { dettaglio: DettaglioChat }) => <p data-testid="eventi">{dettaglio.eventi.length} eventi</p>,
}));
vi.mock('./SchedaLead', () => ({ SchedaLead: () => null }));
vi.mock('./Cabina', () => ({ Cabina: ({ children }: { children?: React.ReactNode }) => <>{children}</> }));
vi.mock('./useConteggi', () => ({ rinfrescaConteggi: () => {} }));

const { ChatAperta } = await import('./ChatAperta');
const { CHAT_CAMBIATA } = await import('./ComposerBridge');

const EVENTO = { at: '2026-10-05T19:20:00Z', tipo: 'bot_paused', testo: '', livello: 'warn' };

function dettaglio(saltati: boolean): DettaglioChat {
  return {
    conv: {
      id: 42, aiOwner: 'mario', aiStatus: 'active', aiPausedAt: null, botOutcome: null, botScheduledAt: null,
      lancioFase: null, lancioSlug: null, waNumber: null, crmLeadId: null, aiSummary: null, handedOffReason: null,
      lastInboundAt: null, mondo: 'MARIO', unreadCount: 0, contesto: null,
    },
    lead: { id: 1, nome: 'Giulia', telefono: null },
    crm: null,
    eventi: saltati ? [] : [EVENTO],
    eventiParziali: false,
    eventiSaltati: saltati,
  };
}

let chiamate: string[];

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  chiamate = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      chiamate.push(url);
      if (url.includes('/messaggi')) return Response.json({ messaggi: [] });
      return Response.json(dettaglio(url.includes('eventi=0')));
    }),
  );
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const monta = () =>
  render(
    <NuqsTestingAdapter searchParams="?chat=42">
      <div data-console>
        <ChatAperta />
      </div>
    </NuqsTestingAdapter>,
  );

const letture = () => chiamate.filter((u) => /^\/api\/console\/chat\/42(\?|$)/.test(u));

it("all'apertura legge il dettaglio con gli eventi", async () => {
  monta();
  expect(await screen.findByText('1 eventi')).toBeTruthy();
  expect(letture()).toEqual(['/api/console/chat/42']);
});

it('il polling del dettaglio salta gli eventi e non svuota quelli già in pagina', async () => {
  monta();
  await screen.findByText('1 eventi');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30_000);
  });
  expect(letture()).toEqual(['/api/console/chat/42', '/api/console/chat/42?eventi=0']);
  expect(screen.getByTestId('eventi').textContent).toBe('1 eventi');
});

it('dopo CHAT_CAMBIATA rilegge anche gli eventi', async () => {
  monta();
  await screen.findByText('1 eventi');
  await act(async () => {
    window.dispatchEvent(new Event(CHAT_CAMBIATA));
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(letture()).toEqual(['/api/console/chat/42', '/api/console/chat/42']);
});
