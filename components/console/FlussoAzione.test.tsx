// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { AzioneRef } from '@/lib/console/avvisi';
import type { Anteprima, Esito } from '@/lib/console/azioni';
import { FlussoAzione } from './FlussoAzione';

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

const rif: AzioneRef = { azione: 'rinvia_esiti_403', params: {}, etichetta: 'Rinvia' };

function anteprima(conteggio: number | null, token = 'tok-1'): Anteprima {
  return {
    azione: 'rinvia_esiti_403',
    params: {},
    descrizione: 'Rimanda al CRM gli esiti rifiutati. Scrive al CRM, non ai lead.',
    conteggio,
    righe: ['chat 101', 'chat 102'],
    avvertenza: null,
    token,
    scadeAt: '2026-09-30T19:05:00Z',
  };
}

const esito: Esito = { ok: true, fatti: 36, falliti: 2, dettagli: ['chat 7: 500 dal CRM', 'chat 9: 500 dal CRM'], messaggio: '36 rinviati, 2 falliti' };

function risposta(corpo: unknown, status = 200): Response {
  return new Response(JSON.stringify(corpo), { status, headers: { 'content-type': 'application/json' } });
}

type Rotta = (body: unknown) => Response | Promise<Response>;

/** `fetch` finto: una funzione per rotta, e la lista delle chiamate con il corpo già letto. */
function fetchFinto(rotte: Record<string, Rotta>) {
  const chiamate: { url: string; body: unknown }[] = [];
  const f = vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    chiamate.push({ url, body });
    const r = rotte[url];
    if (!r) throw new Error(`rotta inattesa ${url}`);
    return r(body);
  });
  vi.stubGlobal('fetch', f);
  return chiamate;
}

async function provaAVuoto() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /Prova a vuoto/ }));
  });
}

it('"Prova a vuoto" chiama solo /anteprima', async () => {
  const chiamate = fetchFinto({ '/api/console/azioni/anteprima': () => risposta(anteprima(38)) });
  render(<FlussoAzione rif={rif} />);
  await provaAVuoto();
  expect(chiamate.map((c) => c.url)).toEqual(['/api/console/azioni/anteprima']);
  expect(chiamate[0].body).toEqual({ azione: 'rinvia_esiti_403', params: {} });
  expect(screen.getByText(/Rimanda al CRM gli esiti rifiutati/)).toBeTruthy();
});

it('il bottone di conferma porta il conteggio', async () => {
  fetchFinto({ '/api/console/azioni/anteprima': () => risposta(anteprima(38)) });
  render(<FlussoAzione rif={rif} />);
  await provaAVuoto();
  expect(screen.getByRole('button', { name: /Conferma: Rinvia 38/ })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Annulla' })).toBeTruthy();
});

it('la conferma chiama /esegui con il token e mostra l\'esito', async () => {
  const chiamate = fetchFinto({
    '/api/console/azioni/anteprima': () => risposta(anteprima(38)),
    '/api/console/azioni/esegui': () => risposta(esito),
  });
  const onEseguita = vi.fn();
  render(<FlussoAzione rif={rif} onEseguita={onEseguita} />);
  await provaAVuoto();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /Conferma: Rinvia 38/ }));
  });
  expect(chiamate[1]).toEqual({ url: '/api/console/azioni/esegui', body: { token: 'tok-1', conferma: true } });
  expect(screen.getByText('36 fatti, 2 falliti')).toBeTruthy();
  expect(onEseguita).toHaveBeenCalledWith(esito);
  // I dettagli restano chiusi finché non si chiedono.
  expect(screen.queryByText('chat 7: 500 dal CRM')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /Vedi dettagli/ }));
  expect(screen.getByText('chat 7: 500 dal CRM')).toBeTruthy();
});

it('un doppio clic rapido sulla conferma produce una sola chiamata a /esegui', async () => {
  let chiudi!: (r: Response) => void;
  const chiamate = fetchFinto({
    '/api/console/azioni/anteprima': () => risposta(anteprima(38)),
    '/api/console/azioni/esegui': () => new Promise<Response>((r) => (chiudi = r)),
  });
  render(<FlussoAzione rif={rif} />);
  await provaAVuoto();
  const conferma = screen.getByRole('button', { name: /Conferma: Rinvia 38/ });
  // Nello stesso act: React non ridisegna fra i due clic, il bottone non è ancora disabilitato.
  act(() => {
    fireEvent.click(conferma);
    fireEvent.click(conferma);
  });
  expect(chiamate.filter((c) => c.url === '/api/console/azioni/esegui')).toHaveLength(1);
  const inCorso = screen.getByRole('button', { name: /In corso…/ }) as HTMLButtonElement;
  expect(inCorso.disabled).toBe(true);
  fireEvent.click(inCorso);
  expect(chiamate.filter((c) => c.url === '/api/console/azioni/esegui')).toHaveLength(1);
  await act(async () => chiudi(risposta(esito)));
  expect(screen.getByText('36 fatti, 2 falliti')).toBeTruthy();
});

