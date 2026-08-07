import { describe, it, expect } from 'vitest';
import { runAppointmentSet } from './appointment-set';

/** Fake Supabase minimo: una sola conversazione, update ed event_log tracciati. */
function makeSupabase(conv: { id: number; gdo_appuntamento_at: string | null } | null) {
  const calls = { updates: [] as Record<string, unknown>[], events: [] as { type: string; payload: Record<string, unknown> }[] };
  const supabase: any = {
    from(tabella: string) {
      if (tabella === 'event_log') {
        return {
          insert: (r: { type: string; payload: Record<string, unknown> }) => {
            calls.events.push(r);
            return Promise.resolve({});
          },
        };
      }
      return {
        select() {
          const stub: any = {
            eq() { return stub; },
            order() { return stub; },
            limit: () => Promise.resolve({ data: conv ? [conv] : [] }),
          };
          return stub;
        },
        update(patch: Record<string, unknown>) {
          calls.updates.push(patch);
          return { eq: () => Promise.resolve({}) };
        },
      };
    },
  };
  return { supabase, calls };
}

const D1 = '2026-08-07T18:00:00+02:00';
const D2 = '2026-08-09T10:30:00+02:00';

describe('runAppointmentSet', () => {
  it('primo set: scrive la data', async () => {
    const { supabase, calls } = makeSupabase({ id: 7, gdo_appuntamento_at: null });
    const r = await runAppointmentSet(supabase, { leadId: 'u1', appointmentAt: D1 });

    expect(r).toMatchObject({ ok: true, esito: 'registrato', conversationId: 7 });
    expect(calls.updates).toEqual([{ gdo_appuntamento_at: D1 }]);
    expect(calls.events.map((e) => e.type)).toContain('appuntamento_registrato');
  });

  it('spostamento: vince l\'ultima data ricevuta, e resta la traccia di quella prima', async () => {
    const { supabase, calls } = makeSupabase({ id: 7, gdo_appuntamento_at: D1 });
    const r = await runAppointmentSet(supabase, { leadId: 'u1', appointmentAt: D2 });

    expect(r).toMatchObject({ ok: true, esito: 'spostato', precedente: D1 });
    expect(calls.updates).toEqual([{ gdo_appuntamento_at: D2 }]);
    const ev = calls.events.find((e) => e.type === 'appuntamento_spostato');
    expect(ev?.payload).toMatchObject({ da: D1, a: D2 });
  });

  it('stessa data ripetuta: idempotente, nessuna scrittura', async () => {
    // Sui loro dati la data arriva quasi sempre subito dopo l'agenda: le ripetizioni
    // sono la norma, non l'eccezione.
    const { supabase, calls } = makeSupabase({ id: 7, gdo_appuntamento_at: D1 });
    const r = await runAppointmentSet(supabase, { leadId: 'u1', appointmentAt: D1 });

    expect(r).toMatchObject({ ok: true, esito: 'invariato' });
    expect(calls.updates).toEqual([]);
    expect(calls.events).toEqual([]);
  });

  it('stesso istante scritto con offset diversi vale come invariato', async () => {
    // Da Postgres la colonna torna in UTC, da loro arriva nel fuso italiano: un
    // confronto testuale vedrebbe uno spostamento a ogni chiamata.
    const { supabase, calls } = makeSupabase({ id: 7, gdo_appuntamento_at: '2026-08-07T16:00:00+00:00' });
    const r = await runAppointmentSet(supabase, { leadId: 'u1', appointmentAt: D1 });

    expect(r.esito).toBe('invariato');
    expect(calls.updates).toEqual([]);
  });

  it('lead che non conosciamo: non e un errore, si registra e si risponde', async () => {
    const { supabase, calls } = makeSupabase(null);
    const r = await runAppointmentSet(supabase, { leadId: 'ignoto', appointmentAt: D1 });

    expect(r).toMatchObject({ ok: true, esito: 'lead_sconosciuto' });
    expect(calls.updates).toEqual([]);
    expect(calls.events.map((e) => e.type)).toContain('appuntamento_lead_sconosciuto');
  });

  it('non tocca mai bot_scheduled_at: quello e il registro del nostro esito', async () => {
    const { supabase, calls } = makeSupabase({ id: 7, gdo_appuntamento_at: null });
    await runAppointmentSet(supabase, { leadId: 'u1', appointmentAt: D1 });

    for (const patch of calls.updates) expect(Object.keys(patch)).toEqual(['gdo_appuntamento_at']);
  });
});
