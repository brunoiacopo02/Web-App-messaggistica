import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─────────────────────────── finto Supabase ───────────────────────────
// Registra ogni chiamata (tabella, operazione, payload, filtri) così i test possono
// interrogare anche quello che NON è stato scritto: "nessuna riga messages sul
// frequency cap" e "un solo invio per numero" sono asserzioni sul secondo.

type Filtro = [string, string];
type Chiamata = { table: string; op: 'select' | 'insert' | 'update'; arg: unknown; filtri: Filtro[] };
const chiamate: Chiamata[] = [];

type ConvFinta = {
  id: number;
  crm_lead_id: string | null;
  lancio_fase: string | null;
  leads: { phone_e164: string | null; first_name: string | null } | null;
};
type OutFinto = { template_sid: string | null; twilio_status: string | null; created_at: string | null };

const stato = {
  convs: [] as ConvFinta[],
  outbound: new Map<number, OutFinto[]>(),
  attivo: '1' as string,
};

function esegui(rec: Chiamata): { data: unknown; error: unknown } {
  if (rec.op !== 'select') return { data: null, error: null };
  if (rec.table === 'app_settings') return { data: [{ key: 'lancio_attivo', value: stato.attivo }], error: null };
  if (rec.table === 'conversations') return { data: stato.convs, error: null };
  if (rec.table === 'messages') {
    const id = Number(rec.filtri.find(([c]) => c === 'conversation_id')?.[1]);
    return { data: stato.outbound.get(id) ?? [], error: null };
  }
  return { data: [], error: null };
}

function query(table: string, op: Chiamata['op'], arg: unknown) {
  const rec: Chiamata = { table, op, arg, filtri: [] };
  chiamate.push(rec);
  const q: Record<string, unknown> = {};
  for (const m of ['is', 'or', 'gte', 'lte', 'in', 'not', 'order', 'limit', 'single', 'maybeSingle']) {
    q[m] = () => q;
  }
  q.eq = (colonna: string, valore: unknown) => {
    rec.filtri.push([colonna, String(valore)]);
    return q;
  };
  q.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) =>
    Promise.resolve(esegui(rec)).then(ok, ko);
  return q;
}

vi.mock('@/lib/supabase/admin', () => ({
  getSupabaseAdmin: () => ({
    from: (table: string) => ({
      select: (s: string) => query(table, 'select', s),
      insert: (r: unknown) => query(table, 'insert', r),
      update: (r: unknown) => query(table, 'update', r),
    }),
  }),
}));

// ─────────────────────────── finto Twilio ───────────────────────────
const sendTemplate = vi.fn();
vi.mock('@/lib/twilio', () => ({
  sendTemplate: (...a: unknown[]) => sendTemplate(...a),
  getTemplateBody: async () => null,
  assertTemplateSendable: async () => {},
}));

import { GET } from './route';

const SEGRETO = 'segreto-di-test';
const WELCOME = 'HXbenvenuto';
const ADESSO = new Date('2026-09-20T10:00:00Z'); // 12:00 Roma, in fascia
const H = 3600_000;

const richiesta = (secret: string | null = SEGRETO) =>
  GET({
    headers: new Headers(secret ? { authorization: `Bearer ${secret}` } : {}),
    nextUrl: new URL('https://x/api/cron/lancio-aperture'),
  } as never);

/** Un numero per conversazione, formato E.164 italiano. */
const tel = (id: number) => `+39333000${String(id).padStart(4, '0')}`;

const conv = (id: number, extra: Partial<ConvFinta> = {}): ConvFinta => ({
  id,
  crm_lead_id: `crm-${id}`,
  lancio_fase: 'attesa',
  leads: { phone_e164: tel(id), first_name: 'mario rossi' },
  ...extra,
});

const insertIn = (table: string) =>
  chiamate
    .filter((c) => c.table === table && c.op === 'insert')
    .map((c) => c.arg as Record<string, unknown>);
