import { describe, it, expect } from 'vitest';
import { alertUnaVolta } from './alert-una-volta';

/** Finto client: un event_log in memoria, con `.eq()` e `.contains()` che filtrano davvero. */
function makeSupabase(esistenti: Array<{ type: string; payload: any }> = []) {
  const inseriti: any[] = [];
  const supabase: any = {
    from(table: string) {
      if (table !== 'event_log') throw new Error(`tabella inattesa: ${table}`);
      const filtri: any = {};
      const q: any = {
        select: () => q,
        eq: (col: string, val: any) => { filtri[col] = val; return q; },
        contains: (_col: string, val: any) => { filtri.payload = val; return q; },
        limit: async () => ({
          data: esistenti.filter((e) =>
            (!filtri.type || e.type === filtri.type) &&
            (!filtri.payload || Object.entries(filtri.payload).every(([k, v]) => e.payload?.[k] === v))),
          error: null,
        }),
        insert: async (row: any) => { inseriti.push(row); return { error: null }; },
      };
      return q;
    },
  };
  return { supabase, inseriti };
}

describe('alertUnaVolta', () => {
  it('la prima volta scrive l\'alert', async () => {
    const { supabase, inseriti } = makeSupabase();
    const scritto = await alertUnaVolta(supabase, {
      type: 'stale_booked_no_outcome', conversationId: 3401, message: 'conv 3401 ferma', level: 'error',
    });
    expect(scritto).toBe(true);
    expect(inseriti).toHaveLength(1);
    expect(inseriti[0]).toMatchObject({ type: 'stale_booked_no_outcome', level: 'error' });
    expect(inseriti[0].payload).toMatchObject({ conversationId: 3401 });
  });

  it('la seconda volta non lo ripete: un cron orario faceva 100 righe per la stessa chat', async () => {
    const { supabase, inseriti } = makeSupabase([
      { type: 'stale_booked_no_outcome', payload: { conversationId: 3401 } },
    ]);
    const scritto = await alertUnaVolta(supabase, {
      type: 'stale_booked_no_outcome', conversationId: 3401, message: 'conv 3401 ferma', level: 'error',
    });
    expect(scritto).toBe(false);
    expect(inseriti).toHaveLength(0);
  });

  it('un alert su un\'altra conversazione passa lo stesso', async () => {
    const { supabase, inseriti } = makeSupabase([
      { type: 'stale_booked_no_outcome', payload: { conversationId: 3401 } },
    ]);
    expect(await alertUnaVolta(supabase, {
      type: 'stale_booked_no_outcome', conversationId: 9999, message: 'conv 9999 ferma', level: 'error',
    })).toBe(true);
    expect(inseriti).toHaveLength(1);
  });

  it('un alert di tipo diverso sulla stessa conversazione passa lo stesso', async () => {
    const { supabase, inseriti } = makeSupabase([
      { type: 'stale_handed_off', payload: { conversationId: 3401 } },
    ]);
    expect(await alertUnaVolta(supabase, {
      type: 'stale_booked_no_outcome', conversationId: 3401, message: 'conv 3401 ferma', level: 'error',
    })).toBe(true);
    expect(inseriti).toHaveLength(1);
  });

  it('campi extra nel payload finiscono nell\'alert', async () => {
    const { supabase, inseriti } = makeSupabase();
    await alertUnaVolta(supabase, {
      type: 'stale_booked_no_outcome', conversationId: 12, message: 'x', level: 'warn', payload: { crmLeadId: 'ABC' },
    });
    expect(inseriti[0].payload).toEqual({ conversationId: 12, crmLeadId: 'ABC' });
  });
});
