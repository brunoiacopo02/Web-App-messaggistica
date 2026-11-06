import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const giudicaSp = vi.fn();
const giudicaDis = vi.fn();
vi.mock('./giudice-spostamento', async (orig) => {
  const vero = await orig<typeof import('./giudice-spostamento')>();
  return {
    ...vero,
    contestoSpostamentoDaDb: vi.fn(async (_s: unknown, _c: unknown, base: object) => ({
      messaggi: [],
      fatti: { ...base, adesso: new Date().toISOString() },
    })),
    giudicaSpostamento: (...a: unknown[]) => giudicaSp(...a),
  };
});
vi.mock('./giudice-disdetta', async (orig) => {
  const vero = await orig<typeof import('./giudice-disdetta')>();
  return {
    ...vero,
    contestoGiudiceDaDb: vi.fn(async () => ({ messaggi: [], fatti: { adesso: new Date().toISOString(), appuntamentoAt: null } })),
    giudicaDisdetta: (...a: unknown[]) => giudicaDis(...a),
  };
});

import { sendOutcome, SPOSTAMENTO_NON_INVIATO } from './bot-outcome';

function makeSupabase(convRow: any) {
  const calls = { updates: [] as any[], events: [] as any[] };
  const supabase: any = {
    from(table: string) {
      if (table === 'conversations') {
        return {
          select() { return this; },
          eq() { return this; },
          maybeSingle() { return Promise.resolve({ data: convRow }); },
          update(payload: any) { calls.updates.push(payload); return { eq() { return Promise.resolve({}); } }; },
        };
      }
      const stub: any = {
        insert(payload: any) { calls.events.push(payload); return Promise.resolve({}); },
        select() { return stub; },
        eq() { return stub; },
        gte() { return stub; },
        order() { return stub; },
        limit() { return Promise.resolve({ data: [] }); },
      };
      return stub;
    },
  };
  return { supabase, calls };
}

const fra = (giorni: number) => new Date(Date.now() + giorni * 864e5).toISOString();
const CONV_GDO = () => ({ crm_lead_id: 'gdo1', bot_outcome: null, bot_scheduled_at: null, gdo_appuntamento_at: fra(1) });
const CONV_BOT = () => ({ crm_lead_id: 'b1', bot_outcome: 'APPUNTAMENTO', bot_scheduled_at: fra(1) });
const giudizio = (verdetto: string) => ({
  verdetto,
  verdettoModello: verdetto,
  citazione: 'oggi non riesco',
  motivo: verdetto === 'disdetta' ? 'non può spendere' : 'motivo',
  guardia: [],
  ms: 2500,
  modello: 'claude-opus-5-5',
  token: { input: 1500, output: 200, cacheRead: 2500, cacheWrite: 0 },
});
const risposta = (corpo: unknown, status = 200) => ({
  ok: status < 300,
  status,
  json: async () => corpo,
  text: async () => JSON.stringify(corpo),
});
const corpoDi = (f: any, i: number) => JSON.parse(f.mock.calls[i][1].body);
const evento = (calls: { events: any[] }) => calls.events.find((e) => e.type === 'giudice_spostamento');
const marcato = (calls: { updates: any[] }) => calls.updates.some((u) => 'cancel_requested_at' in u);