const eventi = () => insertIn('event_log');
const tipiEvento = () => eventi().map((e) => e.type);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(ADESSO);
  chiamate.length = 0;
  stato.convs = [];
  stato.outbound = new Map();
  stato.attivo = '1';
  sendTemplate.mockReset();
  sendTemplate.mockResolvedValue({ sid: 'SMtest', status: 'queued' });
  process.env.CRON_SECRET = SEGRETO;
  process.env.LANCIO_WELCOME_TEMPLATE_SID = WELCOME;
  process.env.TWILIO_WHATSAPP_NUMBER_FENICE = 'whatsapp:+390000000';
  delete process.env.LANCIO_APERTURE_MAX_PER_RUN;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('GET /api/cron/lancio-aperture', () => {
  it('senza segreto non si entra', async () => {
    const res = await richiesta(null);
    expect(res.status).toBe(401);
    expect(sendTemplate).not.toHaveBeenCalled();
  });

  it('manda il benvenuto alle chat in attesa e lascia traccia', async () => {
    stato.convs = [conv(1), conv(2)];
    const res = await richiesta();
    const body = await res.json();

    expect(sendTemplate).toHaveBeenCalledTimes(2);
    expect(sendTemplate.mock.calls[0][0]).toMatchObject({
      to: tel(1),
      contentSid: WELCOME,
      variables: { '1': 'Mario' },
    });
    const righe = insertIn('messages');
    expect(righe).toHaveLength(2);
    expect(righe[0]).toMatchObject({
      direction: 'out',
      template_sid: WELCOME,
      twilio_sid: 'SMtest',
      is_template: true,
      sender: 'automazione',
    });
    expect(String(righe[0].body)).toContain('5 ottobre');
    expect(tipiEvento().filter((t) => t === 'lancio_apertura_inviata')).toHaveLength(2);
    expect(tipiEvento()).toContain('lancio_aperture_run');
    expect(body).toMatchObject({ ok: true, inviati: 2 });
  });

  it('il tetto per run ferma gli invii, non li perde', async () => {
    process.env.LANCIO_APERTURE_MAX_PER_RUN = '2';
    stato.convs = [conv(1), conv(2), conv(3)];
    const body = await (await richiesta()).json();
    expect(sendTemplate).toHaveBeenCalledTimes(2);
    expect(body.inviati).toBe(2);
  });

  it('un numero, un benvenuto: due chat sullo stesso telefono non si sommano', async () => {
    stato.convs = [conv(1), conv(2, { leads: { phone_e164: tel(1), first_name: 'Anna' } })];
    const body = await (await richiesta()).json();
    expect(sendTemplate).toHaveBeenCalledTimes(1);
    expect(body.inviati).toBe(1);
  });

  it('frequency cap Meta: nessuna riga, si ritenta al run dopo', async () => {
    stato.convs = [conv(1)];
    sendTemplate.mockRejectedValueOnce(Object.assign(new Error('frequency cap'), { code: 63049 }));
    const body = await (await richiesta()).json();
    expect(insertIn('messages')).toHaveLength(0);
    expect(tipiEvento()).toContain('lancio_apertura_freq_capped');
    expect(body).toMatchObject({ capped: 1, inviati: 0 });
  });

  it('un invio fallito lascia la riga fallita (e il prossimo run ritenta)', async () => {
    stato.convs = [conv(1)];
    sendTemplate.mockRejectedValueOnce(Object.assign(new Error('numero morto'), { code: 63024 }));
    const body = await (await richiesta()).json();
    expect(insertIn('messages')[0]).toMatchObject({ twilio_status: 'failed', twilio_error_code: 63024 });
    expect(tipiEvento()).toContain('send_error');
    expect(body).toMatchObject({ falliti: 1, inviati: 0 });
  });

  it('lancio spento: nessun invio, i lead restano in coda', async () => {
    stato.attivo = '0';
    stato.convs = [conv(1)];
    const body = await (await richiesta()).json();
    expect(sendTemplate).not.toHaveBeenCalled();
    expect(body).toMatchObject({ inviati: 0, attesi: 1, attivo: false });
  });

  it("l'apertura di Mario di un'ora fa blocca il benvenuto, quella di ieri no", async () => {
    stato.convs = [conv(1), conv(2)];
    stato.outbound.set(1, [
      { template_sid: 'HXapertura', twilio_status: 'delivered', created_at: new Date(ADESSO.getTime() - 1 * H).toISOString() },
    ]);
    stato.outbound.set(2, [
      { template_sid: 'HXapertura', twilio_status: 'delivered', created_at: new Date(ADESSO.getTime() - 13 * H).toISOString() },
    ]);
    const body = await (await richiesta()).json();
    expect(sendTemplate).toHaveBeenCalledTimes(1);
    expect(sendTemplate.mock.calls[0][0]).toMatchObject({ to: tel(2) });
    expect(body).toMatchObject({ inviati: 1, attesi: 1 });
  });

  it('un benvenuto riuscito non si ripete; tre falliti si lasciano stare', async () => {
    const vecchio = new Date(ADESSO.getTime() - 20 * H).toISOString();
    stato.convs = [conv(1), conv(2)];
    stato.outbound.set(1, [{ template_sid: WELCOME, twilio_status: 'delivered', created_at: vecchio }]);
    stato.outbound.set(2, [
      { template_sid: WELCOME, twilio_status: 'failed', created_at: vecchio },
      { template_sid: WELCOME, twilio_status: 'failed', created_at: vecchio },
      { template_sid: WELCOME, twilio_status: 'undelivered', created_at: vecchio },
    ]);
    const body = await (await richiesta()).json();
    expect(sendTemplate).not.toHaveBeenCalled();
    expect(body).toMatchObject({ inviati: 0, saltati: 2 });
  });

  it('due falliti si ritentano ancora', async () => {
    const vecchio = new Date(ADESSO.getTime() - 20 * H).toISOString();
    stato.convs = [conv(1)];
    stato.outbound.set(1, [
      { template_sid: WELCOME, twilio_status: 'failed', created_at: vecchio },
      { template_sid: WELCOME, twilio_status: 'failed', created_at: vecchio },
    ]);
    const body = await (await richiesta()).json();
    expect(sendTemplate).toHaveBeenCalledTimes(1);
    expect(body.inviati).toBe(1);
  });

  it('senza telefono non si manda niente', async () => {
    stato.convs = [conv(1, { leads: { phone_e164: null, first_name: 'Anna' } })];
    const body = await (await richiesta()).json();
    expect(sendTemplate).not.toHaveBeenCalled();
    expect(body.saltati).toBe(1);
  });

  it('env mancanti: run saltato e detto a voce alta', async () => {
    delete process.env.LANCIO_WELCOME_TEMPLATE_SID;
    stato.convs = [conv(1)];
    const body = await (await richiesta()).json();
    expect(sendTemplate).not.toHaveBeenCalled();
    expect(tipiEvento()).toContain('lancio_aperture_config_error');
    expect(body).toMatchObject({ ok: true, skipped: 'config' });
  });

  it('a run muto non si scrive un evento di run', async () => {
    stato.convs = [];
    await richiesta();
    expect(tipiEvento()).not.toContain('lancio_aperture_run');
  });
});
