import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./fenice-enroll', () => ({
  enrollGdoLeadAsPostino: vi.fn(async () => ({ ok: true, conversationId: 42, sid: 'SM_AGENDA' })),
}));

import { runSendAgenda } from './send-agenda-gdo';
import { enrollGdoLeadAsPostino } from './fenice-enroll';

const PAYLOAD = {
  leadId: 'gdo-1',
  name: 'Mario Rossi',
  phone: '333 123 4567',
  email: 'mario@esempio.it',
  funnel: 'Nome funnel',
  companyId: 'fenice',
  variant: { lavora: true, haFamiglia: false, offertaDelMese: false },
};

/**
 * Fake Supabase: la riga precedente del lead (per la deduplica) e lo stato Twilio del
 * messaggio appena inviato, che cambia nel tempo come farebbero le status callback.
 */
function makeSupabase(opts: { convPrecedente?: any; statusSequence?: (string | null)[] } = {}) {
  const statusSequence = opts.statusSequence ?? [null];
  let letture = 0;
  const calls = { updates: [] as any[], events: [] as any[] };

  const supabase: any = {
    from(table: string) {
      if (table === 'conversations') {
        return {
          select() {
            const stub: any = {
              eq() { return stub; },
              order() { return stub; },
              limit() { return Promise.resolve({ data: opts.convPrecedente ? [opts.convPrecedente] : [] }); },
            };
            return stub;
          },
          update(payload: any) { calls.updates.push(payload); return { eq() { return Promise.resolve({}); } }; },
        };
      }
      if (table === 'messages') {
        return {
          select() {
            const stub: any = {
              eq() { return stub; },
              maybeSingle() {
                const s = statusSequence[Math.min(letture++, statusSequence.length - 1)];
                return Promise.resolve({ data: { twilio_status: s } });
              },
            };
            return stub;
          },
        };
      }
      return { insert(payload: any) { calls.events.push(payload); return Promise.resolve({}); } };
    },
  };
  return { supabase, calls };
}

/** Attesa istantanea: il tempo lo fa avanzare `sleep`, i test non aspettano davvero. */
function fakeDeps() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => { t += ms; } };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(enrollGdoLeadAsPostino).mockResolvedValue({ ok: true, conversationId: 42, sid: 'SM_AGENDA' });
});
afterEach(() => { vi.unstubAllEnvs(); });

describe('runSendAgenda — i tre stati che vede il GDO', () => {
  it('consegna confermata entro l\'attesa → consegnato', async () => {
    const { supabase, calls } = makeSupabase({ statusSequence: ['queued', 'delivered'] });

    const res = await runSendAgenda(supabase, PAYLOAD, fakeDeps());

    expect(res).toMatchObject({ ok: true, esito: 'consegnato', conversationId: 42 });
    expect(enrollGdoLeadAsPostino).toHaveBeenCalledTimes(1);
    // L'esito definitivo resta sulla riga: è quello che la deduplica ripeterà.
    expect(calls.updates.at(-1)).toMatchObject({ gdo_agenda_esito: 'consegnato' });
    expect(calls.events.some((e) => e.type === 'gdo_agenda_esito')).toBe(true);
  });

  it('telefono spento: nessun delivered entro l\'attesa → inviato, non fallito', async () => {
    const { supabase, calls } = makeSupabase({ statusSequence: ['sent'] });

    const res = await runSendAgenda(supabase, PAYLOAD, fakeDeps());

    expect(res).toMatchObject({ ok: true, esito: 'inviato' });
    expect(calls.updates.at(-1)).toMatchObject({ gdo_agenda_esito: 'inviato' });
  });

  it('Twilio rifiuta l\'invio → fallito, senza aspettare nessuna consegna', async () => {
    vi.mocked(enrollGdoLeadAsPostino).mockResolvedValue({ ok: false, conversationId: 42, error: 'twilio 63024' });
    const { supabase } = makeSupabase({ statusSequence: ['delivered'] });

    const res = await runSendAgenda(supabase, PAYLOAD, fakeDeps());

    expect(res).toMatchObject({ ok: false, esito: 'fallito', error: 'twilio 63024' });
  });

  it('numero non normalizzabile → fallito subito, nessun invio', async () => {
    const { supabase, calls } = makeSupabase();

    const res = await runSendAgenda(supabase, { ...PAYLOAD, phone: 'non un numero' }, fakeDeps());

    expect(res).toMatchObject({ ok: false, esito: 'fallito', error: 'invalid_phone' });
    expect(enrollGdoLeadAsPostino).not.toHaveBeenCalled();
    expect(calls.events.some((e) => e.type === 'gdo_agenda_skipped' && e.level === 'warn')).toBe(true);
  });

  it('il telefono grezzo del CRM viene normalizzato in E.164 prima dell\'invio', async () => {
    const { supabase } = makeSupabase({ statusSequence: ['delivered'] });

    await runSendAgenda(supabase, PAYLOAD, fakeDeps());

    expect(vi.mocked(enrollGdoLeadAsPostino).mock.calls[0][1]).toMatchObject({
      phone: '+393331234567',
      crmLeadId: 'gdo-1',
      variant: PAYLOAD.variant,
    });
  });
});

