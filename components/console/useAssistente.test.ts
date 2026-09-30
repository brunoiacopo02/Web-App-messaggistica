// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { analizzaSse, domandeSuggerite, useAssistente } from './useAssistente';

const enc = new TextEncoder();

/** Uno stream SSE finto: ogni elemento di `pezzi` è un chunk (anche a metà di una riga). */
function streamDi(pezzi: string[]) {
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const p of pezzi) c.enqueue(enc.encode(p));
      c.close();
    },
  });
}

const riga = (e: unknown) => `data: ${JSON.stringify(e)}\n\n`;

function rispostaSse(pezzi: string[]) {
  return new Response(streamDi(pezzi), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

let fetchFinto: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchFinto = vi.fn();
  vi.stubGlobal('fetch', fetchFinto);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('analizzaSse', () => {
  it('ricompone le righe spezzate fra due chunk e ignora quelle che non sono data:', () => {
    const eventi: unknown[] = [];
    let resto = analizzaSse('', ': commento\ndata: {"tipo":"tes', (e) => eventi.push(e));
    resto = analizzaSse(resto, 'to","testo":"ciao"}\n\ndata: {"tipo":"fine"}\n\n', (e) => eventi.push(e));
    expect(resto).toBe('');
    expect(eventi).toEqual([{ tipo: 'testo', testo: 'ciao' }, { tipo: 'fine' }]);
  });

  it('una riga data: con JSON rotto viene scartata senza fermare le altre', () => {
    const eventi: unknown[] = [];
    analizzaSse('', 'data: {rotto\n\ndata: {"tipo":"fine"}\n\n', (e) => eventi.push(e));
    expect(eventi).toEqual([{ tipo: 'fine' }]);
  });
});

describe('useAssistente', () => {
  it('accumula passi, testo, citazioni, proposta e bozza del turno', async () => {
    const proposta = { azione: 'pausa_mario', params: { conversationId: 7 }, etichetta: 'Metti in pausa Mario' };
    const spezzata = riga({ tipo: 'strumento', nome: 'elenca_avvisi', sintesi: 'Letti 3 avvisi' });
    fetchFinto.mockResolvedValue(
      rispostaSse([
        riga({ tipo: 'strumento', nome: 'leggi_eventi', sintesi: 'Letti 214 eventi' }),
        spezzata.slice(0, 20),
        spezzata.slice(20),
        riga({ tipo: 'proposta', proposta }),
        riga({ tipo: 'bozza', bozza: { conversationId: 7, testo: 'Ciao Giulia' } }),
        riga({ tipo: 'testo', testo: 'Il CRM ha risposto 403.' }),
        riga({ tipo: 'citazioni', citazioni: [{ tipo: 'chat', id: 7, etichetta: 'Giulia' }] }),
        riga({ tipo: 'fine' }),
      ]),
    );
    const { result } = renderHook(() => useAssistente());
    act(() => result.current.invia('Perché 38 esiti sono stati rifiutati?'));
    expect(result.current.inCorso).toBe(true);
    await waitFor(() => expect(result.current.inCorso).toBe(false));

    const t = result.current.messaggi[0];
    expect(t.domanda).toBe('Perché 38 esiti sono stati rifiutati?');
    expect(t.passi).toEqual([
      { nome: 'leggi_eventi', sintesi: 'Letti 214 eventi' },
      { nome: 'elenca_avvisi', sintesi: 'Letti 3 avvisi' },
    ]);
    expect(result.current.passi).toEqual(t.passi);
    expect(t.testo).toBe('Il CRM ha risposto 403.');
    expect(t.citazioni).toEqual([{ tipo: 'chat', id: 7, etichetta: 'Giulia' }]);
    expect(t.proposte).toEqual([proposta]);
    expect(t.bozze).toEqual([{ conversationId: 7, testo: 'Ciao Giulia' }]);
    expect(t.errore).toBeNull();
    expect(result.current.errore).toBeNull();

    const [url, init] = fetchFinto.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/console/assistente');
    expect(JSON.parse(String(init.body))).toEqual({
      messaggi: [{ ruolo: 'utente', testo: 'Perché 38 esiti sono stati rifiutati?' }],
    });
  });

  it("l'evento errore imposta lo stato di errore e lascia inCorso a false", async () => {
    fetchFinto.mockResolvedValue(
      rispostaSse([
        riga({ tipo: 'strumento', nome: 'conta_viste', sintesi: 'Contate le viste' }),
        riga({ tipo: 'errore', messaggio: 'Troppe richieste ad Anthropic in questo momento. Riprova fra un minuto.' }),
      ]),
    );
    const { result } = renderHook(() => useAssistente());
    act(() => result.current.invia("Com'è messo il lancio?"));
    await waitFor(() => expect(result.current.inCorso).toBe(false));
    expect(result.current.errore).toBe('Troppe richieste ad Anthropic in questo momento. Riprova fra un minuto.');
    expect(result.current.messaggi[0].errore).toBe(result.current.errore);
    expect(result.current.passi).toHaveLength(1);
  });

  it('una seconda invia mentre inCorso è ignorata', async () => {
    let chiudi!: (r: Response) => void;
    fetchFinto.mockReturnValue(new Promise<Response>((r) => (chiudi = r)));
    const { result } = renderHook(() => useAssistente());
    act(() => {
      result.current.invia('prima');
      result.current.invia('seconda');
    });
    act(() => result.current.invia('terza'));
    expect(fetchFinto).toHaveBeenCalledTimes(1);
    expect(result.current.messaggi.map((m) => m.domanda)).toEqual(['prima']);
    await act(async () => chiudi(rispostaSse([riga({ tipo: 'testo', testo: 'ok' }), riga({ tipo: 'fine' })])));
    await waitFor(() => expect(result.current.inCorso).toBe(false));
  });

  it('il secondo turno manda la storia: domanda e risposta precedenti, poi la nuova domanda', async () => {
    fetchFinto
      .mockResolvedValueOnce(rispostaSse([riga({ tipo: 'testo', testo: 'Sono 41.' }), riga({ tipo: 'fine' })]))
      .mockResolvedValueOnce(rispostaSse([riga({ tipo: 'testo', testo: 'Per il 403.' }), riga({ tipo: 'fine' })]));
    const { result } = renderHook(() => useAssistente());
    act(() => result.current.invia('Quanti invii falliti?'));
    await waitFor(() => expect(result.current.inCorso).toBe(false));
    act(() => result.current.invia('Perché?'));
    await waitFor(() => expect(result.current.messaggi[1]?.testo).toBe('Per il 403.'));
    const corpo = JSON.parse(String((fetchFinto.mock.calls[1] as [string, RequestInit])[1].body));
    expect(corpo.messaggi).toEqual([
      { ruolo: 'utente', testo: 'Quanti invii falliti?' },
      { ruolo: 'assistente', testo: 'Sono 41.' },
      { ruolo: 'utente', testo: 'Perché?' },
    ]);
  });

  it('HTTP 401: errore che dice di rientrare', async () => {
    fetchFinto.mockResolvedValue(new Response('unauthorized', { status: 401 }));
    const { result } = renderHook(() => useAssistente());
    act(() => result.current.invia('ciao'));
    await waitFor(() => expect(result.current.inCorso).toBe(false));
    expect(result.current.errore).toMatch(/rientra/i);
  });

  it('stream chiuso senza fine né errore: errore di risposta interrotta', async () => {
    fetchFinto.mockResolvedValue(rispostaSse([riga({ tipo: 'strumento', nome: 'conta_viste', sintesi: 'x' })]));
    const { result } = renderHook(() => useAssistente());
    act(() => result.current.invia('ciao'));
    await waitFor(() => expect(result.current.inCorso).toBe(false));
    expect(result.current.errore).toMatch(/interrott/i);
  });

  it('fetch che lancia: errore di rete, e riprova rimanda la stessa domanda', async () => {
    fetchFinto
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(rispostaSse([riga({ tipo: 'testo', testo: 'ok' }), riga({ tipo: 'fine' })]));
    const { result } = renderHook(() => useAssistente());
    act(() => result.current.invia('ciao'));
    await waitFor(() => expect(result.current.errore).not.toBeNull());
    act(() => result.current.riprova());
    await waitFor(() => expect(result.current.messaggi[0]?.testo).toBe('ok'));
    expect(result.current.messaggi).toHaveLength(1);
    expect(result.current.errore).toBeNull();
    const corpo = JSON.parse(String((fetchFinto.mock.calls[1] as [string, RequestInit])[1].body));
    expect(corpo.messaggi).toEqual([{ ruolo: 'utente', testo: 'ciao' }]);
  });

  it('ricomincia a metà turno: svuota, sblocca, e il turno vecchio non sporca quello nuovo', async () => {
    let chiudiVecchio!: (r: Response) => void;
    fetchFinto
      .mockReturnValueOnce(new Promise<Response>((r) => (chiudiVecchio = r)))
      .mockResolvedValueOnce(rispostaSse([riga({ tipo: 'testo', testo: 'nuova' }), riga({ tipo: 'fine' })]));
    const { result } = renderHook(() => useAssistente());
    act(() => result.current.invia('vecchia'));
    act(() => result.current.ricomincia());
    expect(result.current.messaggi).toHaveLength(0);
    expect(result.current.inCorso).toBe(false);
    act(() => result.current.invia('nuova domanda'));
    await act(async () => chiudiVecchio(rispostaSse([riga({ tipo: 'testo', testo: 'vecchia' }), riga({ tipo: 'fine' })])));
    await waitFor(() => expect(result.current.messaggi[0]?.testo).toBe('nuova'));
    expect(result.current.messaggi).toHaveLength(1);
  });

  it('testo vuoto non parte', () => {
    const { result } = renderHook(() => useAssistente());
    act(() => result.current.invia('   '));
    expect(fetchFinto).not.toHaveBeenCalled();
    expect(result.current.messaggi).toHaveLength(0);
  });
});

describe('domandeSuggerite', () => {
  it('tre domande dai dati: invii falliti, primo avviso, lancio', () => {
    const d = domandeSuggerite({
      conteggi: { errori: 41, serve_te: 3 },
      avviso: { titolo: 'Appuntamento del bot mai arrivato al CRM' },
      lancioAttivo: true,
    });
    expect(d).toEqual([
      'Perché 41 chat hanno un invio non riuscito?',
      "Cosa c'è dietro l'avviso \"Appuntamento del bot mai arrivato al CRM\"?",
      "Com'è messo il lancio?",
    ]);
  });

  it('senza dati: sempre tre domande diverse', () => {
    const d = domandeSuggerite({ conteggi: null, avviso: null, lancioAttivo: false });
    expect(d).toHaveLength(3);
    expect(new Set(d).size).toBe(3);
  });

  it('nessun errore ma chat che aspettano te: chiede da quali partire', () => {
    const d = domandeSuggerite({ conteggi: { errori: 0, serve_te: 12 }, avviso: null, lancioAttivo: false });
    expect(d[0]).toBe('Da quali delle 12 chat che aspettano te parto?');
    expect(d).toHaveLength(3);
  });
});
