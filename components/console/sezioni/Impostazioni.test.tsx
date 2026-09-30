// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { LANCIO_SETTINGS_DEFAULT, type LancioSettings } from '@/lib/lancio-settings';
import { Impostazioni } from './Impostazioni';

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

const iniziali: LancioSettings = { ...LANCIO_SETTINGS_DEFAULT, attivo: true, zoomLink: 'https://zoom.us/j/1' };

function risposta(corpo: unknown, status = 200): Response {
  return new Response(JSON.stringify(corpo), { status, headers: { 'content-type': 'application/json' } });
}

type Chiamata = { url: string; metodo: string; body: unknown };

/** `fetch` finto: una funzione per "METODO url", e la lista delle chiamate con il corpo già letto. */
function fetchFinto(rotte: Record<string, (body: unknown) => Response>) {
  const chiamate: Chiamata[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const metodo = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    chiamate.push({ url, metodo, body });
    const r = rotte[`${metodo} ${url}`];
    if (!r) throw new Error(`rotta inattesa ${metodo} ${url}`);
    return r(body);
  }));
  return chiamate;
}

function monta(extra: Partial<Parameters<typeof Impostazioni>[0]> = {}) {
  render(<Impostazioni initial={iniziali} autoReply cambi={{}} puoModificare {...extra} />);
}

async function clic(el: HTMLElement) {
  await act(async () => {
    fireEvent.click(el);
  });
}

it('spegnere lancio_attivo apre la conferma con prima → dopo, e solo confermato chiama la rotta', async () => {
  const chiamate = fetchFinto({
    'POST /api/fenice/lancio-settings': () => risposta({ ok: true, key: 'lancio_attivo', value: false, audit: true }),
  });
  monta();

  await clic(screen.getByRole('switch', { name: 'Lancio attivo' }));
  expect(chiamate).toHaveLength(0);
  const conferma = screen.getByRole('group', { name: 'Conferma Lancio attivo' });
  expect(conferma.textContent).toContain('Spegnere');
  expect(conferma.textContent).toContain('Acceso → Spento');

  await clic(screen.getByRole('button', { name: 'Sì, spegni' }));
  expect(chiamate).toEqual([{ url: '/api/fenice/lancio-settings', metodo: 'POST', body: { key: 'lancio_attivo', value: false } }]);
  expect(screen.getByText(/^Salvato/).textContent).toContain('Acceso → Spento');
  expect(screen.getByRole('switch', { name: 'Lancio attivo' }).getAttribute('aria-checked')).toBe('false');
});

it('Annulla non chiama nulla e lascia l\'interruttore com\'era', async () => {
  const chiamate = fetchFinto({});
  monta();
  await clic(screen.getByRole('switch', { name: 'Lancio attivo' }));
  await clic(screen.getByRole('button', { name: 'Annulla' }));
  expect(chiamate).toHaveLength(0);
  expect(screen.queryByRole('group', { name: 'Conferma Lancio attivo' })).toBeNull();
  expect(screen.getByRole('switch', { name: 'Lancio attivo' }).getAttribute('aria-checked')).toBe('true');
});

it('una risposta 500 mostra "Non salvato", mai "Salvato", e l\'interruttore resta acceso', async () => {
  fetchFinto({ 'POST /api/fenice/lancio-settings': () => risposta({ ok: false, errore: 'scrittura_fallita' }, 500) });
  monta();
  await clic(screen.getByRole('switch', { name: 'Lancio attivo' }));
  await clic(screen.getByRole('button', { name: 'Sì, spegni' }));
  expect(screen.getByText(/^Non salvato/).textContent).toContain('il database ha rifiutato la scrittura');
  expect(screen.queryByText(/^Salvato/)).toBeNull();
  expect(screen.getByRole('switch', { name: 'Lancio attivo' }).getAttribute('aria-checked')).toBe('true');
});

it('audit fallito: salvato, ma con l\'avviso che non ne resta traccia', async () => {
  fetchFinto({ 'POST /api/fenice/lancio-settings': () => risposta({ ok: true, key: 'lancio_attivo', value: false, audit: false }) });
  monta();
  await clic(screen.getByRole('switch', { name: 'Lancio attivo' }));
  await clic(screen.getByRole('button', { name: 'Sì, spegni' }));
  expect(screen.getByText(/senza traccia nel registro/)).toBeTruthy();
});

it('anche il mittente chiede conferma, e manda lo stesso payload del pannello vecchio', async () => {
  const chiamate = fetchFinto({
    'POST /api/fenice/lancio-settings': () => risposta({ ok: true, key: 'lancio_sender', value: 'secondario', audit: true }),
  });
  monta();
  await act(async () => {
    fireEvent.change(screen.getByRole('combobox', { name: 'Mittente del lancio' }), { target: { value: 'secondario' } });
  });
  expect(chiamate).toHaveLength(0);
  expect(screen.getByRole('group', { name: 'Conferma Mittente del lancio' }).textContent).toContain('Numero principale → Numeri secondari');
  await clic(screen.getByRole('button', { name: 'Sì, salva' }));
  expect(chiamate[0].body).toEqual({ key: 'lancio_sender', value: 'secondario' });
});

