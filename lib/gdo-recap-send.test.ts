import { describe, it, expect } from 'vitest';
import { claimRecap } from './gdo-recap-send';

/**
 * Finto client: una riga di `conversations` in memoria. L'update applica davvero i
 * filtri `.eq('id')`, `.is(col, null)` e l'`.or()` del claim, e torna le righe toccate
 * con `.select('id')`. Il confronto sulla data è fra stringhe, come quello che
 * PostgREST riceve nell'URL: per questo `claimRecap` deve normalizzare in ISO UTC.
 */
function makeSupabase(riga: Record<string, any>) {
  const updates: any[] = [];
  const supabase: any = {
    from(table: string) {
      if (table !== 'conversations') throw new Error(`tabella inattesa: ${table}`);
      return {
        update(payload: any) {
          const filtri: Array<(r: Record<string, any>) => boolean> = [];
          const applica = () => {
            const ok = filtri.every((f) => f(riga));
            if (ok) { Object.assign(riga, payload); updates.push(payload); }
            return { data: ok ? [{ id: riga.id }] : [], error: null };
          };
          const q: any = {
            eq: (col: string, val: any) => { filtri.push((r) => r[col] === val); return q; },
            is: (col: string, val: null) => { filtri.push((r) => r[col] === val); return q; },
            or: (expr: string) => {
              const clausole = expr.split(',').map((c) => {
                const [col, op, ...resto] = c.split('.');
                const val = resto.join('.');
                if (op === 'is' && val === 'null') return (r: Record<string, any>) => r[col] == null;
                if (op === 'neq') return (r: Record<string, any>) => r[col] !== val;
                throw new Error(`clausola inattesa: ${c}`);
              });
              filtri.push((r) => clausole.some((f) => f(r)));
              return q;
            },
            select: () => q,
            then: (resolve: any) => resolve(applica()),
          };
          return q;
        },
      };
    },
  };
  return { supabase, riga, updates };
}

describe('claimRecap', () => {
  it('la prima volta prende il recap, la seconda no anche con la stessa data in un altro fuso', async () => {
    const { supabase, riga } = makeSupabase({ id: 7, gdo_recap_for_at: null, gdo_noemi_reminded_at: null });

    expect(await claimRecap(supabase, 7, '2026-10-23T17:00:00+02:00', false)).toBe(true);
    expect(riga.gdo_recap_for_at).toBe('2026-10-23T15:00:00.000Z');
    expect(riga.gdo_recap_sent_at).toBeTruthy();

    expect(await claimRecap(supabase, 7, '2026-10-23T15:00:00Z', false)).toBe(false);
  });

  it('una call spostata a un altro orario si riassume di nuovo', async () => {
    const { supabase } = makeSupabase({ id: 7, gdo_recap_for_at: '2026-10-23T15:00:00.000Z' });
    expect(await claimRecap(supabase, 7, '2026-10-24T15:00:00Z', false)).toBe(true);
  });

  it('con Noemi segna anche il promemoria, ma solo se non era già segnato', async () => {
    const fresca = makeSupabase({ id: 7, gdo_recap_for_at: null, gdo_noemi_reminded_at: null });
    expect(await claimRecap(fresca.supabase, 7, '2026-10-23T15:00:00Z', true)).toBe(true);
    expect(fresca.riga.gdo_noemi_reminded_at).toBeTruthy();

    const PRIMA = '2026-10-20T10:00:00.000Z';
    const gia = makeSupabase({ id: 7, gdo_recap_for_at: null, gdo_noemi_reminded_at: PRIMA });
    expect(await claimRecap(gia.supabase, 7, '2026-10-23T15:00:00Z', true)).toBe(true);
    expect(gia.riga.gdo_noemi_reminded_at).toBe(PRIMA);
  });

  it('senza Noemi il promemoria non si tocca', async () => {
    const { supabase, riga } = makeSupabase({ id: 7, gdo_recap_for_at: null, gdo_noemi_reminded_at: null });
    await claimRecap(supabase, 7, '2026-10-23T15:00:00Z', false);
    expect(riga.gdo_noemi_reminded_at).toBeNull();
  });
});
