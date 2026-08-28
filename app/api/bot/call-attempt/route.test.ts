import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─────────────────────────── finto Supabase ───────────────────────────
// Registra ogni chiamata (tabella, operazione, payload) così i test possono
// interrogare non solo quello che è stato scritto, ma anche quello che NON è stato
// scritto: l'invariante "bot_outcome non si tocca mai" è un'asserzione sul secondo.
//
// `event_log` non è finto fino in fondo come le altre tabelle: le righe restano, gli
// `.eq()` filtrano davvero, e c'è l'indice unique parziale della migration
// 20260828000001. Senza tutto questo il giro scrivi-lucchetto / rileggi-lucchetto non
// sarebbe coperto da niente, e il claim atomico non sarebbe verificabile.

type Chiamata = { table: string; op: 'select' | 'insert' | 'update' | 'delete'; arg: unknown };
type Filtro = [string, string];
const chiamate: Chiamata[] = [];

/** Righe che le select devono restituire, per tabella+colonne. Riscritte da ogni test. */
const righe = {
  conversazione: [] as unknown[],
  ultimoInbound: [] as unknown[],
  cronologia: [] as unknown[],
};

type RigaEvento = { id: number; type: string; payload: Record<string, unknown> } & Record<string, unknown>;
const eventLog: RigaEvento[] = [];
let prossimoIdEvento = 1;

/**
 * Il doppio clic vero: l'altra richiesta ha già scritto il lucchetto, ma la nostra
 * select era partita prima e non lo vede. È l'unico modo di provare che a fermare il
 * secondo invio è la insert, non la lettura.
 */
let lucchettoInvisibileAllaSelect = false;

/** `payload->>chiave` come lo legge Postgres. */
function valoreColonna(riga: RigaEvento, colonna: string): string | undefined {
  const json = colonna.match(/^payload->>(.+)$/);
  const v = json ? riga.payload?.[json[1]] : riga[colonna];
  return v == null ? undefined : String(v);
}

const combacia = (r: RigaEvento, filtri: Filtro[]) =>
  filtri.every(([colonna, valore]) => valoreColonna(r, colonna) === valore);

/** L'indice unique parziale della migration: (conversationId, tentativo) per il solo
 *  type `recupero_nr_inviato`. Chi arriva secondo si prende un 23505. */
function violaIndiceUnico(riga: RigaEvento): boolean {
  if (riga.type !== 'recupero_nr_inviato') return false;
  return eventLog.some((r) =>
    r.type === 'recupero_nr_inviato'
    && String(r.payload?.conversationId) === String(riga.payload?.conversationId)
    && String(r.payload?.tentativo) === String(riga.payload?.tentativo));
}

function esegui(rec: Chiamata, filtri: Filtro[]): { data: unknown; error: unknown } {
  if (rec.table === 'event_log') {
    if (rec.op === 'insert') {
      const riga = { id: prossimoIdEvento++, ...(rec.arg as object) } as RigaEvento;
      if (violaIndiceUnico(riga)) {
        return {
          data: null,
          error: { code: '23505', message: 'duplicate key value violates unique constraint "event_log_recupero_nr_inviato_uniq"' },
        };
      }
      eventLog.push(riga);
      return { data: [riga], error: null };
    }
    if (rec.op === 'select') {
      const visibili = lucchettoInvisibileAllaSelect
        ? eventLog.filter((r) => r.type !== 'recupero_nr_inviato')
        : eventLog;
      return { data: visibili.filter((r) => combacia(r, filtri)), error: null };
    }
    if (rec.op === 'update') {
      for (const r of eventLog) if (combacia(r, filtri)) Object.assign(r, rec.arg as object);
      return { data: null, error: null };
    }
    for (let i = eventLog.length - 1; i >= 0; i--) {
      if (combacia(eventLog[i], filtri)) eventLog.splice(i, 1);
    }
    return { data: null, error: null };
  }

  if (rec.op !== 'select') return { data: null, error: null };
  if (rec.table === 'conversations') return { data: righe.conversazione, error: null };
  if (rec.table === 'messages') {
    return { data: String(rec.arg).includes('direction') ? righe.cronologia : righe.ultimoInbound, error: null };
  }
  return { data: [], error: null };
}

