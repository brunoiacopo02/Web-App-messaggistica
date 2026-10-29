import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const giudica = vi.fn();
vi.mock('./giudice-disdetta', async (orig) => {
  const vero = await orig<typeof import('./giudice-disdetta')>();
  return {
    ...vero,
    contestoGiudiceDaDb: vi.fn(async () => ({ messaggi: [], fatti: { adesso: new Date().toISOString(), appuntamentoAt: null } })),
    giudicaDisdetta: (...a: unknown[]) => giudica(...a),
  };
});

import { sendOutcome } from './bot-outcome';

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

const CONV_GDO = { crm_lead_id: 'gdo1', bot_outcome: null, bot_scheduled_at: null, gdo_appuntamento_at: '2026-10-29T15:00:00Z' };
const giudizio = (verdetto: string) => ({
  verdetto,
  verdettoModello: verdetto,
  categoria: 'ripensamento',
  citazione: 'non mi interessa più',
  motivo: 'rinuncia',
  guardia: [],
  ms: 3000,
  modello: 'claude-opus-5-5',
  token: { input: 2000, output: 300, cacheRead: 3000, cacheWrite: 0 },
});
const risposta = (corpo: unknown, status = 200) => ({
  ok: status < 300,
  status,
  json: async () => corpo,
  text: async () => JSON.stringify(corpo),
});
const corpoDi = (f: any, i: number) => JSON.parse(f.mock.calls[i][1].body);
const evento = (calls: { events: any[] }) => calls.events.find((e) => e.type === 'giudice_disdetta');

