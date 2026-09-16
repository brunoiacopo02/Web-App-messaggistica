import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

type RigaEvento = { type: string; payload: Record<string, unknown>; level: string };

const h = vi.hoisted(() => ({
  insert: vi.fn<(riga: { type: string; payload: Record<string, unknown>; level: string }) => Promise<{ error: null }>>(
    async () => ({ error: null }),
  ),
  esplode: false,
}));

vi.mock('./supabase/admin', () => ({
  getSupabaseAdmin: () => {
    if (h.esplode) throw new Error('Missing SUPABASE_URL or SERVICE_ROLE_KEY');
    return { from: () => ({ insert: h.insert }) };
  },
}));

import { lancioSlots, lancioBook, lancioCallNow, LANCIO_CRM_TIMEOUT_MS } from './lancio-crm';
import { signPayload } from './bot-hmac';

const risposta = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(body),
});
const fetchMock = vi.fn();

/** Le righe `lancio_crm_call` scritte su event_log da questa chiamata. */
const chiamateLoggate = (): RigaEvento[] =>
  h.insert.mock.calls.map((c) => c[0]).filter((r) => r.type === 'lancio_crm_call');

const SLOTS_6 = {
  ok: true,
  date: '2026-10-06',
  mattina: [{ hour: 9, liberi: 2 }, { hour: 11, liberi: 0 }],
  pomeriggio: { aperto: true, ore: [15, 16, 17, 18, 19, 20] },
  mattinaEsaurita: false,
  oreAmmesse: [9, 11, 15, 16, 17, 18, 19, 20],
};

