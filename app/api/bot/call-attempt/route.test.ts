import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─────────────────────────── finto Supabase ───────────────────────────
// Registra ogni chiamata (tabella, operazione, payload) così i test possono
// interrogare non solo quello che è stato scritto, ma anche quello che NON è stato
// scritto: l'invariante "bot_outcome non si tocca mai" è un'asserzione sul secondo.

type Chiamata = { table: string; op: 'select' | 'insert' | 'update'; arg: unknown };
const chiamate: Chiamata[] = [];

/** Righe che le select devono restituire, per tabella+colonne. Riscritte da ogni test. */
const righe = {
  conversazione: [] as unknown[],
  ultimoInbound: [] as unknown[],
  giaInviato: [] as unknown[],
  cronologia: [] as unknown[],
};

function datiPer(rec: Chiamata): unknown[] | null {
  if (rec.op !== 'select') return null;
  const sel = String(rec.arg);
  if (rec.table === 'conversations') return righe.conversazione;
  if (rec.table === 'messages') return sel.includes('direction') ? righe.cronologia : righe.ultimoInbound;
  if (rec.table === 'event_log') return righe.giaInviato;
  return [];
}

function query(table: string, op: Chiamata['op'], arg: unknown) {
  const rec: Chiamata = { table, op, arg };
  chiamate.push(rec);
  const q: Record<string, unknown> = {};
  for (const m of ['eq', 'is', 'or', 'gte', 'lte', 'in', 'not', 'order', 'limit', 'single', 'maybeSingle', 'ilike']) {
    q[m] = () => q;
  }
  q.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) =>
    Promise.resolve({ data: datiPer(rec), error: null }).then(ok, ko);
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

// ─────────────────────────── finti invii ───────────────────────────
const sendFreeText = vi.fn();
const sendTemplate = vi.fn();
vi.mock('@/lib/twilio', () => ({
  sendFreeText: (...a: unknown[]) => sendFreeText(...a),
  sendTemplate: (...a: unknown[]) => sendTemplate(...a),
  getTemplateBody: async () => null,
  assertTemplateSendable: async () => {},
}));

const generateMarioReply = vi.fn();
vi.mock('@/lib/mario', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  generateMarioReply: (...a: unknown[]) => generateMarioReply(...a),
}));

import { POST } from './route';
import { signPayload } from '@/lib/bot-hmac';

const SEGRETO = 'segreto-di-test';
const LEAD = 'crm-1';
const APPUNTAMENTO = '2026-08-29T15:00:00+02:00';
const QUANDO = 'sabato 29 agosto alle 15:00';
const NR1 = 'HX111';
const NR3 = 'HX333';

const firmato = (corpo: unknown) => {
  const body = JSON.stringify(corpo);
  return POST(new Request('https://x/api/bot/call-attempt', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bot-signature': signPayload(body, SEGRETO) },
    body,
  }) as never);
};

const evento = (tentativo = 1) => ({
  leadId: LEAD,
  esito: 'no_answer',
  tentativo,
  at: new Date(Date.now() - 5 * 60_000).toISOString().replace('Z', '+00:00'),
  appointmentAt: APPUNTAMENTO,
});

/** Il lead ha scritto `oreFa` ore fa: è la leva che sceglie il ramo. */
function scenario(oreFa: number | null) {
  righe.conversazione = [{
    id: 42,
    ai_owner: 'mario',
    ai_status: 'closed',
    bot_outcome: 'APPUNTAMENTO',
    bot_scheduled_at: APPUNTAMENTO,
    cancel_requested_at: null,
    ai_started_at: '2026-08-20T09:00:00+02:00',
    leads: { phone_e164: '+393331112233', first_name: 'mario rossi' },
  }];
  righe.ultimoInbound = oreFa === null ? [] : [{ created_at: new Date(Date.now() - oreFa * 3600_000).toISOString() }];
  righe.giaInviato = [];
  righe.cronologia = [
    { direction: 'out', body: 'Ciao Mario', template_sid: 'HXapertura', created_at: '2026-08-20T09:00:00Z' },
    { direction: 'in', body: 'va bene', template_sid: null, created_at: '2026-08-20T09:05:00Z' },
  ];
}

const eventiScritti = () => chiamate.filter((c) => c.table === 'event_log' && c.op === 'insert')
  .map((c) => c.arg as { type: string; payload: Record<string, unknown> });
