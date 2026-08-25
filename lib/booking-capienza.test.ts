import { describe, it, expect } from 'vitest';
import { tettoGiornaliero, datePiene, contaPerGiorno } from './booking-capienza';

describe('tettoGiornaliero', () => {
  it('env assente → nessun tetto', () => expect(tettoGiornaliero(undefined)).toBeNull());
  it('vuota → nessun tetto', () => expect(tettoGiornaliero('')).toBeNull());
  it('zero → nessun tetto (interruttore di spegnimento)', () => expect(tettoGiornaliero('0')).toBeNull());
  it('un numero valido', () => expect(tettoGiornaliero('25')).toBe(25));
  it('spazi intorno', () => expect(tettoGiornaliero(' 25 ')).toBe(25));
  it('sporcizia → nessun tetto: meglio nessun limite che un limite inventato', () => {
    expect(tettoGiornaliero('venticinque')).toBeNull();
    expect(tettoGiornaliero('-3')).toBeNull();
    expect(tettoGiornaliero('2,5')).toBeNull();
  });
});

describe('contaPerGiorno', () => {
  it('raggruppa per data nel fuso di Roma, non in UTC', () => {
    // 22:30 UTC del 23 giugno = 00:30 del 24 giugno a Roma: la call è del 24.
    const c = contaPerGiorno(['2026-06-23T22:30:00Z', '2026-06-24T08:00:00Z']);
    expect(c.get('2026-06-24')).toBe(2);
    expect(c.get('2026-06-23')).toBeUndefined();
  });

  it('ignora le date nulle o illeggibili', () => {
    const c = contaPerGiorno([null, 'domani', '2026-06-24T08:00:00Z']);
    expect(c.get('2026-06-24')).toBe(1);
    expect(c.size).toBe(1);
  });
});

/** Finto client: torna le date che gli si passano, e registra i filtri usati. */
function makeSupabase(date: Array<string | null>) {
  const filtri: any = {};
  const supabase: any = {
    from: () => {
      const q: any = {
        select: (cols: string) => { filtri.select = cols; return q; },
        not: (col: string, op: string) => { filtri.not = `${col} ${op}`; return q; },
        gte: (col: string, v: string) => { filtri.gte = [col, v]; return q; },
        lt: (col: string, v: string) => { filtri.lt = [col, v]; return q; },
        limit: async () => ({ data: date.map((d) => ({ bot_scheduled_at: d })), error: null }),
      };
      return q;
    },
  };
  return { supabase, filtri };
}

describe('datePiene', () => {
  const ORA = new Date('2026-06-22T10:00:00+02:00');

  it('senza tetto non interroga nemmeno il database', async () => {
    const { supabase, filtri } = makeSupabase([]);
    expect(await datePiene(supabase, null, ORA)).toEqual([]);
    expect(filtri.select).toBeUndefined();
  });

  it('un giorno che ha raggiunto il tetto è pieno', async () => {
    const { supabase } = makeSupabase([
      '2026-06-23T09:00:00Z', '2026-06-23T10:00:00Z', '2026-06-24T09:00:00Z',
    ]);
    expect(await datePiene(supabase, 2, ORA)).toEqual(['2026-06-23']);
  });

  it('sopra il tetto resta pieno', async () => {
    const { supabase } = makeSupabase(['2026-06-23T09:00:00Z', '2026-06-23T10:00:00Z', '2026-06-23T11:00:00Z']);
    expect(await datePiene(supabase, 2, ORA)).toEqual(['2026-06-23']);
  });

  it('sotto il tetto non è pieno', async () => {
    const { supabase } = makeSupabase(['2026-06-23T09:00:00Z']);
    expect(await datePiene(supabase, 2, ORA)).toEqual([]);
  });

  it('guarda solo da oggi in avanti: le call passate non occupano l\'agenda futura', async () => {
    const { supabase, filtri } = makeSupabase([]);
    await datePiene(supabase, 5, ORA);
    expect(filtri.gte[0]).toBe('bot_scheduled_at');
    // Mezzanotte del 22 giugno a Roma = 22:00 UTC del 21: si confronta l'istante.
    expect(new Date(filtri.gte[1]).toISOString()).toBe('2026-06-21T22:00:00.000Z');
  });

  it('un errore del database non blocca il bot: nessun giorno pieno, si fissa come prima', async () => {
    const supabase: any = { from: () => ({ select: () => ({ not: () => ({ gte: () => ({ lt: () => ({ limit: async () => ({ data: null, error: { message: 'boom' } }) }) }) }) }) }) };
    expect(await datePiene(supabase, 5, ORA)).toEqual([]);
  });
});
