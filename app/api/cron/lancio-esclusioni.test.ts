import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * I cron di Mario e le chat del lancio "Web Developer AI".
 *
 * Le conversazioni del lancio restano `ai_owner='mario'` e `ai_status='active'`: senza
 * un filtro esplicito ogni cron di Mario le pescherebbe e ci scriverebbe sopra — la sua
 * apertura, un touch di sequenza, un promemoria, un sollecito video. Qui si verifica il
 * filtro DOVE conta, cioè nella query dei candidati: non si controlla che la stringa sia
 * stata passata, si applicano davvero i filtri della route a righe finte e si guarda chi
 * ne esce.
 *
 * Tre righe per ogni cron: una chat del lancio in corso (deve sparire), una con il
 * lancio `chiuso` (deve restare: fase terminale = la chat torna a Mario) e una che col
 * lancio non c'entra niente (deve restare, il traffico normale non si tocca).
 */

// ─────────────────────────── finto Supabase con filtri veri ───────────────────────────

type Riga = Record<string, unknown>;
type Predicato = (r: Riga) => boolean;

const stato = {
  righe: {} as Record<string, Riga[]>,
  /** Ogni select andata a buon fine, con gli id delle righe restituite. */
  letture: [] as { table: string; ids: unknown[] }[],
};

const testo = (v: unknown): string => (v == null ? '' : String(v));

/** Spezza una `.or()` PostgREST sulle virgole di primo livello: `in.(a,b)` resta intero. */
function termini(espressione: string): string[] {
  const out: string[] = [];
  let profondita = 0;
  let corrente = '';
  for (const ch of espressione) {
    if (ch === '(') profondita++;
    if (ch === ')') profondita--;
    if (ch === ',' && profondita === 0) { out.push(corrente); corrente = ''; continue; }
    corrente += ch;
  }
  if (corrente) out.push(corrente);
  return out;
}

/** Un termine `colonna.operatore.valore` come lo intende PostgREST. */
function predicatoDaTermine(t: string): Predicato {
  const i1 = t.indexOf('.');
  const colonna = t.slice(0, i1);
  const resto = t.slice(i1 + 1);
  const i2 = resto.indexOf('.');
  const op = resto.slice(0, i2);
  const valore = resto.slice(i2 + 1);
  if (op === 'is') return (r) => (valore === 'null' ? r[colonna] == null : testo(r[colonna]) === valore);
  if (op === 'eq') return (r) => testo(r[colonna]) === valore;
  if (op === 'in') {
    const valori = valore.replace(/^\(|\)$/g, '').split(',').map((v) => v.trim());
    return (r) => valori.includes(testo(r[colonna]));
  }
  throw new Error(`operatore .or() non gestito dal finto Supabase: ${op}`);
}

type Query = {
  table: string;
  op: 'select' | 'insert' | 'update';
  preds: Predicato[];
  range: [number, number] | null;
  limite: number | null;
  singola: boolean;
};

function esegui(q: Query): { data: unknown; error: null } {
  if (q.op !== 'select') return { data: [], error: null };
  let righe = (stato.righe[q.table] ?? []).filter((r) => q.preds.every((p) => p(r)));
  if (q.range) righe = righe.slice(q.range[0], q.range[1] + 1);
  if (q.limite !== null) righe = righe.slice(0, q.limite);
  stato.letture.push({ table: q.table, ids: righe.map((r) => r.id ?? r.conversation_id) });
  return { data: q.singola ? (righe[0] ?? null) : righe, error: null };
}

