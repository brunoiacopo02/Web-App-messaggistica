// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { feniceOpening } from '@/lib/fenice-opening';
import { Simulatore } from './Simulatore';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function risposta(corpo: unknown, status = 200): Response {
  return new Response(JSON.stringify(corpo), { status, headers: { 'content-type': 'application/json' } });
}

function fetchFinto(risponde: () => Response) {
  const corpi: unknown[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url !== '/api/fenice/sim' || init?.method !== 'POST') throw new Error(`rotta inattesa ${init?.method} ${url}`);
    corpi.push(JSON.parse(String(init.body)));
    return risponde();
  }));
  return corpi;
}

async function scrivi(testo: string) {
  const campo = screen.getByRole('textbox', { name: 'Messaggio del lead' });
  await act(async () => {
    fireEvent.change(campo, { target: { value: testo } });
  });
  await act(async () => {
    fireEvent.keyDown(campo, { key: 'Enter' });
  });
}

it('parte dall\'apertura del template e manda a /api/fenice/sim la storia com\'era nel simulatore vecchio', async () => {
  vi.spyOn(Math, 'random').mockReturnValue(0); // attesa minima: 5 s
  const corpi = fetchFinto(() => risposta({ ok: true, visibleReply: 'Ciao!\nTi spiego subito.', appointmentFixed: false, passToHuman: false }));
  render(<Simulatore />);

  expect(screen.getByText(feniceOpening(), { normalizer: (s) => s })).toBeTruthy();
  await scrivi('Quanto costa?');

  expect(screen.getByText('Quanto costa?', { selector: '.b' })).toBeTruthy();
  expect(screen.getByRole('textbox', { name: 'Messaggio del lead' })).toHaveProperty('value', '');
  expect(screen.getByText(/Mario risponde tra/).textContent).toContain('5');
  expect(corpi).toHaveLength(0);

  // Un secondo messaggio nella finestra si accorpa: una sola chiamata con entrambi.
  await scrivi('E come funziona?');
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Rispondi ora' }));
  });
  expect(corpi).toEqual([{
    history: [
      { role: 'assistant', content: feniceOpening() },
      { role: 'user', content: 'Quanto costa?' },
      { role: 'user', content: 'E come funziona?' },
    ],
  }]);

  // Le bolle di Mario si spezzano sugli a-capo, con una breve pausa tra l'una e l'altra.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
  expect(screen.getByText('Ciao!')).toBeTruthy();
  expect(screen.getByText('Ti spiego subito.')).toBeTruthy();
});

it('un errore della rotta resta scritto nel thread', async () => {
  vi.spyOn(Math, 'random').mockReturnValue(0);
  fetchFinto(() => risposta({ ok: false, error: 'chiave Anthropic non valida' }, 502));
  render(<Simulatore />);

  await scrivi('Sì, sono interessato');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(screen.getByRole('alert').textContent).toContain('chiave Anthropic non valida');
});

it('una risposta rapida manda il messaggio e Ricomincia torna alla sola apertura', async () => {
  vi.spyOn(Math, 'random').mockReturnValue(0);
  fetchFinto(() => risposta({ ok: true, visibleReply: 'Perfetto', appointmentFixed: true, passToHuman: false }));
  render(<Simulatore />);

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Quanto costa?' }));
  });
  expect(screen.getByText('Quanto costa?', { selector: '.b' })).toBeTruthy();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(screen.getByText('Appuntamento fissato')).toBeTruthy();

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Ricomincia' }));
  });
  expect(screen.queryByText('Perfetto')).toBeNull();
  expect(screen.queryByText('Appuntamento fissato')).toBeNull();
  expect(document.querySelectorAll('.b')).toHaveLength(1);
});
