import { describe, it, expect } from 'vitest';
import {
  parseSospensioni, numeroSospeso, daRiaccendere, aggiornaSospensioniSollecitiNr,
  KEY_SOLLECITI_NR_SOSPESI, EVENTO_SOLLECITI_NR_RIACCESI,
} from './solleciti-nr-sospesi';

const N3199 = '+393520413199';
const N8061 = '+393520158061';

/** Storico di un numero: `giorni` letture dal giorno `da` in avanti. */
function storico(da: string, letture: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const d = new Date(`${da}T12:00:00Z`);
  for (const q of letture) {
    out[d.toISOString().slice(0, 10)] = q;
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

describe('parseSospensioni / numeroSospeso', () => {
  it('legge la voce del 3199, con o senza whatsapp:', () => {
    const s = parseSospensioni({ 'whatsapp:+393520413199': { dal: '2026-11-12', giorni_high: 7 } });
    expect(s).toEqual({ [N3199]: { dal: '2026-11-12', giorniHigh: 7 } });
    expect(numeroSospeso(s, 'whatsapp:+393520413199')).toEqual({ dal: '2026-11-12', giorniHigh: 7 });
    expect(numeroSospeso(s, N3199)).not.toBeNull();
    expect(numeroSospeso(s, `whatsapp:${N8061}`)).toBeNull();
  });

  it('riga assente, vuota o illeggibile = nessuna sospensione', () => {
    for (const raw of [null, undefined, {}, [], 'on', 3]) expect(parseSospensioni(raw)).toEqual({});
    expect(numeroSospeso({}, N3199)).toBeNull();
    expect(numeroSospeso(parseSospensioni({ [N3199]: { dal: '2026-11-12' } }), null)).toBeNull();
  });

  it('forme scritte a mano: true = sospeso (7 giorni), false = non sospeso', () => {
    expect(parseSospensioni({ [N3199]: true })).toEqual({ [N3199]: { dal: null, giorniHigh: 7 } });
    expect(parseSospensioni({ [N3199]: false })).toEqual({});
    expect(parseSospensioni({ [N3199]: { dal: 'ieri', giorni_high: 0 } })).toEqual({ [N3199]: { dal: null, giorniHigh: 7 } });
  });
});

describe('daRiaccendere — 7 giorni HIGH di fila', () => {
  const sospensioni = { [N3199]: { dal: '2026-11-12', giorniHigh: 7 } };

  it('7 giorni HIGH chiusi dopo la sospensione (13-19/11) → il 20/11 si riaccende', () => {
    const st = { [N3199]: storico('2026-11-10', ['MEDIUM', 'LOW', 'LOW', 'HIGH', 'HIGH', 'HIGH', 'HIGH', 'HIGH', 'HIGH', 'HIGH', 'HIGH']) };
    expect(daRiaccendere({ sospensioni, storico: st, oggi: '2026-11-20' })).toEqual([N3199]);
  });

  it('6 giorni HIGH e 1 MEDIUM → resta sospesa', () => {
    const st = { [N3199]: storico('2026-11-13', ['HIGH', 'HIGH', 'HIGH', 'MEDIUM', 'HIGH', 'HIGH', 'HIGH', 'HIGH']) };
    expect(daRiaccendere({ sospensioni, storico: st, oggi: '2026-11-20' })).toEqual([]);
    // Il MEDIUM del 16/11 fa ripartire la fila: 17-23 HIGH → si riaccende il 24.
    const poi = { [N3199]: storico('2026-11-13', ['HIGH', 'HIGH', 'HIGH', 'MEDIUM', 'HIGH', 'HIGH', 'HIGH', 'HIGH', 'HIGH', 'HIGH', 'HIGH', 'HIGH']) };
    expect(daRiaccendere({ sospensioni, storico: poi, oggi: '2026-11-23' })).toEqual([]);
    expect(daRiaccendere({ sospensioni, storico: poi, oggi: '2026-11-24' })).toEqual([N3199]);
  });

  it('solo 6 giorni HIGH chiusi (il settimo e oggi, ancora in corso) → resta sospesa', () => {
    const st = { [N3199]: storico('2026-11-13', ['HIGH', 'HIGH', 'HIGH', 'HIGH', 'HIGH', 'HIGH', 'HIGH']) };
    expect(daRiaccendere({ sospensioni, storico: st, oggi: '2026-11-19' })).toEqual([]);
  });

  it('un giorno senza lettura o UNKNOWN nella fila → resta sospesa', () => {
    const buco = storico('2026-11-13', ['HIGH', 'HIGH', 'HIGH', 'HIGH', 'HIGH', 'HIGH', 'HIGH']);
    delete buco['2026-11-15'];
    expect(daRiaccendere({ sospensioni, storico: { [N3199]: buco }, oggi: '2026-11-20' })).toEqual([]);
    const ignoto = { [N3199]: storico('2026-11-13', ['HIGH', 'HIGH', 'UNKNOWN', 'HIGH', 'HIGH', 'HIGH', 'HIGH']) };
    expect(daRiaccendere({ sospensioni, storico: ignoto, oggi: '2026-11-20' })).toEqual([]);
    expect(daRiaccendere({ sospensioni, storico: {}, oggi: '2026-11-20' })).toEqual([]);
  });

  it('7 giorni HIGH ma oggi e gia stato letto LOW → resta sospesa', () => {
    const st = { [N3199]: storico('2026-11-13', ['HIGH', 'HIGH', 'HIGH', 'HIGH', 'HIGH', 'HIGH', 'HIGH', 'LOW']) };
    expect(daRiaccendere({ sospensioni, storico: st, oggi: '2026-11-20' })).toEqual([]);
  });

  it('i giorni HIGH di PRIMA della sospensione non contano', () => {
    // Sospeso a mano il 12/11 con lo storico tutto HIGH: non si riaccende il giorno dopo.
    const st = { [N3199]: storico('2026-11-01', Array(19).fill('HIGH')) };
    expect(daRiaccendere({ sospensioni, storico: st, oggi: '2026-11-13' })).toEqual([]);
    expect(daRiaccendere({ sospensioni, storico: st, oggi: '2026-11-19' })).toEqual([]);
    expect(daRiaccendere({ sospensioni, storico: st, oggi: '2026-11-20' })).toEqual([N3199]);
  });

  it('ogni numero per conto suo', () => {
    const due = { ...sospensioni, [N8061]: { dal: '2026-11-12', giorniHigh: 7 } };
    const st = {
      [N3199]: storico('2026-11-13', ['HIGH', 'HIGH', 'HIGH', 'LOW', 'HIGH', 'HIGH', 'HIGH']),
      [N8061]: storico('2026-11-13', Array(7).fill('HIGH')),
    };
    expect(daRiaccendere({ sospensioni: due, storico: st, oggi: '2026-11-20' })).toEqual([N8061]);
  });
});

/** Finto `app_settings` + `event_log`: le righe restano, cosi' si rilegge cosa e' stato scritto. */
function fake(righe: Record<string, unknown>) {
  const eventi: { type: string; payload: Record<string, unknown> }[] = [];
  const supabase = {
    from(table: string) {
      if (table === 'event_log') {
        return { insert: (r: never) => { eventi.push(r); return Promise.resolve({ error: null }); } };
      }
      return {
        select: () => ({ eq: (_c: string, k: string) => ({ maybeSingle: async () => ({ data: k in righe ? { value: righe[k] } : null, error: null }) }) }),
        update: (p: { value: unknown }) => ({ eq: async (_c: string, k: string) => { righe[k] = p.value; return { error: null }; } }),
      };
    },
  };
  return { supabase: supabase as never, eventi, righe };
}

describe('aggiornaSospensioniSollecitiNr — il cron la toglie da sola', () => {
  const VOCE = { 'whatsapp:+393520413199': { dal: '2026-11-12', giorni_high: 7 } };

  it('7 giorni HIGH → toglie la voce e scrive l evento', async () => {
    const f = fake({
      [KEY_SOLLECITI_NR_SOSPESI]: { ...VOCE },
      qualita_numeri_stato: { storico: { [N3199]: storico('2026-11-11', ['LOW', 'LOW', 'HIGH', 'HIGH', 'HIGH', 'HIGH', 'HIGH', 'HIGH', 'HIGH', 'HIGH']) }, pause: {} },
    });
    const r = await aggiornaSospensioniSollecitiNr(f.supabase, new Date('2026-11-20T05:10:00Z'));
    expect(r.riaccesi).toEqual([N3199]);
    expect(f.righe[KEY_SOLLECITI_NR_SOSPESI]).toEqual({});
    expect(f.eventi.map((e) => e.type)).toEqual([EVENTO_SOLLECITI_NR_RIACCESI]);
    expect(f.eventi[0].payload).toMatchObject({ numero: N3199, dal: '2026-11-12', giorniHigh: 7 });
  });

  it('6 giorni HIGH e 1 MEDIUM → la voce resta, nessun evento', async () => {
    const f = fake({
      [KEY_SOLLECITI_NR_SOSPESI]: { ...VOCE },
      qualita_numeri_stato: { storico: { [N3199]: storico('2026-11-13', ['HIGH', 'HIGH', 'MEDIUM', 'HIGH', 'HIGH', 'HIGH', 'HIGH', 'HIGH']) }, pause: {} },
    });
    const r = await aggiornaSospensioniSollecitiNr(f.supabase, new Date('2026-11-20T05:10:00Z'));
    expect(r.riaccesi).toEqual([]);
    expect(f.righe[KEY_SOLLECITI_NR_SOSPESI]).toEqual(VOCE);
    expect(f.eventi).toEqual([]);
  });

  it('oggi (12/11, storico vero: LOW 11 e 12) → resta sospesa', async () => {
    const f = fake({
      [KEY_SOLLECITI_NR_SOSPESI]: { ...VOCE },
      qualita_numeri_stato: { storico: { [N3199]: storico('2026-11-06', ['HIGH', 'MEDIUM', 'HIGH', 'HIGH', 'MEDIUM', 'LOW', 'LOW']) }, pause: {} },
    });
    expect((await aggiornaSospensioniSollecitiNr(f.supabase, new Date('2026-11-12T20:10:00Z'))).riaccesi).toEqual([]);
    expect(f.righe[KEY_SOLLECITI_NR_SOSPESI]).toEqual(VOCE);
  });

  it('nessuna impostazione → non tocca niente', async () => {
    const f = fake({ qualita_numeri_stato: { storico: {}, pause: {} } });
    expect((await aggiornaSospensioniSollecitiNr(f.supabase, new Date('2026-11-20T05:10:00Z'))).riaccesi).toEqual([]);
    expect(KEY_SOLLECITI_NR_SOSPESI in f.righe).toBe(false);
  });

  it('una lettura che esplode non fa fallire il cron', async () => {
    const rotto = { from: () => { throw new Error('giu'); } } as never;
    await expect(aggiornaSospensioniSollecitiNr(rotto)).resolves.toEqual({ riaccesi: [] });
  });
});