function query(table: string, op: Query['op']): Record<string, unknown> {
  const q: Query = { table, op, preds: [], range: null, limite: null, singola: false };
  const b: Record<string, unknown> = {};
  const self = () => b;
  b.select = self;
  b.order = self;
  // `ilike` non serve a queste asserzioni (le fixture messages sono vuote dove compare)
  // e simularlo darebbe una falsa precisione: qui non filtra.
  b.ilike = self;
  b.eq = (c: string, v: unknown) => { q.preds.push((r) => testo(r[c]) === testo(v)); return b; };
  b.neq = (c: string, v: unknown) => { q.preds.push((r) => testo(r[c]) !== testo(v)); return b; };
  b.is = (c: string, v: unknown) => { q.preds.push((r) => (v === null ? r[c] == null : r[c] === v)); return b; };
  b.not = (c: string, op2: string, v: unknown) => {
    if (op2 === 'is') {
      q.preds.push((r) => (v === null ? r[c] != null : r[c] !== v));
      return b;
    }
    if (op2 === 'in') {
      // `.not('col', 'in', '(a,b)')`: la lista arriva come stringa PostgREST.
      const valori = testo(v).replace(/^\(|\)$/g, '').split(',').map((s) => s.trim());
      q.preds.push((r) => !valori.includes(testo(r[c])));
      return b;
    }
    throw new Error(`.not(${op2}) non gestito dal finto Supabase`);
  };
  b.in = (c: string, v: unknown[]) => { q.preds.push((r) => v.map(testo).includes(testo(r[c]))); return b; };
  b.gte = (c: string, v: unknown) => { q.preds.push((r) => testo(r[c]) >= testo(v)); return b; };
  b.lte = (c: string, v: unknown) => { q.preds.push((r) => testo(r[c]) <= testo(v)); return b; };
  b.gt = (c: string, v: unknown) => { q.preds.push((r) => testo(r[c]) > testo(v)); return b; };
  b.lt = (c: string, v: unknown) => { q.preds.push((r) => testo(r[c]) < testo(v)); return b; };
  b.or = (espressione: string) => {
    const parti = termini(espressione).map(predicatoDaTermine);
    // Un `.or()` è UN gruppo, e i gruppi si sommano in AND agli altri filtri.
    q.preds.push((r) => parti.some((p) => p(r)));
    return b;
  };
  b.limit = (n: number) => { q.limite = n; return b; };
  b.range = (a: number, z: number) => { q.range = [a, z]; return b; };
  b.single = () => { q.singola = true; return b; };
  b.maybeSingle = () => { q.singola = true; return b; };
  b.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) =>
    Promise.resolve(esegui(q)).then(ok, ko);
  return b;
}

const finto = {
  from: (table: string) => ({
    select: () => query(table, 'select'),
    insert: () => query(table, 'insert'),
    update: () => query(table, 'update'),
  }),
};

vi.mock('@/lib/supabase/admin', () => ({ getSupabaseAdmin: () => finto }));

// ─────────────────────────── finti invii ───────────────────────────

const sendTemplate = vi.fn();
const sendFreeText = vi.fn();
const sendTemplateAndLog = vi.fn();
const enrollLeadIntoMario = vi.fn();

vi.mock('@/lib/twilio', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  sendTemplate: (...a: unknown[]) => sendTemplate(...a),
  sendFreeText: (...a: unknown[]) => sendFreeText(...a),
  getTemplateBody: async () => null,
  assertTemplateSendable: async () => undefined,
}));
vi.mock('@/lib/messaging', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  sendTemplateAndLog: (...a: unknown[]) => sendTemplateAndLog(...a),
}));
vi.mock('@/lib/fenice-enroll', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  enrollLeadIntoMario: (...a: unknown[]) => enrollLeadIntoMario(...a),
}));
vi.mock('@/lib/stop-crm', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  stopDalCrmPerLead: async () => null,
}));
vi.mock('@/lib/bot-outcome', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  sendOutcome: async () => ({ ok: true }),
}));

import { GET as sequenceTouches } from './sequence-touches/route';
import { GET as precallReminders } from './precall-reminders/route';
import { GET as gdoVideoFollowups } from './gdo-video-followups/route';
import { POST as riapriMute } from './riapri-mute/route';

// ─────────────────────────── fixture ───────────────────────────

const SEGRETO = 'segreto-di-test';
// 10:00 Europe/Rome: dentro la fascia aperture della sequenza e dentro lo slot
// "mattina" dei solleciti video dei GDO.
const ADESSO = new Date('2026-09-20T08:00:00Z');
const H = 3600_000;

const IN_CORSO = { lancio_slug: 'webdev-2026-10', lancio_fase: 'attesa' };
const CHIUSO = { lancio_slug: 'webdev-2026-10', lancio_fase: 'chiuso' };
const NIENTE_LANCIO = { lancio_slug: null, lancio_fase: null };

const tel = (id: number) => `+39333000${String(id).padStart(4, '0')}`;
const leads = (id: number) => ({ phone_e164: tel(id), first_name: 'mario' });

