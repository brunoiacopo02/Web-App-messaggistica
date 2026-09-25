import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Finto Supabase minimo: registra le chiamate e simula il compare-and-set del timbro
// `lancio_inizio_inviato_at`, che e' tutto il lucchetto contro il doppio invio.
type Filtro = { m: string; args: unknown[] };
type Chiamata = { table: string; op: 'select' | 'insert' | 'update' | 'upsert'; arg: unknown; filtri: Filtro[] };
const chiamate: Chiamata[] = [];

type ConvFinta = {
  id: number;
  crm_lead_id: string | null;
  wa_number: string | null;
  lancio_slug: string | null;
  lancio_fase: string | null;
  lancio_info: Record<string, unknown> | null;
  lancio_benvenuto_at: string | null;
  last_inbound_at: string | null;
  lancio_link_inviato_at: string | null;
  lancio_inizio_inviato_at: string | null;
  leads: { phone_e164: string | null; first_name: string | null } | null;
};

const stato = {
  convs: [] as ConvFinta[],
  settings: {} as Record<string, unknown>,
};

const arg = (rec: Chiamata, metodo: string, colonna: string) => rec.filtri.find((f) => f.m === metodo && f.args[0] === colonna);

function esegui(rec: Chiamata): { data: unknown; error: unknown } {
  if (rec.table === 'conversations' && rec.op === 'update') {
    const campi = rec.arg as Record<string, unknown>;
    const id = Number(arg(rec, 'eq', 'id')?.args[1]);
    const c = stato.convs.find((x) => x.id === id);
    if (!c || !('lancio_inizio_inviato_at' in campi)) return { data: [], error: null };
    if (campi.lancio_inizio_inviato_at === null) {
      c.lancio_inizio_inviato_at = null;
      return { data: [], error: null };
    }
    if (c.lancio_inizio_inviato_at) return { data: [], error: null };
    c.lancio_inizio_inviato_at = String(campi.lancio_inizio_inviato_at);
    return { data: [{ id }], error: null };
  }
  if (rec.op !== 'select') return { data: null, error: null };
  if (rec.table === 'app_settings') {
    return { data: Object.entries(stato.settings).map(([key, value]) => ({ key, value })), error: null };
  }
  if (rec.table === 'conversations') {
    let out = stato.convs.filter((c) => c.lancio_slug !== null && !c.lancio_inizio_inviato_at);
    const fasi = arg(rec, 'in', 'lancio_fase')?.args[1] as string[] | undefined;
    if (fasi) out = out.filter((c) => fasi.includes(c.lancio_fase ?? ''));
    if (arg(rec, 'is', 'lancio_info->>congedo_at')) out = out.filter((c) => !c.lancio_info?.congedo_at);
    const solo = arg(rec, 'eq', 'id');
    if (solo) out = out.filter((c) => c.id === solo.args[1]);
    return { data: out, error: null };
  }
  return { data: [], error: null };
}

function query(table: string, op: Chiamata['op'], a: unknown) {
  const rec: Chiamata = { table, op, arg: a, filtri: [] };
  chiamate.push(rec);
  const q: Record<string, unknown> = {};
  for (const m of ['eq', 'is', 'in', 'not', 'order', 'limit', 'range', 'gte', 'lte', 'select', 'contains']) {
    q[m] = (...args: unknown[]) => {
      rec.filtri.push({ m, args });
      return q;
    };
  }
  q.maybeSingle = () => q;
  q.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve().then(() => esegui(rec)).then(ok, ko);
  return q;
}

vi.mock('@/lib/supabase/admin', () => ({
  getSupabaseAdmin: () => ({
    from: (table: string) => ({
      select: (s: string) => query(table, 'select', s),
      insert: (r: unknown) => query(table, 'insert', r),
      update: (r: unknown) => query(table, 'update', r),
      upsert: (r: unknown) => query(table, 'upsert', r),
    }),
  }),
}));

const sendTemplate = vi.fn();
vi.mock('@/lib/twilio', () => ({
  sendTemplate: (...a: unknown[]) => sendTemplate(...a),
  assertTemplateSendable: async () => undefined,
  getTemplateBody: async () => 'Promemoria evento: ciao {{1}}, link: {{2}}',
}));
const impostaFaseLancio = vi.fn(async () => {});
vi.mock('@/lib/lancio-db', () => ({ impostaFaseLancio: (...a: unknown[]) => impostaFaseLancio(...(a as [])) }));

import { GET } from './route';

const SEGRETO = 'segreto-di-test';
const ZOOM = 'https://us06web.zoom.us/j/89845223337';
const EVENTO = '2026-10-05T21:00:00+02:00';
const BENVENUTO = '2026-10-01T10:00:00Z';

const richiesta = () =>
  GET({
    headers: new Headers({ authorization: `Bearer ${SEGRETO}` }),
    nextUrl: new URL('https://x/api/cron/lancio-inizio'),
  } as never);

