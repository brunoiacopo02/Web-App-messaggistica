import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sendOutcome } from './bot-outcome';

const DATE = '2026-06-29T17:00:00Z';

/** Fake del client Supabase: traccia update ed event_log, restituisce una riga fissa. */
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
      return { insert(payload: any) { calls.events.push(payload); return Promise.resolve({}); } };
    },
  };
  return { supabase, calls };
}

beforeEach(() => {
  vi.stubEnv('BOT_WEBHOOK_SECRET', 'test-secret');
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, text: async () => '' })));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('sendOutcome — guard APPUNTAMENTO terminale', () => {
  it('lead già APPUNTAMENTO + SCARTO → invia APPUNTAMENTO+note, riga NON toccata, log locked', async () => {
    const { supabase, calls } = makeSupabase({ crm_lead_id: 'crm1', bot_outcome: 'APPUNTAMENTO', bot_scheduled_at: DATE });
    const res = await sendOutcome(supabase, 1, { outcome: 'DA_SCARTARE', discardReason: 'la madre non paga' });

    expect(res.sent).toBe(true);
    const fetchMock = (globalThis.fetch as any);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.outcome).toBe('APPUNTAMENTO');
    expect(body.date).toBe(DATE);
    expect(body.note).toContain('annullare');
    // La riga viene chiusa (stop al loop del cron) ma l'esito resta congelato.
    expect(calls.updates).toEqual([{ ai_status: 'closed' }]);
    expect(calls.events.some((e) => e.type === 'bot_outcome_locked')).toBe(true);
  });

  it('lead già APPUNTAMENTO + POST fallito → riga NON toccata (ritentabile)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, text: async () => 'boom' })));
    const { supabase, calls } = makeSupabase({ crm_lead_id: 'crm1', bot_outcome: 'APPUNTAMENTO', bot_scheduled_at: DATE });
    const res = await sendOutcome(supabase, 1, { outcome: 'INTERROTTO' });

    expect(res.sent).toBe(false);
    expect(calls.updates).toHaveLength(0);
    expect(calls.events.some((e) => e.type === 'bot_outcome_error')).toBe(true);
  });

  it('lead non ancora deciso + APPUNTAMENTO → comportamento normale (persiste e chiude)', async () => {
    const { supabase, calls } = makeSupabase({ crm_lead_id: 'crm1', bot_outcome: null, bot_scheduled_at: null });
    const res = await sendOutcome(supabase, 1, { outcome: 'APPUNTAMENTO', date: DATE });

    expect(res.sent).toBe(true);
    expect(calls.updates[0]).toMatchObject({ bot_outcome: 'APPUNTAMENTO', ai_status: 'closed' });
    expect(calls.events.some((e) => e.type === 'bot_outcome_sent')).toBe(true);
  });

  it('CRM 403 su lead normale → persiste esito localmente, chiude, log rejected (no retry loop)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 403, text: async () => 'lead non assegnato' })));
    const { supabase, calls } = makeSupabase({ crm_lead_id: 'crm1', bot_outcome: null, bot_scheduled_at: null });
    const res = await sendOutcome(supabase, 1, { outcome: 'INTERROTTO', note: 'nota' });

    expect(res.sent).toBe(false);
    expect(res.status).toBe(403);
    expect(calls.updates[0]).toMatchObject({ bot_outcome: 'INTERROTTO', ai_status: 'closed' });
    expect(calls.events.some((e) => e.type === 'bot_outcome_rejected' && e.level === 'warn')).toBe(true);
  });

  it('CRM 403 su lead già APPUNTAMENTO → chiude senza declassare bot_outcome', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 403, text: async () => 'no' })));
    const { supabase, calls } = makeSupabase({ crm_lead_id: 'crm1', bot_outcome: 'APPUNTAMENTO', bot_scheduled_at: DATE });
    const res = await sendOutcome(supabase, 1, { outcome: 'DA_SCARTARE', discardReason: 'x' });

    expect(res.sent).toBe(false);
    expect(calls.updates).toEqual([{ ai_status: 'closed' }]);
    expect(calls.events.some((e) => e.type === 'bot_outcome_rejected')).toBe(true);
  });

  it('lead APPUNTAMENTO senza data originale → non invia, non declassa, warning', async () => {
    const { supabase, calls } = makeSupabase({ crm_lead_id: 'crm1', bot_outcome: 'APPUNTAMENTO', bot_scheduled_at: null });
    const res = await sendOutcome(supabase, 1, { outcome: 'INTERROTTO' });

    expect(res.sent).toBe(true);
    expect((globalThis.fetch as any).mock.calls).toHaveLength(0);  // nessun POST
    expect(calls.updates).toHaveLength(0);
    expect(calls.events.some((e) => e.type === 'bot_outcome_locked' && e.level === 'warn')).toBe(true);
  });
});

describe('sendOutcome — RICHIAMO interim', () => {
  it('interim su lead in lavorazione → POST inviato, nessuna persistenza locale', async () => {
    const { supabase, calls } = makeSupabase({ crm_lead_id: 'crm1', bot_outcome: null, bot_scheduled_at: null });
    const res = await sendOutcome(supabase, 1, { outcome: 'RICHIAMO', date: '2026-08-07T09:00:00+02:00', note: 'seq' }, { interim: true });

    expect(res.sent).toBe(true);
    const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
    expect(body.outcome).toBe('RICHIAMO');
    expect(calls.updates).toHaveLength(0);  // conversazione resta aperta
    expect(calls.events.some((e) => e.type === 'bot_outcome_sent' && e.payload.interim === true)).toBe(true);
  });

  it('interim su lead già APPUNTAMENTO → nessun POST (mai riportare indietro lo stato)', async () => {
    const { supabase, calls } = makeSupabase({ crm_lead_id: 'crm1', bot_outcome: 'APPUNTAMENTO', bot_scheduled_at: DATE });
    const res = await sendOutcome(supabase, 1, { outcome: 'RICHIAMO', date: '2026-08-07T09:00:00+02:00' }, { interim: true });

    expect(res.sent).toBe(false);
    expect(res.error).toBe('interim_skipped_locked');
    expect((globalThis.fetch as any).mock.calls).toHaveLength(0);
    expect(calls.updates).toHaveLength(0);
  });

  it('interim con CRM 403 → nessuna persistenza (RICHIAMO non è un esito nostro)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 403, text: async () => 'no' })));
    const { supabase, calls } = makeSupabase({ crm_lead_id: 'crm1', bot_outcome: null, bot_scheduled_at: null });
    const res = await sendOutcome(supabase, 1, { outcome: 'RICHIAMO', date: '2026-08-07T09:00:00+02:00' }, { interim: true });

    expect(res.sent).toBe(false);
    expect(calls.updates).toHaveLength(0);
    expect(calls.events.some((e) => e.type === 'bot_outcome_rejected')).toBe(true);
  });
});