const aggiornamenti = () => chiamate.filter((c) => c.table === 'conversations' && c.op === 'update')
  .map((c) => c.arg as Record<string, unknown>);

beforeEach(() => {
  vi.stubEnv('BOT_WEBHOOK_SECRET', SEGRETO);
  vi.stubEnv('TWILIO_WHATSAPP_NUMBER_FENICE', 'whatsapp:+393520158061');
  vi.stubEnv('NR1_TEMPLATE_SID', NR1);
  vi.stubEnv('NR3_TEMPLATE_SID', NR3);
  chiamate.length = 0;
  sendFreeText.mockReset().mockResolvedValue({ sid: 'SMlibero', status: 'queued' });
  sendTemplate.mockReset().mockResolvedValue({ sid: 'SMtemplate', status: 'queued' });
  generateMarioReply.mockReset().mockResolvedValue({
    visibleReply: 'Ciao Mario, ti abbiamo provato a chiamare per la call.',
    appointmentFixed: false, passToHuman: false, videoWatched: false,
  });
  scenario(2);
});
afterEach(() => { vi.unstubAllEnvs(); });

describe('POST /api/bot/call-attempt — i due rami di invio', () => {
  it('dentro la finestra: messaggio libero di Marta, nessun template', async () => {
    scenario(2);
    const res = await firmato(evento(1));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, inviato: true, ramo: 'libero' });
    expect(generateMarioReply).toHaveBeenCalledOnce();
    expect(sendFreeText).toHaveBeenCalled();
    expect(sendTemplate).not.toHaveBeenCalled();
  });

  it('dentro la finestra: al modello arriva il contesto della chiamata a vuoto', async () => {
    scenario(2);
    await firmato(evento(1));
    const nota = String((generateMarioReply.mock.calls[0][1] as { contextNote?: string }).contextNote);
    expect(nota).toContain(QUANDO);
    expect(nota).not.toMatch(/disturb/i);
  });

  it('fuori dalla finestra: template NR1 con nome proprio e data leggibile', async () => {
    scenario(30);
    const res = await firmato(evento(1));
    await expect(res.json()).resolves.toEqual({ ok: true, inviato: true, ramo: 'template' });
    expect(generateMarioReply).not.toHaveBeenCalled();
    expect(sendTemplate).toHaveBeenCalledWith(
      expect.objectContaining({
        contentSid: NR1,
        to: '+393331112233',
        // Il CRM manda nome e cognome in un campo solo: negli invii esce solo il nome.
        variables: { '1': 'Mario', '2': QUANDO },
      }),
    );
  });

  it('lead che non ha mai scritto: fuori dalla finestra, quindi template', async () => {
    scenario(null);
    await firmato(evento(1));
    expect(sendTemplate).toHaveBeenCalled();
    expect(sendFreeText).not.toHaveBeenCalled();
  });

  it('terzo tentativo fuori dalla finestra: template NR3', async () => {
    scenario(30);
    await firmato(evento(3));
    expect(sendTemplate).toHaveBeenCalledWith(expect.objectContaining({ contentSid: NR3 }));
  });

  it('terzo tentativo dentro la finestra: al modello si dice che è l\'ultimo', async () => {
    scenario(2);
    await firmato(evento(3));
    const nota = String((generateMarioReply.mock.calls[0][1] as { contextNote?: string }).contextNote);
    expect(nota).toMatch(/annull/i);
  });
});

describe('POST /api/bot/call-attempt — l\'invariante: una volta fissato resta Preso', () => {
  const VIETATE = ['bot_outcome', 'bot_outcome_at', 'bot_scheduled_at'];

  it('ramo libero: nessuna update tocca l\'esito o la data dell\'appuntamento', async () => {
    scenario(2);
    await firmato(evento(1));
    expect(aggiornamenti().length).toBeGreaterThan(0);
    for (const u of aggiornamenti()) for (const k of VIETATE) expect(u).not.toHaveProperty(k);
  });

  it('ramo template: nessuna update tocca l\'esito o la data dell\'appuntamento', async () => {
    scenario(30);
    await firmato(evento(1));
    expect(aggiornamenti().length).toBeGreaterThan(0);
    for (const u of aggiornamenti()) for (const k of VIETATE) expect(u).not.toHaveProperty(k);
  });

  it('ramo bloccato da una guardia: non si scrive nemmeno su conversations', async () => {
    scenario(2);
    righe.conversazione = [{ ...(righe.conversazione[0] as object), cancel_requested_at: '2026-08-27T10:00:00+02:00' }];
    const res = await firmato(evento(1));
    await expect(res.json()).resolves.toMatchObject({ inviato: false, motivo: 'disdetta_chiesta' });
    expect(aggiornamenti()).toEqual([]);
  });

  it('invio fallito: nessuna update tocca l\'esito, e ai_status resta com\'era', async () => {
    scenario(2);
    sendFreeText.mockRejectedValue(new Error('twilio giù'));
    await firmato(evento(1));
    for (const u of aggiornamenti()) {
      for (const k of VIETATE) expect(u).not.toHaveProperty(k);
      expect(u).not.toHaveProperty('ai_status');
    }
  });
});

