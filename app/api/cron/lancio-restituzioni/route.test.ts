import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

type Filtro = { m: string; args: unknown[] };
type Chiamata = { table: string; op: 'select' | 'insert' | 'update' | 'upsert'; arg: unknown; filtri: Filtro[]; opzioni?: { head?: boolean; count?: string } };
const chiamate: Chiamata[] = [];
type Riga = { direction: string; body: string | null; template_sid: string | null; created_at: string; conversation_id: number };
type ConvFinta = {
  id: number; crm_lead_id: string | null; lancio_fase: string | null; lancio_info: Record<string, unknown> | null;
  lancio_benvenuto_at: string | null; lancio_followup_inviato_at: string | null; last_inbound_at: string | null;
  bot_outcome: string | null; leads: { phone_e164: string | null; first_name: string | null } | null;
};
const stato = {
  convs: [] as ConvFinta[],
  messaggi: new Map<number, Riga[]>(),
  settings: {} as Record<string, unknown>,
  convSelectError: null as { message: string; code?: string } | null,
};
const arg = (rec: Chiamata, m: string, col: string) => rec.filtri.find((f) => f.m === m && f.args[0] === col);

function esegui(rec: Chiamata): { data: unknown; error: unknown; count?: number } {
  if (rec.op === 'update') return { data: [], error: null };
  if (rec.op !== 'select') return { data: null, error: null };
  if (rec.table === 'app_settings') return { data: Object.entries(stato.settings).map(([key, value]) => ({ key, value })), error: null };
  if (rec.table === 'conversations') {
    if (stato.convSelectError) return { data: null, error: stato.convSelectError };
    let out = stato.convs.filter((c) => c.lancio_fase !== 'chiuso' && c.lancio_fase !== 'restituito' && c.crm_lead_id !== null);
    const solo = rec.filtri.find((f) => f.m === 'eq' && f.args[0] === 'id');
    if (solo) out = out.filter((c) => c.id === solo.args[1]);
    if (rec.opzioni?.head) return { data: null, error: null, count: out.length };
    const range = (rec.filtri.find((f) => f.m === 'range')?.args as number[] | undefined) ?? [0, 999];
    return { data: out.slice(range[0], range[1] + 1), error: null };
  }
  if (rec.table === 'messages') {
    const ids = (arg(rec, 'in', 'conversation_id')?.args[1] as number[] | undefined) ?? [];
    return { data: ids.flatMap((id) => stato.messaggi.get(id) ?? []), error: null };
  }
  return { data: [], error: null };
}
function query(table: string, op: Chiamata['op'], a: unknown, opzioni?: Chiamata['opzioni']) {
  const rec: Chiamata = { table, op, arg: a, filtri: [], opzioni };
  chiamate.push(rec);
  const q: Record<string, unknown> = {};
  for (const m of ['eq', 'is', 'in', 'not', 'gte', 'order', 'limit', 'range', 'select']) q[m] = (...args: unknown[]) => { rec.filtri.push({ m, args }); return q; };
  q.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve().then(() => esegui(rec)).then(ok, ko);
  return q;
}
vi.mock('@/lib/supabase/admin', () => ({
  getSupabaseAdmin: () => ({
    from: (table: string) => ({
      select: (s: string, o?: Chiamata['opzioni']) => query(table, 'select', s, o),
      insert: (r: unknown) => query(table, 'insert', r),
      update: (r: unknown) => query(table, 'update', r),
      upsert: (r: unknown) => query(table, 'upsert', r),
    }),
  }),
}));
type EsitoOutcome = { sent: boolean; status?: number; error?: string; corpo?: Record<string, unknown> };
const RESTITUITO: EsitoOutcome = { sent: true, status: 200, corpo: { ok: true, returnedToPool: true, motivo: 'mai_risposto' } };
const sendOutcome = vi.fn<(...a: unknown[]) => Promise<EsitoOutcome>>(async () => RESTITUITO);
vi.mock('@/lib/bot-outcome', () => ({ sendOutcome: (...a: unknown[]) => sendOutcome(...a) }));
const impostaFaseLancio = vi.fn(async (...a: unknown[]) => { const c = stato.convs.find((x) => x.id === a[1]); if (c) c.lancio_fase = a[2] as string; });
const leggiIngressoLancioAt = vi.fn<(...a: unknown[]) => Promise<string | null>>(async () => null);
vi.mock('@/lib/lancio-db', () => ({
  impostaFaseLancio: (...a: unknown[]) => impostaFaseLancio(...a),
  leggiIngressoLancioAt: (...a: unknown[]) => leggiIngressoLancioAt(...a),
}));
const congedoLancio = vi.fn<(...a: unknown[]) => Promise<'active' | 'closed' | 'handed_off'>>(async () => 'closed');
vi.mock('@/lib/lancio-effetti', () => ({ congedoLancio: (...a: unknown[]) => congedoLancio(...a) }));