it('409 conteggio_cambiato mostra la nuova anteprima e conferma con il nuovo token', async () => {
  const chiamate = fetchFinto({
    '/api/console/azioni/anteprima': () => risposta(anteprima(38)),
    '/api/console/azioni/esegui': (b) =>
      (b as { token: string }).token === 'tok-1'
        ? risposta({ errore: 'conteggio_cambiato', nuovaAnteprima: anteprima(52, 'tok-2') }, 409)
        : risposta(esito),
  });
  render(<FlussoAzione rif={rif} />);
  await provaAVuoto();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /Conferma: Rinvia 38/ }));
  });
  expect(screen.getByText(/da 38 a 52/)).toBeTruthy();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /Conferma: Rinvia 52/ }));
  });
  expect(chiamate.at(-1)).toEqual({ url: '/api/console/azioni/esegui', body: { token: 'tok-2', conferma: true } });
  expect(screen.getByText('36 fatti, 2 falliti')).toBeTruthy();
});

it('409 anteprima_scaduta chiede di rifare la prova', async () => {
  const chiamate = fetchFinto({
    '/api/console/azioni/anteprima': () => risposta(anteprima(38)),
    '/api/console/azioni/esegui': () => risposta({ errore: 'anteprima_scaduta' }, 409),
  });
  render(<FlussoAzione rif={rif} />);
  await provaAVuoto();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /Conferma: Rinvia 38/ }));
  });
  expect(screen.getByText(/La prova è scaduta: rifalla/)).toBeTruthy();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Rifai la prova' }));
  });
  expect(chiamate.at(-1)?.url).toBe('/api/console/azioni/anteprima');
  expect(screen.getByRole('button', { name: /Conferma: Rinvia 38/ })).toBeTruthy();
});

it('409 azione_in_corso mostra il messaggio del server', async () => {
  fetchFinto({
    '/api/console/azioni/anteprima': () =>
      risposta({ errore: 'azione_in_corso', messaggio: 'Questa azione è già in corso da 21:04. Aspetta che finisca.' }, 409),
  });
  render(<FlussoAzione rif={rif} />);
  await provaAVuoto();
  expect(screen.getByText(/già in corso da 21:04/)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Rifai la prova' })).toBeTruthy();
});

it.each([
  ['gia_eseguita', /già stata confermata/],
  ['esito_senza_data', /senza data/],
  ['nessun_esito', /nessun esito/i],
  ['chat_fuori_perimetro', /fuori dal perimetro/],
])('409 %s ha un messaggio in italiano', async (codice, testo) => {
  fetchFinto({
    '/api/console/azioni/anteprima': () => risposta(anteprima(1)),
    '/api/console/azioni/esegui': () => risposta({ errore: codice }, 409),
  });
  render(<FlussoAzione rif={{ azione: 'rinvia_esito', params: { conversationId: 5 }, etichetta: 'Rinvia l\'esito' }} />);
  await provaAVuoto();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /Conferma: Rinvia l'esito 1/ }));
  });
  expect(screen.getByText(testo)).toBeTruthy();
  expect(screen.getByText(/Niente è partito/)).toBeTruthy();
});

it('se il server non risponde all\'esecuzione non dice che niente è partito', async () => {
  fetchFinto({
    '/api/console/azioni/anteprima': () => risposta(anteprima(38)),
    '/api/console/azioni/esegui': () => Promise.reject(new TypeError('Failed to fetch')),
  });
  render(<FlussoAzione rif={rif} />);
  await provaAVuoto();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /Conferma: Rinvia 38/ }));
  });
  expect(screen.getByText(/non so se l'azione è partita/)).toBeTruthy();
});

it('Annulla torna a riposo senza chiamare /esegui', async () => {
  const chiamate = fetchFinto({ '/api/console/azioni/anteprima': () => risposta(anteprima(38)) });
  render(<FlussoAzione rif={rif} />);
  await provaAVuoto();
  fireEvent.click(screen.getByRole('button', { name: 'Annulla' }));
  expect(screen.getByRole('button', { name: /Prova a vuoto/ })).toBeTruthy();
  expect(chiamate).toHaveLength(1);
});

it('con conteggio 0 la conferma non si può premere', async () => {
  fetchFinto({ '/api/console/azioni/anteprima': () => risposta(anteprima(0)) });
  render(<FlussoAzione rif={rif} />);
  await provaAVuoto();
  expect((screen.getByRole('button', { name: /Conferma: Rinvia 0/ }) as HTMLButtonElement).disabled).toBe(true);
});
