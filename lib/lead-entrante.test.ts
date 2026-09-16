import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { pushLeadEntrante, type PushLeadEntranteArgs } from './lead-entrante';

const ARGS: PushLeadEntranteArgs = {
  conversationId: 42,
  telefono: '+393200431888',
  nome: null,
  provenienza: 'TELEGRAM',
  primoMessaggio: 'Buongiorno, sono nel canale Telegram e...',
  scrittoIl: '2026-09-05T09:12:03+02:00',
};

/** Fake del client Supabase: traccia update su `conversations` e insert su `event_log`. */
function makeSupabase() {
  const calls = { updates: [] as any[], events: [] as any[] };
  const supabase: any = {
    from(table: string) {
      if (table === 'conversations') {
        return {
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
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('pushLeadEntrante', () => {
  it('ok:true, creato:true → scrive crm_lead_id e logga lead_entrante_push', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200, text: async () => JSON.stringify({ ok: true, leadId: 'uuid-1', creato: true }),
    })));
    const { supabase, calls } = makeSupabase();

    const res = await pushLeadEntrante(supabase, ARGS);

    expect(res).toEqual({ ok: true, leadId: 'uuid-1' });
    expect(calls.updates).toEqual([{ crm_lead_id: 'uuid-1' }]);
    const evento = calls.events.find((e) => e.type === 'lead_entrante_push');
    expect(evento).toBeDefined();
    expect(evento.level).toBe('info');
    expect(evento.payload).toMatchObject({
      conversationId: 42, leadId: 'uuid-1', creato: true, provenienza: 'TELEGRAM',
    });

    // La firma va calcolata sul corpo grezzo esatto, e il corpo deve avere gli stessi
    // nomi di campo di /api/bot/lead-entranti.
    const fetchMock = globalThis.fetch as any;
    expect(fetchMock.mock.calls).toHaveLength(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://crm-sales-fenice.vercel.app/api/bot/lead-entrante');
    expect(init.headers['x-bot-signature']).toMatch(/^sha256=/);
    expect(JSON.parse(init.body)).toEqual({
      telefono: ARGS.telefono,
      nome: null,
      provenienza: 'TELEGRAM',
      primoMessaggio: ARGS.primoMessaggio,
      scrittoIl: ARGS.scrittoIl,
      conversationId: 42,
    });
  });

  it('ok:true, creato:false → scrive comunque crm_lead_id (numero gia loro)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200, text: async () => JSON.stringify({ ok: true, leadId: 'uuid-2', creato: false }),
    })));
    const { supabase, calls } = makeSupabase();

    const res = await pushLeadEntrante(supabase, ARGS);

    expect(res).toEqual({ ok: true, leadId: 'uuid-2' });
    expect(calls.updates).toEqual([{ crm_lead_id: 'uuid-2' }]);
    const evento = calls.events.find((e) => e.type === 'lead_entrante_push');
    expect(evento.payload).toMatchObject({ leadId: 'uuid-2', creato: false });
  });

  it('motivo: altra_azienda → NON scrive crm_lead_id, logga con la provenienza', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200, text: async () => JSON.stringify({ ok: false, motivo: 'altra_azienda' }),
    })));
    const { supabase, calls } = makeSupabase();

    const res = await pushLeadEntrante(supabase, { ...ARGS, provenienza: 'INBOUND' });

    expect(res).toEqual({ ok: false, motivo: 'altra_azienda' });
    expect(calls.updates).toHaveLength(0);
    const evento = calls.events.find((e) => e.type === 'lead_entrante_altra_azienda');
    expect(evento).toBeDefined();
    expect(evento.level).toBe('warn');
    expect(evento.payload).toMatchObject({
      conversationId: 42, telefono: ARGS.telefono, provenienza: 'INBOUND',
    });
    // Nessun evento di push riuscito, nessun errore generico al suo posto.
    expect(calls.events.some((e) => e.type === 'lead_entrante_push')).toBe(false);
    expect(calls.events.some((e) => e.type === 'lead_entrante_push_error')).toBe(false);
  });

  it('motivo: telefono_non_valido → NON scrive crm_lead_id, logga lead_entrante_push_error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200, text: async () => JSON.stringify({ ok: false, motivo: 'telefono_non_valido' }),
    })));
    const { supabase, calls } = makeSupabase();

    const res = await pushLeadEntrante(supabase, ARGS);

    expect(res).toEqual({ ok: false, motivo: 'telefono_non_valido' });
    expect(calls.updates).toHaveLength(0);
    const evento = calls.events.find((e) => e.type === 'lead_entrante_push_error');
    expect(evento).toBeDefined();
    expect(evento.level).toBe('warn');
    expect(evento.payload).toMatchObject({ conversationId: 42, motivo: 'telefono_non_valido' });
  });

  it('500 del CRM → non lancia, non scrive crm_lead_id, logga lead_entrante_push_error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, text: async () => 'boom' })));
    const { supabase, calls } = makeSupabase();

    const res = await pushLeadEntrante(supabase, ARGS);

    expect(res).toEqual({ ok: false, motivo: 'http_500' });
    expect(calls.updates).toHaveLength(0);
    const evento = calls.events.find((e) => e.type === 'lead_entrante_push_error');
    expect(evento).toBeDefined();
    expect(evento.payload).toMatchObject({ conversationId: 42, status: 500, motivo: 'http_500' });
  });

  it('rete giu (fetch che esplode) → non lancia, logga lead_entrante_push_error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNRESET'); }));
    const { supabase, calls } = makeSupabase();

    const res = await pushLeadEntrante(supabase, ARGS);

    expect(res).toEqual({ ok: false, motivo: 'ECONNRESET' });
    expect(calls.updates).toHaveLength(0);
    const evento = calls.events.find((e) => e.type === 'lead_entrante_push_error');
    expect(evento).toBeDefined();
    expect(evento.payload).toMatchObject({ conversationId: 42, telefono: ARGS.telefono, motivo: 'ECONNRESET' });
  });

  it('BOT_WEBHOOK_SECRET assente → non chiama fetch, logga e torna ok:false', async () => {
    vi.unstubAllEnvs();
    vi.stubGlobal('fetch', vi.fn());
    const { supabase, calls } = makeSupabase();

    const res = await pushLeadEntrante(supabase, ARGS);

    expect(res).toEqual({ ok: false, motivo: 'not_configured' });
    expect((globalThis.fetch as any)).not.toHaveBeenCalled();
    expect(calls.updates).toHaveLength(0);
    const evento = calls.events.find((e) => e.type === 'lead_entrante_push_error');
    expect(evento).toBeDefined();
    expect(evento.payload).toMatchObject({ conversationId: 42, motivo: 'not_configured' });
  });

  it('provenienza "Lancio Web Dev AI" viaggia com e, senza maiuscole: la normalizza il CRM', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200, text: async () => JSON.stringify({ ok: true, leadId: 'uuid-l', creato: true }),
    })));
    const { supabase, calls } = makeSupabase();
    const res = await pushLeadEntrante(supabase, { ...ARGS, provenienza: 'Lancio Web Dev AI', primoMessaggio: 'Ho seguito la live Web Developer AI e voglio saperne di più 🚀' });
    expect(res).toEqual({ ok: true, leadId: 'uuid-l' });
    const [, init] = (globalThis.fetch as any).mock.calls[0];
    expect(JSON.parse(init.body).provenienza).toBe('Lancio Web Dev AI');
    expect(calls.updates).toEqual([{ crm_lead_id: 'uuid-l' }]);
    expect(calls.events.find((e) => e.type === 'lead_entrante_push').payload.provenienza).toBe('Lancio Web Dev AI');
  });
});
