import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const eventi: { type: string; payload: Record<string, unknown> }[] = [];
vi.mock('@/lib/supabase/admin', () => ({
  getSupabaseAdmin: () => ({
    from: () => ({ insert: (r: { type: string; payload: Record<string, unknown> }) => { eventi.push(r); return Promise.resolve({}); } }),
  }),
}));

const recapMock = vi.fn();
vi.mock('@/lib/gdo-recap-send', () => ({ inviaRecapDopoData: (...a: unknown[]) => recapMock(...a) }));
// `after` esegue subito la callback: la funzione differita si osserva senza attendere la risposta.
vi.mock('next/server', async (orig) => ({
  ...(await orig<typeof import('next/server')>()),
  after: (cb: () => unknown) => { void cb(); },
}));

const runMock = vi.fn();
vi.mock('@/lib/appointment-set', () => ({ runAppointmentSet: (...a: unknown[]) => runMock(...a) }));

import { POST } from './route';
import { signPayload } from '@/lib/bot-hmac';

const SEGRETO = 'segreto-di-test';
const DATA = '2026-08-07T18:00:00+02:00';

const chiama = (body: string, firma?: string) =>
  POST(new Request('https://x/api/appointment-set', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(firma ? { 'x-bot-signature': firma } : {}) },
    body,
  }) as never);

const firmato = (corpo: unknown) => {
  const body = JSON.stringify(corpo);
  return chiama(body, signPayload(body, SEGRETO));
};

beforeEach(() => {
  vi.stubEnv('BOT_WEBHOOK_SECRET', SEGRETO);
  eventi.length = 0;
  runMock.mockReset();
  recapMock.mockReset();
  runMock.mockResolvedValue({ ok: true, esito: 'registrato', conversationId: 7 });
});
afterEach(() => { vi.unstubAllEnvs(); });

describe('POST /api/appointment-set', () => {
  it('firma sbagliata → 401 e nessuna scrittura', async () => {
    const res = await chiama(JSON.stringify({ leadId: 'u1', appointmentAt: DATA }), 'sha256=finta');
    expect(res.status).toBe(401);
    expect(runMock).not.toHaveBeenCalled();
  });

  it('firma assente → 401', async () => {
    const res = await chiama(JSON.stringify({ leadId: 'u1', appointmentAt: DATA }));
    expect(res.status).toBe(401);
  });

  it('firma buona → 200 con l\'esito', async () => {
    const res = await firmato({ leadId: 'u1', appointmentAt: DATA });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true, esito: 'registrato', conversationId: 7 });
    expect(runMock).toHaveBeenCalledWith(expect.anything(), { leadId: 'u1', appointmentAt: DATA });
  });

  it("dopo una risposta registrato parte il recap differito, e il CRM riceve solo l'esito", async () => {
    const res = await firmato({ leadId: 'u1', appointmentAt: DATA });
    expect(recapMock).toHaveBeenCalledWith(expect.anything(), 7, 'registrato');
    expect(await res.json()).toEqual({ ok: true, esito: 'registrato', conversationId: 7 });
  });

  it('esito spostato → recap con occasione spostato; altri esiti → nessun recap', async () => {
    runMock.mockResolvedValue({ ok: true, esito: 'spostato', conversationId: 7 });
    await firmato({ leadId: 'u1', appointmentAt: DATA });
    expect(recapMock).toHaveBeenCalledWith(expect.anything(), 7, 'spostato');
    recapMock.mockReset();
    runMock.mockResolvedValue({ ok: true, esito: 'invariato', conversationId: 7 });
    await firmato({ leadId: 'u1', appointmentAt: DATA });
    expect(recapMock).not.toHaveBeenCalled();
  });

  it('data senza offset → 400 con un messaggio che dice cosa correggere', async () => {
    const res = await firmato({ leadId: 'u1', appointmentAt: '2026-08-07T18:00:00' });
    expect(res.status).toBe(400);
    const j = await res.json();
    expect(j.error).toBe('data_senza_offset');
    expect(j.message).toMatch(/offset/i);
    expect(runMock).not.toHaveBeenCalled();
  });

  it('payload che non riconosciamo → 400 e il corpo grezzo finisce nell\'event_log', async () => {
    // E' il meccanismo con cui impareremo il loro schema vero.
    const res = await firmato({ pippo: 1, quandoCheSia: DATA });
    expect(res.status).toBe(400);
    const ev = eventi.find((e) => e.type === 'appuntamento_payload_ignoto');
    expect(ev).toBeDefined();
    expect(String(ev?.payload.body)).toContain('quandoCheSia');
  });

  it('JSON malformato → 400 senza esplodere', async () => {
    const res = await chiama('{non json', signPayload('{non json', SEGRETO));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: 'invalid_json' });
  });

  it('senza segreto configurato → 503, non un 500 muto', async () => {
    vi.stubEnv('BOT_WEBHOOK_SECRET', '');
    const res = await firmato({ leadId: 'u1', appointmentAt: DATA });
    expect(res.status).toBe(503);
  });

  it('lead sconosciuto → 200: non e un errore loro', async () => {
    runMock.mockResolvedValue({ ok: true, esito: 'lead_sconosciuto' });
    const res = await firmato({ leadId: 'ignoto', appointmentAt: DATA });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ esito: 'lead_sconosciuto' });
  });
});