/** Gli id delle conversazioni che la route si è portata a casa dalla sua query. */
const convLette = (): unknown[] =>
  stato.letture.filter((l) => l.table === 'conversations').flatMap((l) => l.ids);

const richiestaGet = (route: (req: never) => Promise<Response>, path: string) =>
  route({
    headers: new Headers({ authorization: `Bearer ${SEGRETO}` }),
    nextUrl: new URL(`https://x${path}`),
  } as never);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(ADESSO);
  stato.righe = {};
  stato.letture = [];
  sendTemplate.mockReset();
  sendTemplate.mockResolvedValue({ sid: 'SMtest', status: 'queued' });
  sendFreeText.mockReset();
  sendFreeText.mockResolvedValue({ sid: 'SMtest', status: 'queued' });
  sendTemplateAndLog.mockReset();
  sendTemplateAndLog.mockResolvedValue({ ok: true, sid: 'SMtest' });
  enrollLeadIntoMario.mockReset();
  enrollLeadIntoMario.mockResolvedValue({ ok: true });
  process.env.CRON_SECRET = SEGRETO;
  process.env.TWILIO_WHATSAPP_NUMBER_FENICE = 'whatsapp:+390000000';
});

afterEach(() => {
  vi.useRealTimers();
});

// ─────────────────────────── sequence-touches ───────────────────────────

describe('sequence-touches: niente apertura né touch alle chat del lancio', () => {
  const conv = (id: number, lancio: Riga): Riga => ({
    id,
    ai_status: 'active',
    ai_started_at: null,
    ai_paused_at: null,
    crm_lead_id: `crm-${id}`,
    crm_funnel: null,
    bot_outcome: null,
    bot_followups_sent: 0,
    gdo_agenda_at: null,
    leads: leads(id),
    ...lancio,
  });

  beforeEach(() => {
    process.env.SEQUENCE_ENABLED = '1';
    process.env.FENICE_OPENING_TEMPLATE_SID = 'HXapertura';
    delete process.env.NEW_OPENING_ENABLED;
    for (const i of [1, 2, 3, 4]) process.env[`SEQ_TEMPLATE_SID_${i}`] = `HXseq${i}`;
    stato.righe.conversations = [
      conv(1, IN_CORSO), conv(2, CHIUSO), conv(3, NIENTE_LANCIO),
      // Il controllo che il nuovo `.or()` non allarghi la selezione: questa è in
      // pausa manuale e col lancio chiuso, e deve restare fuori lo stesso.
      { ...conv(4, CHIUSO), ai_paused_at: '2026-09-19T10:00:00Z' },
    ];
    // Nessun messaggio: per Track A è il caso "apertura mai partita", cioè proprio
    // l'apertura di Mario che sul lancio non deve uscire.
    stato.righe.messages = [];
  });

  it('il lancio in corso non è nemmeno candidato; chiuso e non-lancio sì', async () => {
    const body = await (await richiestaGet(sequenceTouches, '/api/cron/sequence-touches')).json();
    expect(convLette()).toEqual([2, 3]);
    expect(body.sent).toBe(2);
  });

  it("l'apertura Track A parte solo verso chi è fuori dal lancio", async () => {
    await richiestaGet(sequenceTouches, '/api/cron/sequence-touches');
    const destinatari = sendTemplate.mock.calls.map((c) => (c[0] as { to: string }).to);
    expect(destinatari).toEqual([tel(2), tel(3)]);
    expect(destinatari).not.toContain(tel(1));
  });
});

// ─────────────────────────── precall-reminders ───────────────────────────