const conv = (id: number, extra: Partial<ConvFinta> = {}): ConvFinta => ({
  id,
  crm_lead_id: `crm-${id}`,
  wa_number: null,
  lancio_slug: 'webdev-2026-10',
  lancio_fase: 'attesa',
  lancio_info: null,
  lancio_benvenuto_at: BENVENUTO,
  last_inbound_at: '2026-10-02T10:00:00Z',
  lancio_link_inviato_at: null,
  lancio_inizio_inviato_at: null,
  leads: { phone_e164: `+39333000${String(id).padStart(4, '0')}`, first_name: 'mario' },
  ...extra,
});

const eventi = () =>
  chiamate.filter((c) => c.table === 'event_log' && c.op === 'insert').map((c) => c.arg as { type: string; payload: Record<string, unknown>; level: string });
const eventoRun = () => eventi().find((e) => e.type === 'lancio_inizio_run');
const destinatari = () => sendTemplate.mock.calls.map((c) => (c[0] as { to: string }).to);

beforeEach(() => {
  chiamate.length = 0;
  stato.settings = { lancio_attivo: true, lancio_zoom_link: ZOOM, lancio_evento_at: EVENTO };
  stato.convs = [];
  sendTemplate.mockReset().mockResolvedValue({ sid: 'SMtest', status: 'queued' });
  impostaFaseLancio.mockClear();
  vi.stubEnv('CRON_SECRET', SEGRETO);
  vi.stubEnv('LANCIO_INIZIO_TEMPLATE_SID', 'HXinizio');
  vi.stubEnv('TWILIO_WHATSAPP_NUMBER_FENICE', 'whatsapp:+390000000000');
  vi.stubEnv('LANCIO_INIZIO_BATCH_MAX', '');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-05T21:30:00+02:00'));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('GET /api/cron/lancio-inizio', () => {
  it('senza LANCIO_INIZIO_TEMPLATE_SID non manda e scrive la configurazione mancante', async () => {
    vi.stubEnv('LANCIO_INIZIO_TEMPLATE_SID', '');
    stato.convs = [conv(1)];
    const res = await richiesta();
    expect(await res.json()).toMatchObject({ skipped: 'config', missing: ['LANCIO_INIZIO_TEMPLATE_SID'] });
    expect(sendTemplate).not.toHaveBeenCalled();
    expect(eventi().map((e) => e.type)).toContain('lancio_inizio_config_error');
  });

  it('lancio spento: nessun invio, run scritto', async () => {
    stato.settings.lancio_attivo = false;
    stato.convs = [conv(1)];
    await richiesta();
    expect(sendTemplate).not.toHaveBeenCalled();
    expect(eventoRun()?.payload).toMatchObject({ motivo: 'lancio_non_attivo' });
  });

  it('fuori finestra (20:00): nessun invio', async () => {
    vi.setSystemTime(new Date('2026-10-05T20:00:00+02:00'));
    stato.convs = [conv(1)];
    await richiesta();
    expect(sendTemplate).not.toHaveBeenCalled();
    expect(eventoRun()?.payload).toMatchObject({ motivo: 'fuori_finestra', finestraChiusa: false });
  });

  it('ultimo run: manda a chi ha scritto dopo il benvenuto, posto_bloccato per primo, non tocca la fase', async () => {
    stato.convs = [
      conv(1),
      conv(2, { lancio_fase: 'posto_bloccato' }),
      conv(3, { last_inbound_at: '2026-09-30T10:00:00Z' }), // ha scritto solo prima del benvenuto
      conv(4, { lancio_info: { congedo_at: '2026-10-03T10:00:00Z' } }),
      conv(5, { lancio_fase: 'scelta_fatta' }),
      conv(6, { lancio_inizio_inviato_at: '2026-10-05T19:00:00Z' }),
    ];
    const res = await richiesta();
    const body = await res.json();
    expect(destinatari()).toEqual(['+393330000002', '+393330000001']);
    expect(sendTemplate.mock.calls[0][0]).toMatchObject({ contentSid: 'HXinizio', variables: { '1': 'Mario', '2': ZOOM } });
    expect(impostaFaseLancio).not.toHaveBeenCalled();
    expect(body).toMatchObject({ inviati: 2, rimanenti: 0, run: 1 });
    expect(eventoRun()?.payload).toMatchObject({ inviati: 2, falliti: 0, rimanenti: 0 });
    expect(stato.convs[0].lancio_inizio_inviato_at).not.toBeNull();

    // Idempotente: il run dopo non rimanda niente.
    sendTemplate.mockClear();
    await richiesta();
    expect(sendTemplate).not.toHaveBeenCalled();
  });

  it('primo run (20:30): spalma la coda sui 13 run', async () => {
    vi.setSystemTime(new Date('2026-10-05T20:30:10+02:00'));
    stato.convs = Array.from({ length: 26 }, (_, i) => conv(i + 1));
    const body = await (await richiesta()).json();
    expect(body).toMatchObject({ run: 13, quota: 2, inviati: 2, rimanenti: 24 });
    expect(sendTemplate).toHaveBeenCalledTimes(2);
  });
});