import { GET } from './route';

const SEGRETO = 's';
const WELCOME = 'HXwelcome';
const EVENTO = '2026-10-05T21:00:00+02:00';
const ANCORA = '2026-09-20T10:00:00Z';
const OGGI = '2026-10-08T10:00:00+02:00';
const richiesta = (extra = '', secret: string | null = SEGRETO) =>
  GET({ headers: new Headers(secret ? { authorization: `Bearer ${secret}` } : {}), nextUrl: new URL(`https://x/api/cron/lancio-restituzioni?${extra}`) } as never);
const conv = (id: number, extra: Partial<ConvFinta> = {}): ConvFinta => ({
  id, crm_lead_id: `crm-${id}`, lancio_fase: 'attesa', lancio_info: null, lancio_benvenuto_at: ANCORA,
  lancio_followup_inviato_at: null, last_inbound_at: null, bot_outcome: null,
  leads: { phone_e164: `+3933300000${id}`, first_name: 'mario' }, ...extra,
});
const welcome = (id: number): Riga => ({ conversation_id: id, direction: 'out', body: 'benvenuto', template_sid: WELCOME, created_at: ANCORA });
const inb = (id: number, body: string, created_at: string): Riga => ({ conversation_id: id, direction: 'in', body, template_sid: null, created_at });
const eventi = () => chiamate.filter((c) => c.table === 'event_log' && c.op === 'insert').map((c) => c.arg as Record<string, unknown>);
const tipi = () => eventi().map((e) => e.type);
const eventoRun = () => eventi().find((e) => e.type === 'lancio_restituzioni_run');