describe('precall-reminders: nessun promemoria sulle chat del lancio', () => {
  const conv = (id: number, lancio: Riga): Riga => ({
    id,
    bot_outcome: 'APPUNTAMENTO',
    // T-2h: il promemoria T-3h è dovuto, quello T-24h già passato.
    bot_scheduled_at: new Date(ADESSO.getTime() + 2 * H).toISOString(),
    ai_paused_at: null,
    cancel_requested_at: null,
    leads: leads(id),
    ...lancio,
  });

  beforeEach(() => {
    process.env.PRECALL_REMINDERS_ENABLED = '1';
    process.env.REMINDER_24H_TEMPLATE_SID = 'HX24';
    process.env.REMINDER_3H_TEMPLATE_SID = 'HX3';
    stato.righe.conversations = [
      conv(1, IN_CORSO), conv(2, CHIUSO), conv(3, NIENTE_LANCIO),
      // Disdetta chiesta e lancio chiuso: il nuovo `.or()` non deve ripescarla.
      { ...conv(4, CHIUSO), cancel_requested_at: '2026-09-19T10:00:00Z' },
    ];
    stato.righe.messages = [];
  });

  it('il lancio in corso resta fuori dai candidati, il lancio chiuso no', async () => {
    const body = await (await richiestaGet(precallReminders, '/api/cron/precall-reminders')).json();
    expect(convLette()).toEqual([2, 3]);
    expect(body.sent).toBe(2);
  });

  it('il promemoria non arriva a una chat del lancio', async () => {
    await richiestaGet(precallReminders, '/api/cron/precall-reminders');
    const destinatari = sendTemplateAndLog.mock.calls.map((c) => c[2]);
    expect(destinatari).toEqual([tel(2), tel(3)]);
  });
});

// ─────────────────────────── gdo-video-followups ───────────────────────────

describe('gdo-video-followups: nessun sollecito sulle chat del lancio', () => {
  const conv = (id: number, lancio: Riga): Riga => ({
    id,
    gdo_agenda_at: new Date(ADESSO.getTime() - 2 * H).toISOString(),
    gdo_video_url: 'https://corso.feniceacademy.it/conferenza-1',
    gdo_video_sent_at: null,
    gdo_video_watched_at: null,
    gdo_video_followups_sent: 0,
    gdo_noemi_reminded_at: null,
    gdo_appuntamento_at: null,
    bot_scheduled_at: null,
    ai_started_at: null,
    ai_status: 'active',
    ai_paused_at: null,
    cancel_requested_at: null,
    leads: leads(id),
    ...lancio,
  });

  beforeEach(() => {
    process.env.GDO_VIDEO_FOLLOWUPS_ENABLED = '1';
    stato.righe.conversations = [conv(1, IN_CORSO), conv(2, CHIUSO), conv(3, NIENTE_LANCIO)];
    stato.righe.messages = [];
  });

  it('il lancio in corso non entra nel giro dei solleciti, il lancio chiuso sì', async () => {
    await richiestaGet(gdoVideoFollowups, '/api/cron/gdo-video-followups');
    expect(convLette()).toEqual([2, 3]);
  });
});

// ─────────────────────────── riapri-mute ───────────────────────────

describe('riapri-mute: le chat mute del lancio non si riaprono con Mario', () => {
  const conv = (id: number, lancio: Riga): Riga => ({
    id,
    crm_lead_id: `crm-${id}`,
    crm_funnel: null,
    lead_id: id,
    ai_owner: 'mario',
    ai_started_at: '2026-09-01T10:00:00Z',
    ai_status: 'active',
    bot_outcome: null,
    ...lancio,
  });

  beforeEach(() => {
    stato.righe.conversations = [conv(1, IN_CORSO), conv(2, CHIUSO), conv(3, NIENTE_LANCIO)];
    // Un out tentato e mai partito (nessun SID): è il criterio della "chat muta".
    stato.righe.messages = [1, 2, 3].map((id) => ({
      id, conversation_id: id, direction: 'out', twilio_sid: null,
    }));
    stato.righe.leads = [1, 2, 3].map((id) => ({
      id, phone_e164: tel(id), first_name: 'mario', email: null,
    }));
  });

  const richiesta = (corpo: Record<string, unknown>) =>
    riapriMute({
      headers: new Headers({ authorization: `Bearer ${SEGRETO}` }),
      json: async () => corpo,
    } as never);

  it("l'apertura di Mario non torna sulle chat del lancio in corso", async () => {
    const body = await (await richiesta({ esegui: true, dal: '2026-08-24' })).json();
    expect(convLette()).toEqual([2, 3]);
    expect(body.esaminate).toBe(2);
    const numeri = enrollLeadIntoMario.mock.calls.map((c) => (c[1] as { phone: string }).phone);
    expect(numeri).toEqual([tel(2), tel(3)]);
  });
});