beforeEach(() => {
  vi.stubEnv('BOT_WEBHOOK_SECRET', 'segreto');
  vi.stubEnv('CRM_LANCIO_URL', '');
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  h.insert.mockClear();
  h.esplode = false;
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('lancioSlots', () => {
  it('POST firmato a /slots con il body esatto e il timeout da 8s', async () => {
    fetchMock.mockResolvedValue(risposta(200, SLOTS_6));
    const out = await lancioSlots('2026-10-06');
    expect(out).toEqual({
      ok: true,
      slots: {
        date: '2026-10-06',
        mattina: [{ hour: 9, liberi: 2 }, { hour: 11, liberi: 0 }],
        pomeriggio: { aperto: true, ore: [15, 16, 17, 18, 19, 20] },
        mattinaEsaurita: false,
        oreAmmesse: [9, 11, 15, 16, 17, 18, 19, 20],
      },
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://crm-sales-fenice.vercel.app/api/bot/lancio/slots');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ date: '2026-10-06' }));
    expect((init.headers as Record<string, string>)['x-bot-signature']).toBe(
      signPayload(init.body as string, 'segreto'),
    );
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(LANCIO_CRM_TIMEOUT_MS).toBe(8_000);
  });

  it('CRM_LANCIO_URL sovrascrive la base (e la barra finale non raddoppia)', async () => {
    vi.stubEnv('CRM_LANCIO_URL', 'http://localhost:3000/api/bot/lancio/');
    fetchMock.mockResolvedValue(risposta(200, { ok: true, date: '2026-10-07', mattina: 'conferme', pomeriggio: { aperto: false, ore: [] }, mattinaEsaurita: false, oreAmmesse: [9, 10] }));
    await lancioSlots('2026-10-07');
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:3000/api/bot/lancio/slots');
  });

  it("il 7/10 torna mattina 'conferme' e il pomeriggio chiuso", async () => {
    fetchMock.mockResolvedValue(risposta(200, {
      ok: true, date: '2026-10-07', mattina: 'conferme',
      pomeriggio: { aperto: false, ore: [] }, mattinaEsaurita: false, oreAmmesse: [9, 10, 11, 12, 13, 14],
    }));
    const out = await lancioSlots('2026-10-07');
    expect(out).toMatchObject({ ok: true, slots: { mattina: 'conferme', pomeriggio: { aperto: false, ore: [] }, oreAmmesse: [9, 10, 11, 12, 13, 14] } });
  });

  it('il pomeriggio già filtrato dal preavviso arriva come chiuso, non come assente', async () => {
    fetchMock.mockResolvedValue(risposta(200, { ...SLOTS_6, pomeriggio: { aperto: false, ore: [] }, oreAmmesse: [9] }));
    const out = await lancioSlots('2026-10-06');
    expect(out).toMatchObject({ ok: true, slots: { pomeriggio: { aperto: false, ore: [] } } });
  });

  it('segreto mancante: not_configured, nessuna rete, ma la traccia resta', async () => {
    vi.stubEnv('BOT_WEBHOOK_SECRET', '');
    expect(await lancioSlots('2026-10-06')).toEqual({ ok: false, motivo: 'not_configured' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(chiamateLoggate()[0].payload).toMatchObject({ endpoint: 'slots', motivo: 'not_configured' });
  });

  it('422 su una data fuori dal lancio: fuori_regole', async () => {
    fetchMock.mockResolvedValue(risposta(422, { ok: false, motivo: 'fuori_regole' }));
    expect(await lancioSlots('2026-10-09')).toEqual({ ok: false, motivo: 'fuori_regole' });
  });

  it('401 firma sbagliata e 503 senza segreto lato CRM: http con lo status', async () => {
    fetchMock.mockResolvedValueOnce(risposta(401, { ok: false, motivo: 'invalid_signature', detail: 'signature_mismatch' }));
    expect(await lancioSlots('2026-10-06')).toEqual({ ok: false, motivo: 'http', status: 401, detail: 'signature_mismatch' });
    fetchMock.mockResolvedValueOnce(risposta(503, { ok: false, motivo: 'not_configured' }));
    expect(await lancioSlots('2026-10-06')).toMatchObject({ ok: false, motivo: 'http', status: 503 });
  });

  it('400 malformato: http, non fuori_regole', async () => {
    fetchMock.mockResolvedValue(risposta(400, { ok: false, motivo: 'bad_request', detail: 'date richiesta (YYYY-MM-DD)' }));
    expect(await lancioSlots('boh')).toEqual({ ok: false, motivo: 'http', status: 400, detail: 'date richiesta (YYYY-MM-DD)' });
  });

  it('corpo non JSON su 200: http con il testo, mai slot inventati', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => '<html>' });
    expect(await lancioSlots('2026-10-06')).toEqual({ ok: false, motivo: 'http', status: 200, detail: '<html>' });
  });

  it('200 senza date leggibile: http', async () => {
    fetchMock.mockResolvedValue(risposta(200, { ok: true, mattina: [] }));
    expect(await lancioSlots('2026-10-06')).toMatchObject({ ok: false, motivo: 'http', status: 200 });
  });
});

describe('lancioBook', () => {
  const args = {
    leadId: 'L1',
    at: '2026-10-06T09:00:00+02:00',
    info: { risposte: ['faccio il barista'] },
    note: 'dalla live',
  };

  it('200 mattina con venditore, sul path /book e col body esatto', async () => {
    fetchMock.mockResolvedValue(risposta(200, { ok: true, kind: 'mattina', venditore: { id: 'u7', nome: 'Luca' } }));
    expect(await lancioBook(args)).toEqual({ ok: true, kind: 'mattina', venditore: { id: 'u7', nome: 'Luca' } });
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/book$/);
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)).toEqual(args);
  });

  it('200 pomeriggio senza venditore: le Conferme non hanno un nome da dire', async () => {
    fetchMock.mockResolvedValue(risposta(200, { ok: true, kind: 'pomeriggio' }));
    expect(await lancioBook(args)).toEqual({ ok: true, kind: 'pomeriggio' });
  });

  it('200 deduped: lo stesso at ripetuto non e un errore', async () => {
    fetchMock.mockResolvedValue(risposta(200, { ok: true, kind: 'dopodomani', deduped: true }));
    expect(await lancioBook(args)).toEqual({ ok: true, kind: 'dopodomani', deduped: true });
  });

  it('info e note assenti non viaggiano come null', async () => {
    fetchMock.mockResolvedValue(risposta(200, { ok: true, kind: 'pomeriggio' }));
    await lancioBook({ leadId: 'L1', at: args.at });
    expect((fetchMock.mock.calls[0][1] as RequestInit).body).toBe(
      JSON.stringify({ leadId: 'L1', at: args.at }),
    );
  });

  it('409 ora_esaurita porta gli slot aggiornati', async () => {
    fetchMock.mockResolvedValue(risposta(409, {
      ok: false, motivo: 'ora_esaurita',
      slots: { date: '2026-10-06', mattina: [], pomeriggio: { aperto: true, ore: [15] }, mattinaEsaurita: true, oreAmmesse: [15] },
    }));
    expect(await lancioBook(args)).toEqual({
      ok: false, motivo: 'ora_esaurita',
      slots: { date: '2026-10-06', mattina: [], pomeriggio: { aperto: true, ore: [15] }, mattinaEsaurita: true, oreAmmesse: [15] },
    });
  });

  it('409 ora_esaurita con slots null (data fuori regole lato CRM): slots null, non un oggetto vuoto', async () => {
    fetchMock.mockResolvedValue(risposta(409, { ok: false, motivo: 'ora_esaurita', slots: null }));
    expect(await lancioBook(args)).toEqual({ ok: false, motivo: 'ora_esaurita', slots: null });
  });

  it('409 gia_prenotato torna ora e tipo dell appuntamento che il lead ha gia', async () => {
    fetchMock.mockResolvedValue(risposta(409, { ok: false, motivo: 'gia_prenotato', appointmentAt: '2026-10-06T11:00:00+02:00', kind: 'mattina' }));
    expect(await lancioBook(args)).toEqual({
      ok: false, motivo: 'gia_prenotato', appointmentAt: '2026-10-06T11:00:00+02:00', kind: 'mattina',
    });
  });

  it('409 conflitto: un solo ritentativo automatico, e se riesce il lead non se ne accorge', async () => {
    fetchMock
      .mockResolvedValueOnce(risposta(409, { ok: false, motivo: 'conflitto' }))
      .mockResolvedValueOnce(risposta(200, { ok: true, kind: 'mattina', venditore: { id: 'u7', nome: 'Luca' } }));
    expect(await lancioBook(args)).toEqual({ ok: true, kind: 'mattina', venditore: { id: 'u7', nome: 'Luca' } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(chiamateLoggate()[0].payload).toMatchObject({ endpoint: 'book', tentativi: 2, status: 200 });
  });

  it('409 conflitto due volte: si ritenta una volta sola e si torna conflitto', async () => {
    fetchMock.mockResolvedValue(risposta(409, { ok: false, motivo: 'conflitto' }));
    expect(await lancioBook(args)).toEqual({ ok: false, motivo: 'conflitto' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('422 fuori_regole, 400 info_non_valida, 403 forbidden, 404 not_found', async () => {
    fetchMock.mockResolvedValueOnce(risposta(422, { ok: false, motivo: 'fuori_regole' }));
    expect(await lancioBook(args)).toEqual({ ok: false, motivo: 'fuori_regole' });
    fetchMock.mockResolvedValueOnce(risposta(400, { ok: false, motivo: 'info_non_valida', detail: 'info.risposte deve essere un array di stringhe' }));
    expect(await lancioBook(args)).toEqual({ ok: false, motivo: 'info_non_valida' });
    fetchMock.mockResolvedValueOnce(risposta(403, { ok: false, motivo: 'forbidden', detail: 'lead già presentato' }));
    expect(await lancioBook(args)).toEqual({ ok: false, motivo: 'forbidden' });
    fetchMock.mockResolvedValueOnce(risposta(404, { ok: false, motivo: 'lead_not_found' }));
    expect(await lancioBook(args)).toEqual({ ok: false, motivo: 'not_found' });
  });

  it('409 sconosciuto: http, non un motivo inventato', async () => {
    fetchMock.mockResolvedValue(risposta(409, { ok: false, motivo: 'boh' }));
    expect(await lancioBook(args)).toMatchObject({ ok: false, motivo: 'http', status: 409 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('200 con un kind che non conosciamo: http, non una conferma a caso', async () => {
    fetchMock.mockResolvedValue(risposta(200, { ok: true, kind: 'sera' }));
    expect(await lancioBook(args)).toMatchObject({ ok: false, motivo: 'http', status: 200 });
  });

  it('500: http con status e corpo; rete caduta: rete col messaggio', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'boom' });
    expect(await lancioBook(args)).toEqual({ ok: false, motivo: 'http', status: 500, detail: 'boom' });
    fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'));
    expect(await lancioBook(args)).toEqual({ ok: false, motivo: 'rete', detail: 'ECONNRESET' });
  });

  it('timeout: l abort torna come rete e la traccia porta i millisecondi', async () => {
    fetchMock.mockImplementation((_u: string, init: RequestInit) => new Promise((_, rej) => {
      init.signal?.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }));
    vi.useFakeTimers();
    const p = lancioBook(args);
    await vi.advanceTimersByTimeAsync(LANCIO_CRM_TIMEOUT_MS + 1);
    const out = await p;
    vi.useRealTimers();
    expect(out).toMatchObject({ ok: false, motivo: 'rete' });
    expect(chiamateLoggate()[0].payload).toMatchObject({ endpoint: 'book', motivo: 'rete' });
  });
});

describe('lancioCallNow', () => {
  it('200 con venditore, sul path /call-now', async () => {
    fetchMock.mockResolvedValue(risposta(200, { ok: true, venditore: { id: 'u1', nome: 'Sara' } }));
    expect(await lancioCallNow({ leadId: 'L1', info: { risposte: [] }, note: 'nota' })).toEqual({
      ok: true, venditore: { id: 'u1', nome: 'Sara' },
    });
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/call-now$/);
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)).toEqual({
      leadId: 'L1', info: { risposte: [] }, note: 'nota',
    });
  });

  it('200 deduped: il venditore e lo stesso di prima', async () => {
    fetchMock.mockResolvedValue(risposta(200, { ok: true, venditore: { id: 'u1', nome: 'Sara' }, deduped: true }));
    expect(await lancioCallNow({ leadId: 'L1' })).toEqual({ ok: true, venditore: { id: 'u1', nome: 'Sara' }, deduped: true });
  });

  it('409 nessun_venditore: il turno sera e vuoto', async () => {
    fetchMock.mockResolvedValue(risposta(409, { ok: false, motivo: 'nessun_venditore' }));
    expect(await lancioCallNow({ leadId: 'L1' })).toEqual({ ok: false, motivo: 'nessun_venditore' });
  });

  it('409 gia_prenotato con ora e tipo', async () => {
    fetchMock.mockResolvedValue(risposta(409, { ok: false, motivo: 'gia_prenotato', appointmentAt: '2026-10-06T15:00:00+02:00', kind: 'pomeriggio' }));
    expect(await lancioCallNow({ leadId: 'L1' })).toEqual({
      ok: false, motivo: 'gia_prenotato', appointmentAt: '2026-10-06T15:00:00+02:00', kind: 'pomeriggio',
    });
  });

  it('409 conflitto: stesso ritentativo unico', async () => {
    fetchMock
      .mockResolvedValueOnce(risposta(409, { ok: false, motivo: 'conflitto' }))
      .mockResolvedValueOnce(risposta(200, { ok: true, venditore: { id: 'u1', nome: 'Sara' } }));
    expect(await lancioCallNow({ leadId: 'L1' })).toEqual({ ok: true, venditore: { id: 'u1', nome: 'Sara' } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('403 forbidden e 404 not_found', async () => {
    fetchMock.mockResolvedValueOnce(risposta(403, { ok: false, motivo: 'forbidden' }));
    expect(await lancioCallNow({ leadId: 'L1' })).toEqual({ ok: false, motivo: 'forbidden' });
    fetchMock.mockResolvedValueOnce(risposta(404, { ok: false, motivo: 'lead_not_found' }));
    expect(await lancioCallNow({ leadId: 'L1' })).toEqual({ ok: false, motivo: 'not_found' });
  });

  it('200 senza venditore leggibile: http, non si inventa un nome', async () => {
    fetchMock.mockResolvedValue(risposta(200, { ok: true }));
    expect(await lancioCallNow({ leadId: 'L1' })).toMatchObject({ ok: false, motivo: 'http', status: 200 });
  });

  it('200 con un venditore senza nome: http', async () => {
    fetchMock.mockResolvedValue(risposta(200, { ok: true, venditore: { id: 'u1', nome: '   ' } }));
    expect(await lancioCallNow({ leadId: 'L1' })).toMatchObject({ ok: false, motivo: 'http' });
  });
});

describe('traccia su event_log', () => {
  it('ogni chiamata lascia endpoint, status, motivo e millisecondi', async () => {
    fetchMock.mockResolvedValue(risposta(200, { ok: true, kind: 'mattina', venditore: { id: 'u7', nome: 'Luca' } }));
    await lancioBook({ leadId: 'L1', at: '2026-10-06T09:00:00+02:00' });
    const righe = chiamateLoggate();
    expect(righe).toHaveLength(1);
    expect(righe[0].type).toBe('lancio_crm_call');
    expect(righe[0].level).toBe('info');
    expect(righe[0].payload).toMatchObject({ endpoint: 'book', status: 200, motivo: null, tentativi: 1, leadId: 'L1' });
    expect(typeof righe[0].payload.ms).toBe('number');
  });

  it('un errore di rete si registra come error', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNRESET'));
    await lancioCallNow({ leadId: 'L1' });
    expect(chiamateLoggate()[0]).toMatchObject({ level: 'error', payload: { endpoint: 'call-now', motivo: 'rete', status: null } });
  });

  it('un rifiuto di merito si registra come warn, non come errore', async () => {
    fetchMock.mockResolvedValue(risposta(409, { ok: false, motivo: 'nessun_venditore' }));
    await lancioCallNow({ leadId: 'L1' });
    expect(chiamateLoggate()[0]).toMatchObject({ level: 'warn', payload: { motivo: 'nessun_venditore', status: 409 } });
  });

  it('se la traccia non si scrive la chiamata vale lo stesso: la prenotazione non muore per un log', async () => {
    h.esplode = true;
    fetchMock.mockResolvedValue(risposta(200, { ok: true, kind: 'mattina', venditore: { id: 'u7', nome: 'Luca' } }));
    expect(await lancioBook({ leadId: 'L1', at: '2026-10-06T09:00:00+02:00' })).toMatchObject({ ok: true, kind: 'mattina' });
  });

  it('anche un insert che va in errore non propaga', async () => {
    h.insert.mockRejectedValueOnce(new Error('db giu'));
    fetchMock.mockResolvedValue(risposta(200, { ok: true, venditore: { id: 'u1', nome: 'Sara' } }));
    expect(await lancioCallNow({ leadId: 'L1' })).toMatchObject({ ok: true });
  });
});