describe('runSendAgenda — deduplica a 15 minuti', () => {
  const ORA = Date.parse('2026-07-29T10:00:00Z');
  const minutiFa = (m: number) => new Date(ORA - m * 60_000).toISOString();
  const conOrologio = () => {
    let t = ORA;
    return { now: () => t, sleep: async (ms: number) => { t += ms; } };
  };

  it('secondo click sullo stesso lead entro 15 minuti → niente re-invio, stesso esito di prima', async () => {
    const { supabase, calls } = makeSupabase({
      convPrecedente: { id: 42, gdo_agenda_at: minutiFa(3), gdo_agenda_esito: 'consegnato' },
    });

    const res = await runSendAgenda(supabase, PAYLOAD, conOrologio());

    expect(res).toMatchObject({ ok: true, esito: 'consegnato', deduplicato: true, conversationId: 42 });
    expect(enrollGdoLeadAsPostino).not.toHaveBeenCalled();
    expect(calls.events.some((e) => e.type === 'gdo_agenda_dedup')).toBe(true);
  });

  it('dopo un fallimento vero il GDO può ritentare subito', async () => {
    const { supabase } = makeSupabase({
      convPrecedente: { id: 42, gdo_agenda_at: minutiFa(3), gdo_agenda_esito: 'fallito' },
      statusSequence: ['delivered'],
    });

    const res = await runSendAgenda(supabase, PAYLOAD, conOrologio());

    expect(res).toMatchObject({ ok: true, esito: 'consegnato' });
    expect(enrollGdoLeadAsPostino).toHaveBeenCalledTimes(1);
  });

  it('oltre i 15 minuti l\'agenda si rimanda', async () => {
    const { supabase } = makeSupabase({
      convPrecedente: { id: 42, gdo_agenda_at: minutiFa(16), gdo_agenda_esito: 'consegnato' },
      statusSequence: ['delivered'],
    });

    const res = await runSendAgenda(supabase, PAYLOAD, conOrologio());

    expect(res.deduplicato ?? false).toBe(false);
    expect(enrollGdoLeadAsPostino).toHaveBeenCalledTimes(1);
  });

  it('lead mai visto → nessuna deduplica', async () => {
    const { supabase } = makeSupabase({ statusSequence: ['delivered'] });

    const res = await runSendAgenda(supabase, PAYLOAD, conOrologio());

    expect(res.deduplicato ?? false).toBe(false);
    expect(enrollGdoLeadAsPostino).toHaveBeenCalledTimes(1);
  });
});

describe('runSendAgenda — il CRM aspetta al massimo 10 secondi', () => {
  it('l\'attesa della consegna non supera gli 8 secondi dall\'inizio della richiesta', async () => {
    let t = 0;
    const deps = { now: () => t, sleep: async (ms: number) => { t += ms; } };
    // L'invio a Twilio consuma già 2 secondi prima che si inizi ad attendere.
    vi.mocked(enrollGdoLeadAsPostino).mockImplementation(async () => {
      t += 2_000;
      return { ok: true, conversationId: 42, sid: 'SM_AGENDA' };
    });
    const { supabase } = makeSupabase({ statusSequence: ['sent'] });

    const res = await runSendAgenda(supabase, PAYLOAD, deps);

    expect(res.esito).toBe('inviato');
    expect(t).toBeLessThanOrEqual(8_000);
  });
});