beforeEach(() => {
  vi.stubEnv('BOT_WEBHOOK_SECRET', 'test-secret');
  vi.stubEnv('GIUDICE_SPOSTAMENTI_ENABLED', '1');
  giudicaSp.mockReset();
  giudicaDis.mockReset();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('giudice degli spostamenti sui lead dei GDO (noteOnly)', () => {
  it('interruttore assente → giudice mai chiamato, nota SPOSTAMENTO come oggi', async () => {
    vi.stubEnv('GIUDICE_SPOSTAMENTI_ENABLED', '');
    const fetch = vi.fn(async () => risposta({ ok: true, noted: true }));
    vi.stubGlobal('fetch', fetch);
    const { supabase, calls } = makeSupabase(CONV_GDO());
    await sendOutcome(supabase, 7, { outcome: 'RICHIAMO', leadWords: 'oggi non riesco' }, { noteOnly: true });
    expect(giudicaSp).not.toHaveBeenCalled();
    expect(corpoDi(fetch, 0).note).toMatch(/^SPOSTAMENTO CHIESTO/);
    expect(marcato(calls)).toBe(true);
    expect(evento(calls)).toBeUndefined();
  });

  for (const v of ['spostamento_vero', 'dubbio']) {
    it(`${v} → la nota parte e la chat si marca`, async () => {
      giudicaSp.mockResolvedValue(giudizio(v));
      const fetch = vi.fn(async () => risposta({ ok: true, noted: true }));
      vi.stubGlobal('fetch', fetch);
      const { supabase, calls } = makeSupabase(CONV_GDO());
      const res = await sendOutcome(supabase, 7, { outcome: 'RICHIAMO' }, { noteOnly: true });
      expect(res.sent).toBe(true);
      expect(corpoDi(fetch, 0).note).toMatch(/^SPOSTAMENTO CHIESTO/);
      expect(marcato(calls)).toBe(true);
      expect(evento(calls).payload).toMatchObject({ verdetto: v, canale: 'gdo', decisione: 'nota_spostamento' });
    });
  }

  it('errore o timeout → dubbio, la nota parte, errore nel registro', async () => {
    giudicaSp.mockRejectedValue(new Error('Request timed out.'));
    const fetch = vi.fn(async () => risposta({ ok: true, noted: true }));
    vi.stubGlobal('fetch', fetch);
    const { supabase, calls } = makeSupabase(CONV_GDO());
    const res = await sendOutcome(supabase, 7, { outcome: 'RICHIAMO' }, { noteOnly: true });
    expect(res.sent).toBe(true);
    expect(evento(calls).payload).toMatchObject({ verdetto: 'dubbio', errore: 'Request timed out.' });
  });

  it('non_spostamento → nessuna nota, nessun marcatore (i promemoria restano)', async () => {
    giudicaSp.mockResolvedValue(giudizio('non_spostamento'));
    const fetch = vi.fn(async () => risposta({ ok: true }));
    vi.stubGlobal('fetch', fetch);
    const { supabase, calls } = makeSupabase(CONV_GDO());
    const res = await sendOutcome(supabase, 7, { outcome: 'RICHIAMO', leadWords: 'grazie' }, { noteOnly: true });
    expect(res).toMatchObject({ sent: false, error: SPOSTAMENTO_NON_INVIATO });
    expect(fetch).not.toHaveBeenCalled();
    expect(marcato(calls)).toBe(false);
    expect(evento(calls).payload.decisione).toBe('nessuna_nota');
  });

  it('disdetta → passa dal giudice delle disdette e parte come DISDETTA', async () => {
    giudicaSp.mockResolvedValue(giudizio('disdetta'));
    giudicaDis.mockResolvedValue({ verdetto: 'dubbio', verdettoModello: 'dubbio', categoria: 'soldi', citazione: '', motivo: '', guardia: [], ms: 1, modello: 'm', token: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
    const fetch = vi.fn(async () => risposta({ ok: true, noted: true }));
    vi.stubGlobal('fetch', fetch);
    const { supabase, calls } = makeSupabase(CONV_GDO());
    const res = await sendOutcome(supabase, 7, { outcome: 'RICHIAMO', leadWords: 'non posso pagarmi il corso' }, { noteOnly: true });
    expect(giudicaDis).toHaveBeenCalledTimes(1);
    expect(res.sent).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(corpoDi(fetch, 0).note).toMatch(/^DISDETTA — /);
    expect(corpoDi(fetch, 0).note).toContain('Causa: non può spendere');
    expect(marcato(calls)).toBe(true);
    expect(evento(calls).payload.decisione).toBe('nota_disdetta');
  });

  it('agenda passata da più di 7 giorni → niente nota, il modello non viene chiamato', async () => {
    const fetch = vi.fn(async () => risposta({ ok: true }));
    vi.stubGlobal('fetch', fetch);
    const { supabase, calls } = makeSupabase({ ...CONV_GDO(), gdo_appuntamento_at: fra(-10) });
    const res = await sendOutcome(supabase, 7, { outcome: 'RICHIAMO' }, { noteOnly: true });
    expect(res.error).toBe(SPOSTAMENTO_NON_INVIATO);
    expect(giudicaSp).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(evento(calls).payload.guardia).toEqual(['agenda_vecchia']);
  });

  it('vecchio RICHIAMO del bot in bot_scheduled_at: la nota porta la call vera del GDO', async () => {
    giudicaSp.mockResolvedValue(giudizio('spostamento_vero'));
    const fetch = vi.fn(async () => risposta({ ok: true, noted: true }));
    vi.stubGlobal('fetch', fetch);
    const gdoAt = fra(1);
    const { supabase } = makeSupabase({ crm_lead_id: 'gdo1', bot_outcome: 'RICHIAMO', bot_scheduled_at: '2026-08-31T07:00:00Z', gdo_appuntamento_at: gdoAt });
    await sendOutcome(supabase, 7, { outcome: 'RICHIAMO' }, { noteOnly: true });
    expect(giudicaSp.mock.calls[0][1].agendaAt).toBe(gdoAt);
    expect(corpoDi(fetch, 0).note).not.toContain('agosto');
  });

  it('una DISDETTA non passa dal giudice degli spostamenti', async () => {
    giudicaDis.mockResolvedValue({ verdetto: 'dubbio', verdettoModello: 'dubbio', categoria: 'soldi', citazione: '', motivo: '', guardia: [], ms: 1, modello: 'm', token: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
    vi.stubGlobal('fetch', vi.fn(async () => risposta({ ok: true, noted: true })));
    const { supabase } = makeSupabase(CONV_GDO());
    await sendOutcome(supabase, 7, { outcome: 'DA_SCARTARE' }, { noteOnly: true });
    expect(giudicaSp).not.toHaveBeenCalled();
  });
});

describe('giudice degli spostamenti sulle call fissate dal bot (locked)', () => {
  it('non_spostamento → nessuna nota, chat chiusa, nessun marcatore', async () => {
    giudicaSp.mockResolvedValue(giudizio('non_spostamento'));
    const fetch = vi.fn(async () => risposta({ ok: true }));
    vi.stubGlobal('fetch', fetch);
    const { supabase, calls } = makeSupabase(CONV_BOT());
    const res = await sendOutcome(supabase, 7, { outcome: 'RICHIAMO', date: fra(2) });
    expect(res.error).toBe(SPOSTAMENTO_NON_INVIATO);
    expect(fetch).not.toHaveBeenCalled();
    expect(calls.updates).toContainEqual({ ai_status: 'closed' });
    expect(marcato(calls)).toBe(false);
    expect(evento(calls).payload.canale).toBe('bot');
  });

  it('disdetta → nota DISDETTA al posto dello spostamento, chat marcata', async () => {
    giudicaSp.mockResolvedValue(giudizio('disdetta'));
    const fetch = vi.fn(async () => risposta({ ok: true }));
    vi.stubGlobal('fetch', fetch);
    const { supabase, calls } = makeSupabase(CONV_BOT());
    await sendOutcome(supabase, 7, { outcome: 'RICHIAMO', date: fra(2) });
    expect(corpoDi(fetch, 0)).toMatchObject({ outcome: 'NOTA' });
    expect(corpoDi(fetch, 0).note).toMatch(/^DISDETTA — /);
    expect(marcato(calls)).toBe(true);
  });

  it('spostamento_vero → nota SPOSTAMENTO, chat marcata', async () => {
    giudicaSp.mockResolvedValue(giudizio('spostamento_vero'));
    const fetch = vi.fn(async () => risposta({ ok: true }));
    vi.stubGlobal('fetch', fetch);
    const { supabase, calls } = makeSupabase(CONV_BOT());
    await sendOutcome(supabase, 7, { outcome: 'RICHIAMO', date: fra(2) });
    expect(corpoDi(fetch, 0).note).toMatch(/^SPOSTAMENTO CHIESTO/);
    expect(marcato(calls)).toBe(true);
  });

  it('interruttore assente → come oggi', async () => {
    vi.stubEnv('GIUDICE_SPOSTAMENTI_ENABLED', '');
    const fetch = vi.fn(async () => risposta({ ok: true }));
    vi.stubGlobal('fetch', fetch);
    const { supabase, calls } = makeSupabase(CONV_BOT());
    await sendOutcome(supabase, 7, { outcome: 'RICHIAMO', date: fra(2) });
    expect(giudicaSp).not.toHaveBeenCalled();
    expect(corpoDi(fetch, 0).note).toMatch(/^SPOSTAMENTO CHIESTO/);
    expect(marcato(calls)).toBe(true);
  });
});