describe('POST /api/bot/call-attempt — riapertura e lucchetto', () => {
  it('messaggio partito: ai_status torna active, così la sua risposta viene lavorata', async () => {
    scenario(2);
    await firmato(evento(1));
    expect(aggiornamenti().some((u) => u.ai_status === 'active')).toBe(true);
  });

  it('messaggio partito: recupero_nr_inviato è il lucchetto, con ramo e sid', async () => {
    scenario(2);
    await firmato(evento(1));
    const ev = eventiScritti().find((e) => e.type === 'recupero_nr_inviato');
    expect(ev?.payload).toMatchObject({
      conversationId: 42, crmLeadId: LEAD, tentativo: 1, ramo: 'libero', sid: 'SMlibero',
    });
  });

  it('template mancante (in attesa di Meta): si risponde, non si rompe', async () => {
    scenario(30);
    vi.stubEnv('NR1_TEMPLATE_SID', '');
    const res = await firmato(evento(1));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, inviato: false, motivo: 'template_non_configurato' });
    expect(sendTemplate).not.toHaveBeenCalled();
    expect(eventiScritti().map((e) => e.type)).toContain('recupero_nr_template_mancante');
    // Nessun lucchetto: quando i template saranno approvati questo lead va ritentato.
    expect(eventiScritti().map((e) => e.type)).not.toContain('recupero_nr_inviato');
    expect(aggiornamenti().some((u) => 'ai_status' in u)).toBe(false);
  });

  it('invio libero fallito: send_error, nessun lucchetto, motivo invio_fallito', async () => {
    scenario(2);
    sendFreeText.mockRejectedValue(new Error('twilio giù'));
    const res = await firmato(evento(1));
    await expect(res.json()).resolves.toEqual({ ok: true, inviato: false, motivo: 'invio_fallito' });
    expect(eventiScritti().map((e) => e.type)).toContain('send_error');
    expect(eventiScritti().map((e) => e.type)).not.toContain('recupero_nr_inviato');
  });

  it('invio template fallito: nessun lucchetto, motivo invio_fallito', async () => {
    scenario(30);
    sendTemplate.mockRejectedValue(new Error('twilio giù'));
    const res = await firmato(evento(1));
    await expect(res.json()).resolves.toEqual({ ok: true, inviato: false, motivo: 'invio_fallito' });
    expect(eventiScritti().map((e) => e.type)).not.toContain('recupero_nr_inviato');
  });

  it('modello che non produce niente da dire: non si finge un invio', async () => {
    scenario(2);
    generateMarioReply.mockResolvedValue({ visibleReply: '   ', appointmentFixed: false, passToHuman: false, videoWatched: false });
    const res = await firmato(evento(1));
    await expect(res.json()).resolves.toEqual({ ok: true, inviato: false, motivo: 'invio_fallito' });
    expect(sendFreeText).not.toHaveBeenCalled();
    expect(eventiScritti().map((e) => e.type)).not.toContain('recupero_nr_inviato');
  });

  it('numero Fenice non configurato: si logga e non si manda dal numero sbagliato', async () => {
    scenario(2);
    vi.stubEnv('TWILIO_WHATSAPP_NUMBER_FENICE', '');
    const res = await firmato(evento(1));
    await expect(res.json()).resolves.toEqual({ ok: true, inviato: false, motivo: 'invio_fallito' });
    expect(sendFreeText).not.toHaveBeenCalled();
    expect(eventiScritti().map((e) => e.type)).toContain('send_error');
  });
});