beforeEach(() => {
  vi.stubEnv('BOT_WEBHOOK_SECRET', 'test-secret');
  giudica.mockReset();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('giudice delle disdette sui lead dei GDO', () => {
  it('disdetta vera + CRM scarta → niente nota, marcatore e audit', async () => {
    giudica.mockResolvedValue(giudizio('disdetta_vera'));
    const fetch = vi.fn(async () => risposta({ ok: true, discarded: true }));
    vi.stubGlobal('fetch', fetch);
    const { supabase, calls } = makeSupabase(CONV_GDO);
    const res = await sendOutcome(supabase, 7, { outcome: 'DA_SCARTARE', discardReason: 'non interessato' }, { noteOnly: true });

    expect(res.sent).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(corpoDi(fetch, 0)).toMatchObject({
      leadId: 'gdo1',
      outcome: 'DISDETTA_VERIFICATA',
      note: 'non mi interessa più',
      disdetta: { categoria: 'ripensamento', citazione: 'non mi interessa più' },
    });
    expect(calls.updates).toEqual([{ cancel_requested_at: expect.any(String) }]);
    expect(evento(calls).payload).toMatchObject({ verdetto: 'disdetta_vera', scartato: true, categoria: 'ripensamento', crm: { status: 200 } });
    expect(evento(calls).payload.token.input).toBe(2000);
    expect(calls.events.some((e) => e.type === 'bot_note_sent')).toBe(false);
  });

  it('re-invio: il CRM dice già scartato per disdetta → niente nota', async () => {
    giudica.mockResolvedValue(giudizio('disdetta_vera'));
    const fetch = vi.fn(async () => risposta({ ok: true, discarded: false, skipped: 'gia_scartato_disdetta' }));
    vi.stubGlobal('fetch', fetch);
    const { supabase } = makeSupabase(CONV_GDO);
    await sendOutcome(supabase, 7, { outcome: 'DA_SCARTARE' }, { noteOnly: true });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('disdetta vera ma il CRM non scarta (già confermato) → nota DISDETTA come prima', async () => {
    giudica.mockResolvedValue(giudizio('disdetta_vera'));
    const fetch = vi.fn()
      .mockResolvedValueOnce(risposta({ ok: true, discarded: false, skipped: 'gia_confermato' }))
      .mockResolvedValue(risposta({ ok: true, noted: true }));
    vi.stubGlobal('fetch', fetch);
    const { supabase, calls } = makeSupabase(CONV_GDO);
    await sendOutcome(supabase, 7, { outcome: 'DA_SCARTARE', discardReason: 'soldi' }, { noteOnly: true });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(corpoDi(fetch, 1).outcome).toBe('NOTA');
    expect(corpoDi(fetch, 1).note).toContain('DISDETTA');
    expect(evento(calls).payload.scartato).toBe(false);
  });

  it('disdetta vera ma il CRM risponde errore → nota DISDETTA come prima', async () => {
    giudica.mockResolvedValue(giudizio('disdetta_vera'));
    const fetch = vi.fn()
      .mockResolvedValueOnce(risposta({ error: 'forbidden' }, 403))
      .mockResolvedValue(risposta({ ok: true, noted: true }));
    vi.stubGlobal('fetch', fetch);
    const { supabase, calls } = makeSupabase(CONV_GDO);
    await sendOutcome(supabase, 7, { outcome: 'DA_SCARTARE' }, { noteOnly: true });
    expect(corpoDi(fetch, 1).outcome).toBe('NOTA');
    expect(evento(calls).payload.crm.status).toBe(403);
    expect(calls.updates).toEqual([{ cancel_requested_at: expect.any(String) }]);
  });

  for (const v of ['dubbio', 'non_disdetta']) {
    it(`${v} → nessuna chiamata di scarto, nota come prima`, async () => {
      giudica.mockResolvedValue(giudizio(v));
      const fetch = vi.fn(async () => risposta({ ok: true, noted: true }));
      vi.stubGlobal('fetch', fetch);
      const { supabase, calls } = makeSupabase(CONV_GDO);
      await sendOutcome(supabase, 7, { outcome: 'DA_SCARTARE' }, { noteOnly: true });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(corpoDi(fetch, 0).outcome).toBe('NOTA');
      expect(evento(calls).payload.verdetto).toBe(v);
    });
  }

  it("errore o timeout del giudice → nota come prima, errore nell'audit", async () => {
    giudica.mockRejectedValue(new Error('Request timed out.'));
    const fetch = vi.fn(async () => risposta({ ok: true, noted: true }));
    vi.stubGlobal('fetch', fetch);
    const { supabase, calls } = makeSupabase(CONV_GDO);
    const res = await sendOutcome(supabase, 7, { outcome: 'DA_SCARTARE' }, { noteOnly: true });
    expect(res.sent).toBe(true);
    expect(corpoDi(fetch, 0).outcome).toBe('NOTA');
    expect(evento(calls).payload.errore).toContain('timed out');
  });

  it("interruttore a '0' → il giudice non viene chiamato", async () => {
    vi.stubEnv('GIUDICE_DISDETTE_ENABLED', '0');
    vi.stubGlobal('fetch', vi.fn(async () => risposta({ ok: true, noted: true })));
    const { supabase, calls } = makeSupabase(CONV_GDO);
    await sendOutcome(supabase, 7, { outcome: 'DA_SCARTARE' }, { noteOnly: true });
    expect(giudica).not.toHaveBeenCalled();
    expect(evento(calls)).toBeUndefined();
  });

  it('solo DA_SCARTARE: un RICHIAMO (spostamento) non passa dal giudice', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => risposta({ ok: true, noted: true })));
    const { supabase } = makeSupabase(CONV_GDO);
    await sendOutcome(supabase, 7, { outcome: 'RICHIAMO' }, { noteOnly: true });
    expect(giudica).not.toHaveBeenCalled();
  });

  it('sulle call fissate dal bot (non noteOnly) il giudice non entra', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => risposta({ ok: true })));
    const { supabase } = makeSupabase({ crm_lead_id: 'b1', bot_outcome: 'APPUNTAMENTO', bot_scheduled_at: '2026-10-29T15:00:00Z' });
    await sendOutcome(supabase, 7, { outcome: 'DA_SCARTARE' });
    expect(giudica).not.toHaveBeenCalled();
  });
});