it('un link si salva ripulito dagli spazi, dopo la conferma', async () => {
  const chiamate = fetchFinto({
    'POST /api/fenice/lancio-settings': (b) => risposta({ ok: true, key: 'lancio_zoom_link', value: (b as { value: string }).value, audit: true }),
  });
  monta();
  await act(async () => {
    fireEvent.change(screen.getByRole('textbox', { name: 'Link Zoom della live' }), { target: { value: '  https://zoom.us/j/2  ' } });
  });
  await clic(within(screen.getByRole('group', { name: 'Link Zoom della live' })).getByRole('button', { name: 'Salva…' }));
  await clic(screen.getByRole('button', { name: 'Sì, salva' }));
  expect(chiamate[0].body).toEqual({ key: 'lancio_zoom_link', value: 'https://zoom.us/j/2' });
});

it('un errore di validazione dice cosa serve', async () => {
  fetchFinto({ 'POST /api/fenice/lancio-settings': () => risposta({ ok: false, error: 'link_non_https' }, 400) });
  monta();
  await act(async () => {
    fireEvent.change(screen.getByRole('textbox', { name: 'Link Zoom della live' }), { target: { value: 'zoom.us/j/2' } });
  });
  await clic(within(screen.getByRole('group', { name: 'Link Zoom della live' })).getByRole('button', { name: 'Salva…' }));
  await clic(screen.getByRole('button', { name: 'Sì, salva' }));
  expect(screen.getByText(/^Non salvato/).textContent).toContain('https://');
});

it('Mario (auto-risposta): conferma, POST {on} e rilettura del valore', async () => {
  const chiamate = fetchFinto({
    'POST /api/fenice/autoreply': () => risposta({ ok: true, on: false }),
    'GET /api/fenice/autoreply': () => risposta({ on: false }),
  });
  monta();
  await clic(screen.getByRole('switch', { name: 'Mario risponde da solo' }));
  await clic(screen.getByRole('button', { name: 'Sì, spegni' }));
  expect(chiamate.map((c) => `${c.metodo} ${c.url}`)).toEqual(['POST /api/fenice/autoreply', 'GET /api/fenice/autoreply']);
  expect(chiamate[0].body).toEqual({ on: false });
  expect(screen.getByText(/^Salvato/)).toBeTruthy();
});

it('Mario: se la rilettura dice ancora acceso, è "Non salvato"', async () => {
  fetchFinto({
    'POST /api/fenice/autoreply': () => risposta({ ok: true, on: false }),
    'GET /api/fenice/autoreply': () => risposta({ on: true }),
  });
  monta();
  await clic(screen.getByRole('switch', { name: 'Mario risponde da solo' }));
  await clic(screen.getByRole('button', { name: 'Sì, spegni' }));
  expect(screen.getByText(/^Non salvato/)).toBeTruthy();
  expect(screen.queryByText(/^Salvato/)).toBeNull();
  expect(screen.getByRole('switch', { name: 'Mario risponde da solo' }).getAttribute('aria-checked')).toBe('true');
});

it('in sola lettura gli interruttori sono disabilitati', () => {
  fetchFinto({});
  monta({ puoModificare: false });
  expect(screen.getByText(/vede le impostazioni ma non le cambia/)).toBeTruthy();
  expect((screen.getByRole('switch', { name: 'Lancio attivo' }) as HTMLButtonElement).disabled).toBe(true);
});

it('durante la POST il "Sì" resta visibile ma disabilitato: il doppio clic non fa una seconda POST', async () => {
  let rispondi: (r: Response) => void = () => {};
  const chiamate: string[] = [];
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    chiamate.push(url);
    return new Promise<Response>((ok) => { rispondi = ok; });
  }));
  monta();
  await clic(screen.getByRole('switch', { name: 'Lancio attivo' }));
  const si = screen.getByRole('button', { name: 'Sì, spegni' }) as HTMLButtonElement;
  await clic(si);
  const ancora = screen.getByRole('button', { name: 'Sì, spegni' }) as HTMLButtonElement;
  expect(ancora.disabled).toBe(true);
  await clic(ancora);
  expect(chiamate).toHaveLength(1);
  await act(async () => {
    rispondi(risposta({ ok: true, key: 'lancio_attivo', value: false, audit: true }));
  });
  expect(chiamate).toHaveLength(1);
  expect(screen.queryByRole('group', { name: 'Conferma Lancio attivo' })).toBeNull();
  expect(screen.getByText(/^Salvato/)).toBeTruthy();
});

it('un campo di testo non cambiato: "Salva…" non apre la conferma e non chiama nulla', async () => {
  const chiamate = fetchFinto({});
  monta();
  const gruppo = screen.getByRole('group', { name: 'Link Zoom della live' });
  // Stesso valore salvato, anche con spazi attorno: non è un cambio.
  await act(async () => {
    fireEvent.change(within(gruppo).getByRole('textbox'), { target: { value: ' https://zoom.us/j/1 ' } });
  });
  await clic(within(gruppo).getByRole('button', { name: 'Salva…' }));
  expect(screen.queryByRole('group', { name: 'Conferma Link Zoom della live' })).toBeNull();
  expect(chiamate).toHaveLength(0);
});