beforeEach(() => {
  chiamate.length = 0;
  stato.convs = [conv(1), conv(2, { lancio_fase: 'link_inviato' })];
  stato.messaggi = new Map([[1, [welcome(1)]], [2, [welcome(2)]]]);
  stato.settings = { lancio_attivo: true, lancio_evento_at: EVENTO };
  stato.convSelectError = null;
  sendOutcome.mockReset().mockResolvedValue(RESTITUITO);
  impostaFaseLancio.mockClear();
  congedoLancio.mockClear();
  leggiIngressoLancioAt.mockClear().mockResolvedValue(null);
  vi.stubEnv('CRON_SECRET', SEGRETO);
  vi.stubEnv('LANCIO_WELCOME_TEMPLATE_SID', WELCOME);
  vi.stubEnv('TWILIO_WHATSAPP_NUMBER_FENICE', 'whatsapp:+390000000000');
  vi.stubEnv('LANCIO_BATCH_MAX', '');
  vi.useFakeTimers();
  vi.setSystemTime(new Date(OGGI));
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

describe('GET /api/cron/lancio-restituzioni — cancelli', () => {
  it('401 senza segreto', async () => { expect((await richiesta('', null)).status).toBe(401); });
  it('prima dell 8/10 (Roma) non si restituisce nessuno, ma il run resta scritto', async () => {
    vi.setSystemTime(new Date('2026-10-07T23:00:00+02:00'));
    await expect((await richiesta()).json()).resolves.toMatchObject({ skipped: 'prima_della_data' });
    expect(sendOutcome).not.toHaveBeenCalled();
    expect(eventoRun()).toBeTruthy();
  });
  it('non dipende da lancio_attivo: spento, restituisce lo stesso', async () => {
    stato.settings.lancio_attivo = false;
    await expect((await richiesta()).json()).resolves.toMatchObject({ restituiti: 2 });
  });
  it('evento illeggibile: config error', async () => {
    stato.settings.lancio_evento_at = 'boh';
    await expect((await richiesta()).json()).resolves.toMatchObject({ skipped: 'config' });
    expect(tipi()).toContain('lancio_restituzioni_config_error');
  });
  it('forza=1 e now= vogliono solo=', async () => {
    expect((await richiesta('forza=1')).status).toBe(400);
    expect((await richiesta('now=2026-10-20T10:00:00%2B02:00')).status).toBe(400);
  });
  it('forza=1&solo=<id> prima della data: solo quella conversazione', async () => {
    vi.setSystemTime(new Date('2026-10-07T23:00:00+02:00'));
    await expect((await richiesta('forza=1&solo=2')).json()).resolves.toMatchObject({ restituiti: 1 });
    expect(sendOutcome).toHaveBeenCalledTimes(1);
    expect(sendOutcome).toHaveBeenCalledWith(expect.anything(), 2, expect.anything());
  });
  it('dry: decide e conta, non chiama il CRM', async () => {
    const res = await (await richiesta('dry=1')).json();
    expect(res).toMatchObject({ dry: true, daRestituire: 2 });
    expect(res.motivi).toEqual({ mai_risposto: 2 });
    expect(sendOutcome).not.toHaveBeenCalled();
  });
  it('query fallita: queryKo e log', async () => {
    stato.convSelectError = { message: 'column does not exist', code: '42703' };
    await expect((await richiesta()).json()).resolves.toMatchObject({ queryKo: true, restituiti: 0 });
    expect(tipi()).toContain('lancio_restituzioni_query_error');
  });
});

describe('GET /api/cron/lancio-restituzioni — decisioni e CRM', () => {
  it('mai risposto: NON_RISPOSTO con la nota, fase restituito, ai_status closed, evento', async () => {
    stato.convs = [conv(1)];
    await expect((await richiesta()).json()).resolves.toMatchObject({ restituiti: 1, rifiutati: 0, errori: 0 });
    expect(sendOutcome).toHaveBeenCalledWith(expect.anything(), 1, { outcome: 'NON_RISPOSTO', note: 'Lancio: mai risposto' });
    expect(impostaFaseLancio).toHaveBeenCalledWith(expect.anything(), 1, 'restituito');
    const chiusura = chiamate.find((c) => c.table === 'conversations' && c.op === 'update' && (c.arg as Record<string, unknown>).ai_status === 'closed');
    expect(chiusura?.filtri).toContainEqual({ m: 'eq', args: ['id', 1] });
    const ev = eventi().find((e) => e.type === 'lancio_restituito');
    expect(ev?.payload).toMatchObject({ conversationId: 1, crmLeadId: 'crm-1', motivo: 'mai_risposto', status: 200 });
  });
  it('R2: ha interagito ma niente follow-up → "Lancio: follow-up non inviato"', async () => {
    stato.convs = [conv(1, { lancio_fase: 'link_inviato', last_inbound_at: '2026-09-21T10:00:00Z' })];
    stato.messaggi.set(1, [welcome(1), inb(1, 'si', '2026-09-21T10:00:00Z')]);
    await richiesta();
    expect(sendOutcome).toHaveBeenCalledWith(expect.anything(), 1, { outcome: 'NON_RISPOSTO', note: 'Lancio: follow-up non inviato' });
  });
  it('silenzio 48h dopo il follow-up → "Lancio: silenzio dopo il follow-up"', async () => {
    stato.convs = [conv(1, { lancio_fase: 'followup_inviato', lancio_followup_inviato_at: '2026-10-06T07:00:00Z', last_inbound_at: '2026-09-21T10:00:00Z' })];
    stato.messaggi.set(1, [welcome(1), inb(1, 'si', '2026-09-21T10:00:00Z')]);
    await richiesta();
    expect(sendOutcome).toHaveBeenCalledWith(expect.anything(), 1, { outcome: 'NON_RISPOSTO', note: 'Lancio: silenzio dopo il follow-up' });
  });
  it('un inbound solo prima dell ancora (chat riusata) e mai risposto per il lancio', async () => {
    stato.convs = [conv(1, { last_inbound_at: '2026-08-01T10:00:00Z' })];
    stato.messaggi.set(1, [inb(1, 'ciao', '2026-08-01T10:00:00Z'), welcome(1)]);
    await richiesta();
    expect(sendOutcome).toHaveBeenCalledWith(expect.anything(), 1, { outcome: 'NON_RISPOSTO', note: 'Lancio: mai risposto' });
  });
  it('ancora ignota (nessun benvenuto, nessun intake): non si tocca e si conta', async () => {
    stato.convs = [conv(1, { lancio_benvenuto_at: null })];
    stato.messaggi.set(1, [inb(1, 'si', '2026-09-21T10:00:00Z')]);
    const res = await (await richiesta()).json();
    expect(sendOutcome).not.toHaveBeenCalled();
    expect(res.niente.ancora_ignota).toBe(1);
    expect(leggiIngressoLancioAt).toHaveBeenCalledWith(expect.anything(), 1);
  });
  it('C2: congedo uscito e fase attesa → ritenta lo scarto senza bolla; con bot_outcome gia scritto solo la fase', async () => {
    stato.convs = [
      conv(1, { lancio_info: { congedo_at: '2026-10-05T23:00:00Z' } }),
      conv(2, { lancio_fase: 'link_inviato', lancio_info: { congedo_at: '2026-10-05T23:30:00Z' }, bot_outcome: 'DA_SCARTARE' }),
    ];
    const res = await (await richiesta()).json();
    expect(res).toMatchObject({ scartiRitentati: 1, scartiChiusi: 1, restituiti: 0 });
    expect(congedoLancio).toHaveBeenCalledTimes(1);
    expect(congedoLancio).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ conversationId: 1 }), '', expect.stringContaining('Lancio Web Dev AI'), { giaInviato: true });
    expect(impostaFaseLancio).toHaveBeenCalledWith(expect.anything(), 2, 'chiuso');
    expect(sendOutcome).not.toHaveBeenCalled();
    expect(tipi()).toContain('lancio_scarto_ritentato_da_cron');
  });
  it('200 con returnedToPool:false e skipped (locked_appointment, scelta_fatta): warn, fase INTATTA, nessun restituito', async () => {
    stato.convs = [conv(1), conv(2)];
    sendOutcome
      .mockResolvedValueOnce({ sent: true, status: 200, corpo: { ok: true, returnedToPool: false, skipped: 'locked_appointment' } })
      .mockResolvedValueOnce({ sent: true, status: 200, corpo: { ok: true, returnedToPool: false, skipped: 'scelta_fatta' } });
    await expect((await richiesta()).json()).resolves.toMatchObject({ restituiti: 0, rifiutateDalCrm: 2, errori: 0 });
    expect(impostaFaseLancio).not.toHaveBeenCalled();
    const rifiuti = eventi().filter((e) => e.type === 'lancio_restituzione_rifiutata');
    expect(rifiuti).toHaveLength(2);
    expect(rifiuti[0]?.level).toBe('warn');
    expect(rifiuti.map((e) => (e.payload as Record<string, unknown>).skipped).sort()).toEqual(['locked_appointment', 'scelta_fatta']);
  });
  it('200 already_returned: e un doppione, si segna restituito e non si ritenta', async () => {
    stato.convs = [conv(1)];
    sendOutcome.mockResolvedValueOnce({ sent: true, status: 200, corpo: { ok: true, returnedToPool: false, skipped: 'already_returned' } });
    await expect((await richiesta()).json()).resolves.toMatchObject({ restituiti: 0, giaRestituiti: 1 });
    expect(impostaFaseLancio).toHaveBeenCalledWith(expect.anything(), 1, 'restituito');
  });
  it('200 senza corpo leggibile non e una conferma: warn e fase intatta', async () => {
    stato.convs = [conv(1)];
    sendOutcome.mockResolvedValueOnce({ sent: true, status: 200 });
    await expect((await richiesta()).json()).resolves.toMatchObject({ restituiti: 0, nonConfermate: 1 });
    expect(impostaFaseLancio).not.toHaveBeenCalled();
    expect(tipi()).toContain('lancio_restituzione_rifiutata');
  });
  it('403/404 del CRM sono terminali: restituito lo stesso, contato fra i rifiutati', async () => {
    stato.convs = [conv(1), conv(2)];
    sendOutcome.mockResolvedValueOnce({ sent: false, status: 403, error: 'http_403' }).mockResolvedValueOnce({ sent: false, status: 404, error: 'http_404' });
    await expect((await richiesta()).json()).resolves.toMatchObject({ restituiti: 0, rifiutati: 2, errori: 0 });
    expect(impostaFaseLancio).toHaveBeenCalledTimes(2);
  });
  it('rete o 5xx: nessuna fase scritta, errore contato, si riprova al run dopo', async () => {
    stato.convs = [conv(1)];
    sendOutcome.mockResolvedValueOnce({ sent: false, error: 'fetch failed' });
    await expect((await richiesta()).json()).resolves.toMatchObject({ restituiti: 0, errori: 1 });
    expect(impostaFaseLancio).not.toHaveBeenCalled();
    expect(tipi()).toContain('lancio_restituzione_error');
  });
  it('cronologia troncata dal tetto righe: nessuna decisione sul blocco, warn e ancora_ignota', async () => {
    // Il troncamento porta via le righe PIU' NUOVE (ordine crescente): una chat letta a
    // meta' sembrerebbe "mai risposto" e finirebbe nel pool con la nota sbagliata, che e'
    // irreversibile. Su una lettura tagliata non si decide niente.
    stato.convs = [conv(1)];
    const tante: Riga[] = [welcome(1)];
    for (let k = 0; k < 8000; k++) tante.push(inb(1, 'si', '2026-09-21T10:00:00Z'));
    stato.messaggi.set(1, tante);
    const res = await (await richiesta()).json();
    expect(sendOutcome).not.toHaveBeenCalled();
    expect(res.niente.ancora_ignota).toBe(1);
    expect(res.blocchiTroncati).toBe(1);
    expect(tipi()).toContain('lancio_restituzioni_blocco_troncato');
  });
  it('un esito gia presente non si tocca', async () => {
    stato.convs = [conv(1, { bot_outcome: 'APPUNTAMENTO' })];
    const res = await (await richiesta()).json();
    expect(sendOutcome).not.toHaveBeenCalled();
    expect(res.niente.esito_presente).toBe(1);
  });
  it('il tetto del lotto lascia il resto al run dopo', async () => {
    vi.stubEnv('LANCIO_BATCH_MAX', '1');
    stato.convs = [conv(1), conv(2)];
    await expect((await richiesta()).json()).resolves.toMatchObject({ restituiti: 1, residui: 0, nonValutati: 1 });
  });
});