function query(table: string, op: Chiamata['op'], arg: unknown) {
  const rec: Chiamata = { table, op, arg };
  chiamate.push(rec);
  const filtri: Filtro[] = [];
  const q: Record<string, unknown> = {};
  for (const m of ['is', 'or', 'gte', 'lte', 'in', 'not', 'order', 'limit', 'single', 'maybeSingle', 'ilike']) {
    q[m] = () => q;
  }
  q.eq = (colonna: string, valore: unknown) => { filtri.push([colonna, String(valore)]); return q; };
  q.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) =>
    Promise.resolve(esegui(rec, filtri)).then(ok, ko);
  return q;
}

vi.mock('@/lib/supabase/admin', () => ({
  getSupabaseAdmin: () => ({
    from: (table: string) => ({
      select: (s: string) => query(table, 'select', s),
      insert: (r: unknown) => query(table, 'insert', r),
      update: (r: unknown) => query(table, 'update', r),
      delete: () => query(table, 'delete', null),
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
import { TURNO_RIPRESA_RECUPERO_NR } from '@/lib/recupero-nr-invio';

const SEGRETO = 'segreto-di-test';
const LEAD = 'crm-1';
// L'orologio è congelato: `puoScrivere` boccia un appuntamento nel passato, e con una
// data fissa contro l'ora vera questi test si sarebbero suicidati il 29 agosto.
const ADESSO = new Date('2026-08-28T12:00:00+02:00');
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
    ai_paused_at: null,
    bot_outcome: 'APPUNTAMENTO',
    bot_scheduled_at: APPUNTAMENTO,
    gdo_appuntamento_at: null,
    cancel_requested_at: null,
    ai_started_at: '2026-08-20T09:00:00+02:00',
    leads: { phone_e164: '+393331112233', first_name: 'mario rossi' },
  }];
  righe.ultimoInbound = oreFa === null ? [] : [{ created_at: new Date(Date.now() - oreFa * 3600_000).toISOString() }];
  righe.cronologia = [
    { direction: 'out', body: 'Ciao Mario', template_sid: 'HXapertura', created_at: '2026-08-20T09:00:00Z' },
    { direction: 'in', body: 'va bene', template_sid: null, created_at: '2026-08-20T09:05:00Z' },
    // L'ultimo messaggio della chat è NOSTRO, ed è il caso vero, non un'eccezione: la
    // guardia `gia_risposto` esclude i lead che hanno scritto DOPO la chiamata a vuoto,
    // e all'ultimo messaggio di chi resta il drain ha già risposto. Una fixture che
    // finiva su `direction: 'in'` nascondeva il 400 su tutto il ramo dentro-finestra.
    { direction: 'out', body: 'Perfetto, ci sentiamo in call', template_sid: null, created_at: '2026-08-20T09:06:00Z' },
  ];
}

const eventiScritti = () => chiamate.filter((c) => c.table === 'event_log' && c.op === 'insert')
  .map((c) => c.arg as { type: string; payload: Record<string, unknown> });
const tipiScritti = () => eventiScritti().map((e) => e.type);
/** Il lucchetto come RESTA su event_log a fine giro. Da quando il claim precede
 *  l'invio, "è stato scritto" e "c'è ancora" sono due domande diverse. */
const lucchetti = () => eventLog.filter((r) => r.type === 'recupero_nr_inviato');
const aggiornamenti = () => chiamate.filter((c) => c.table === 'conversations' && c.op === 'update')
  .map((c) => c.arg as Record<string, unknown>);

beforeEach(() => {
  // Solo `Date`: i timer veri restano veri, così niente attese da sbloccare a mano.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(ADESSO);
  vi.stubEnv('BOT_WEBHOOK_SECRET', SEGRETO);
  vi.stubEnv('TWILIO_WHATSAPP_NUMBER_FENICE', 'whatsapp:+393520158061');
  vi.stubEnv('NR1_TEMPLATE_SID', NR1);
  vi.stubEnv('NR3_TEMPLATE_SID', NR3);
  chiamate.length = 0;
  eventLog.length = 0;
  prossimoIdEvento = 1;
  lucchettoInvisibileAllaSelect = false;
  sendFreeText.mockReset().mockResolvedValue({ sid: 'SMlibero', status: 'queued' });
  sendTemplate.mockReset().mockResolvedValue({ sid: 'SMtemplate', status: 'queued' });
  generateMarioReply.mockReset().mockResolvedValue({
    visibleReply: 'Ciao Mario, ti abbiamo provato a chiamare per la call.',
    appointmentFixed: false, passToHuman: false, videoWatched: false,
  });
  scenario(2);
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

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

  it('invio fallito: non si scrive proprio niente su conversations', async () => {
    scenario(2);
    sendFreeText.mockRejectedValue(new Error('twilio giù'));
    await firmato(evento(1));
    expect(aggiornamenti()).toEqual([]);
  });

  it('lead postino (appuntamento del GDO): si scrive, e il suo appuntamento non si tocca', async () => {
    // L'appuntamento sta su gdo_appuntamento_at, non su bot_scheduled_at: questi lead
    // sono metà del problema, e con la vecchia guardia li respingevamo tutti.
    scenario(2);
    righe.conversazione = [{
      ...(righe.conversazione[0] as object),
      bot_scheduled_at: null,
      gdo_appuntamento_at: APPUNTAMENTO,
    }];
    const res = await firmato(evento(1));
    await expect(res.json()).resolves.toMatchObject({ inviato: true });
    for (const u of aggiornamenti()) {
      for (const k of [...VIETATE, 'gdo_appuntamento_at']) expect(u).not.toHaveProperty(k);
    }
  });

  it('bot fermato a mano dal pannello: non si scrive e non si riapre', async () => {
    scenario(2);
    righe.conversazione = [{ ...(righe.conversazione[0] as object), ai_paused_at: '2026-08-28T09:30:00+02:00' }];
    const res = await firmato(evento(1));
    await expect(res.json()).resolves.toMatchObject({ inviato: false, motivo: 'bot_fermato' });
    expect(sendFreeText).not.toHaveBeenCalled();
    expect(aggiornamenti()).toEqual([]);
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
    // Il SID si conosce solo dopo l'invio, e il lucchetto si prende prima: quello che
    // conta è la riga come RESTA a fine giro.
    expect(lucchetti()).toHaveLength(1);
    expect(lucchetti()[0].payload).toMatchObject({
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
    // Nessun lucchetto, e nemmeno preso e restituito: si esce prima del claim, quando
    // i template saranno approvati questo lead va ritentato.
    expect(tipiScritti()).not.toContain('recupero_nr_inviato');
    expect(lucchetti()).toEqual([]);
    expect(aggiornamenti().some((u) => 'ai_status' in u)).toBe(false);
  });

  it('invio libero fallito: send_error, nessun lucchetto, motivo invio_fallito', async () => {
    scenario(2);
    sendFreeText.mockRejectedValue(new Error('twilio giù'));
    const res = await firmato(evento(1));
    await expect(res.json()).resolves.toEqual({ ok: true, inviato: false, motivo: 'invio_fallito' });
    expect(tipiScritti()).toContain('send_error');
    // Il lucchetto era stato preso prima dell'invio e viene restituito: il recupero
    // resta ritentabile, che è tutta la differenza fra "non è partito" e "è perso".
    expect(lucchetti()).toEqual([]);
  });

  it('prima bolla partita e seconda no: vale come inviato, altrimenti il lead ne riceve due', async () => {
    scenario(2);
    generateMarioReply.mockResolvedValue({
      visibleReply: 'Ciao Mario, ti abbiamo provato a chiamare.\nQuando ti richiamiamo?',
      appointmentFixed: false, passToHuman: false, videoWatched: false,
    });
    sendFreeText
      .mockResolvedValueOnce({ sid: 'SMlibero', status: 'queued' })
      .mockRejectedValueOnce(new Error('twilio giù a metà'));

    const res = await firmato(evento(1));
    await expect(res.json()).resolves.toEqual({ ok: true, inviato: true, ramo: 'libero' });
    // Il lucchetto c'è: al prossimo giro del CRM non gliene arriva un secondo.
    expect(eventiScritti().map((e) => e.type)).toContain('recupero_nr_inviato');
    expect(aggiornamenti().some((u) => u.ai_status === 'active')).toBe(true);
    // E il pezzo mancante resta ritrovabile.
    expect(eventiScritti().map((e) => e.type)).toContain('recupero_nr_invio_parziale');
  });

  it('prima bolla fallita: nessun lucchetto, il recupero si ritenta per intero', async () => {
    scenario(2);
    sendFreeText.mockRejectedValueOnce(new Error('twilio giù'));
    const res = await firmato(evento(1));
    await expect(res.json()).resolves.toEqual({ ok: true, inviato: false, motivo: 'invio_fallito' });
    expect(lucchetti()).toEqual([]);
    expect(tipiScritti()).not.toContain('recupero_nr_invio_parziale');
  });

  it('invio template fallito: nessun lucchetto, motivo invio_fallito', async () => {
    scenario(30);
    sendTemplate.mockRejectedValue(new Error('twilio giù'));
    const res = await firmato(evento(1));
    await expect(res.json()).resolves.toEqual({ ok: true, inviato: false, motivo: 'invio_fallito' });
    expect(lucchetti()).toEqual([]);
  });

  it('modello che non produce niente da dire: non si finge un invio', async () => {
    scenario(2);
    generateMarioReply.mockResolvedValue({ visibleReply: '   ', appointmentFixed: false, passToHuman: false, videoWatched: false });
    const res = await firmato(evento(1));
    await expect(res.json()).resolves.toEqual({ ok: true, inviato: false, motivo: 'invio_fallito' });
    expect(sendFreeText).not.toHaveBeenCalled();
    expect(lucchetti()).toEqual([]);
  });

  it('numero Fenice non configurato: si logga e non si manda dal numero sbagliato', async () => {
    scenario(2);
    vi.stubEnv('TWILIO_WHATSAPP_NUMBER_FENICE', '');
    const res = await firmato(evento(1));
    await expect(res.json()).resolves.toEqual({ ok: true, inviato: false, motivo: 'invio_fallito' });
    expect(sendFreeText).not.toHaveBeenCalled();
    expect(tipiScritti()).toContain('send_error');
    // Configurazione assente: si esce prima del claim, niente lucchetto da restituire.
    expect(tipiScritti()).not.toContain('recupero_nr_inviato');
  });
});

describe('POST /api/bot/call-attempt — la cronologia che arriva al modello', () => {
  // Il ramo dentro-finestra è il 79% dei casi, e qui l'ultimo messaggio della chat è
  // quasi sempre NOSTRO: `gia_risposto` esclude chi ha scritto dopo la chiamata a
  // vuoto, e al resto il drain ha già risposto. La cronologia grezza finirebbe su un
  // turno assistant, che claude-sonnet-4-6 rifiuta con 400 "does not support assistant
  // message prefill" — un 400 che l'SDK non ritenta e che manderebbe quasi tutti questi
  // lead in `invio_fallito`.
  it('cronologia che finisce con un nostro messaggio: al modello non arriva un turno assistant in coda', async () => {
    scenario(2);
    expect(righe.cronologia.at(-1)).toMatchObject({ direction: 'out' });

    await firmato(evento(1));

    const history = generateMarioReply.mock.calls[0][0] as { role: string; content: string }[];
    expect(history.at(-1)?.role).toBe('user');
    expect(history.at(-1)?.content).toBe(TURNO_RIPRESA_RECUPERO_NR);
    // I turni veri restano tutti, nell'ordine: il turno sintetico si aggiunge, non
    // sostituisce niente.
    expect(history.map((t) => t.role)).toEqual(['assistant', 'user', 'assistant', 'user']);
  });

  it('il turno di ripresa dice perché stiamo scrivendo noi: la telefonata a vuoto', async () => {
    scenario(2);
    await firmato(evento(1));
    const history = generateMarioReply.mock.calls[0][0] as { role: string; content: string }[];
    expect(history.at(-1)?.content).toMatch(/nota di sistema/);
    expect(history.at(-1)?.content).toMatch(/telefon/i);
  });

  it('la chiamata al modello ha un budget suo, che sta dentro il maxDuration', async () => {
    scenario(2);
    await firmato(evento(1));
    const opts = generateMarioReply.mock.calls[0][1] as { timeoutMs?: number; maxRetries?: number };
    expect(opts.timeoutMs).toBeGreaterThan(0);
    expect(opts.maxRetries).toBeGreaterThanOrEqual(0);
    // Col client di casa (60s x 5 retry) un solo tentativo bruciava tutta la funzione.
    expect(opts.timeoutMs! * (opts.maxRetries! + 1)).toBeLessThan(60_000);
  });

  it('link Fenice inventato dal modello: parte, ma non senza lasciare traccia', async () => {
    scenario(2);
    generateMarioReply.mockResolvedValue({
      visibleReply: 'Eccolo qui https://corso.feniceacademy.it/conferenza-zz9',
      appointmentFixed: false, passToHuman: false, videoWatched: false,
    });
    await firmato(evento(1));
    expect(tipiScritti()).toContain('unknown_fenice_link');
  });
});

describe('POST /api/bot/call-attempt — il lucchetto è un claim, non una lettura', () => {
  it('due POST sullo stesso tentativo: il secondo non manda niente', async () => {
    scenario(2);
    await firmato(evento(1));
    const res = await firmato(evento(1));
    await expect(res.json()).resolves.toEqual({ ok: true, inviato: false, motivo: 'gia_inviato' });
    expect(sendFreeText).toHaveBeenCalledTimes(1);
    expect(lucchetti()).toHaveLength(1);
  });

  it('il tentativo 3 non è fermato dal lucchetto del tentativo 1', async () => {
    scenario(30);
    await firmato(evento(1));
    const res = await firmato(evento(3));
    await expect(res.json()).resolves.toMatchObject({ inviato: true });
    expect(sendTemplate).toHaveBeenCalledTimes(2);
  });

  it('doppio clic: chi perde la insert del lucchetto non scrive al lead', async () => {
    // Le due richieste hanno LETTO entrambe "non inviato" — è il caso che la lettura
    // prima dell'invio non può fermare, perché in mezzo ci sono il modello e Twilio.
    scenario(2);
    lucchettoInvisibileAllaSelect = true;
    eventLog.push({ id: 999, type: 'recupero_nr_inviato', payload: { conversationId: 42, crmLeadId: LEAD, tentativo: 1, ramo: 'libero' } });

    const res = await firmato(evento(1));
    await expect(res.json()).resolves.toEqual({ ok: true, inviato: false, motivo: 'gia_inviato' });
    expect(sendFreeText).not.toHaveBeenCalled();
    expect(generateMarioReply).not.toHaveBeenCalled();
    expect(aggiornamenti()).toEqual([]);
  });

  it('il lucchetto c\'è già quando parte il messaggio, non dopo', async () => {
    scenario(2);
    sendFreeText.mockImplementation(async () => {
      expect(lucchetti()).toHaveLength(1);
      return { sid: 'SMlibero', status: 'queued' };
    });
    const res = await firmato(evento(1));
    await expect(res.json()).resolves.toMatchObject({ inviato: true });
    expect(sendFreeText).toHaveBeenCalled();
  });
});

describe('POST /api/bot/call-attempt — la data che arriva dal CRM', () => {
  it('appointmentAt già passato: non si scrive, e il motivo si legge', async () => {
    scenario(2);
    const res = await firmato({ ...evento(1), appointmentAt: '2026-08-27T15:00:00+02:00' });
    await expect(res.json()).resolves.toEqual({ ok: true, inviato: false, motivo: 'appuntamento_gia_passato' });
    expect(sendFreeText).not.toHaveBeenCalled();
    expect(sendTemplate).not.toHaveBeenCalled();
    expect(aggiornamenti()).toEqual([]);
    expect(lucchetti()).toEqual([]);
  });

  it('appointmentAt lontano dalla nostra data: si manda, ma l\'incoerenza resta scritta', async () => {
    // La loro è la fonte di verità sull'agenda delle Conferme, quindi non si blocca —
    // ma due sistemi che raccontano al lead due giorni diversi vanno guardati.
    scenario(2);
    const res = await firmato({ ...evento(1), appointmentAt: '2026-08-31T15:00:00+02:00' });
    await expect(res.json()).resolves.toMatchObject({ inviato: true });
    expect(tipiScritti()).toContain('recupero_nr_data_incoerente');
  });

  it('stessa data del CRM e nostra: nessun allarme', async () => {
    scenario(2);
    await firmato(evento(1));
    expect(tipiScritti()).not.toContain('recupero_nr_data_incoerente');
  });
});

describe('POST /api/bot/call-attempt — la riapertura non calpesta gli stati', () => {
  it('conversazione chiusa: si riapre, così la sua risposta viene lavorata', async () => {
    scenario(2);
    await firmato(evento(1));
    expect(aggiornamenti().some((u) => u.ai_status === 'active')).toBe(true);
  });

  it('conversazione booked: si scrive, ma lo stato non si sovrascrive', async () => {
    // `shouldReopen` riapre solo da 'closed' proprio per non perdere 'booked': qui si
    // scriveva 'active' incondizionatamente e quello stato spariva.
    scenario(2);
    righe.conversazione = [{ ...(righe.conversazione[0] as object), ai_status: 'booked' }];
    const res = await firmato(evento(1));
    await expect(res.json()).resolves.toMatchObject({ inviato: true });
    expect(aggiornamenti().some((u) => 'ai_status' in u)).toBe(false);
    // La chat resta in cima all'inbox: quella colonna si tocca comunque.
    expect(aggiornamenti().some((u) => 'last_message_at' in u)).toBe(true);
  });
});
