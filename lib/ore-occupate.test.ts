import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  bloccoOreDistribuite, leggiOreOccupate, oreAffollate, oreDaProporre, parseOreOccupate, rigaGiorno,
  svuotaCacheOreOccupate, FASCE, type OreOccupate,
} from './ore-occupate';
import { bookingSlotsContext, computeBookingDays } from './booking-slots';
import { checkDataAppuntamento } from './bot-outcome-rules';
import { verifySignature } from './bot-hmac';

// Martedì 10/11/2026 come l'ha visto il PO la sera del 09/11: 19 call alle 10.
const MARTEDI = { '9': 0, '10': 19, '11': 6, '12': 4, '13': 2, '14': 4, '15': 7, '16': 10, '17': 2, '18': 13, '19': 9, '20': 6, '21': 7 };
const MERCOLEDI = { '9': 1, '10': 1, '11': 2, '12': 1, '13': 0, '14': 0, '15': 1, '16': 0, '17': 2, '18': 3, '19': 4, '20': 4, '21': 2 };
const DATI: OreOccupate = { soglia: 8, giorni: { '2026-11-10': MARTEDI, '2026-11-11': MERCOLEDI } };
// Lunedì 09/11 alle 18:50, come quando Sara (conv 29654) si è sentita dire «le 10 o le 11?».
const LUN_SERA = new Date('2026-11-09T17:50:00Z');

describe('oreDaProporre: ora piena -> altre ore', () => {
  it('la mattina di martedì non propone le 10 (19 call): propone le meno piene', () => {
    expect(oreDaProporre(MARTEDI, FASCE[0].ore)).toEqual([12, 13]);
  });
  it('pomeriggio e sera: evita 16 e 18, le ore piene', () => {
    expect(oreDaProporre(MARTEDI, FASCE[1].ore)).toEqual([14, 17]);
    expect(oreDaProporre(MARTEDI, FASCE[2].ore)).toEqual([20, 21]);
  });
  it('agenda vuota: non ricade sulla prima ora della fascia (era la causa delle 10 e delle 15)', () => {
    const vuoto = {};
    expect(oreDaProporre(vuoto, FASCE[0].ore)).toEqual([11, 12]);
    expect(oreDaProporre(vuoto, FASCE[1].ore)).toEqual([15, 16]);
    expect(oreDaProporre(vuoto, FASCE[2].ore)).toEqual([19, 20]);
  });
  it('fascia tutta piena: restano le due meno piene della stessa fascia, non si cambia fascia', () => {
    const tutto = { '10': 20, '11': 9, '12': 12, '13': 10 };
    expect(oreDaProporre(tutto, FASCE[0].ore)).toEqual([11, 13]);
  });
});

describe('oreAffollate e soglia', () => {
  it('soglia 8: 10, 16, 18, 19 piene; le 9 non contano mai', () => {
    expect(oreAffollate(MARTEDI, 8)).toEqual([10, 16, 18, 19]);
    expect(oreAffollate({ '9': 30 }, 8)).toEqual([]);
  });
  it('soglia piu alta dal CRM: meno ore piene', () => {
    expect(oreAffollate(MARTEDI, 14)).toEqual([10]);
  });
});

describe('bloccoOreDistribuite', () => {
  const { day1, day2 } = computeBookingDays(LUN_SERA, []);
  it('i giorni sono martedì 10 e mercoledì 11 (dopo le 20 ruoterebbe)', () => {
    expect([day1.date, day2.date]).toEqual(['2026-11-10', '2026-11-11']);
  });
  it('fasce rispettate: due ore per mattina, pomeriggio, sera; le piene elencate', () => {
    expect(rigaGiorno(day1, MARTEDI, 8)).toBe(
      '- martedì 10/11/2026: la mattina 12:00 o 13:00, il pomeriggio 14:00 o 17:00, la sera 20:00 o 21:00. Già piene: 10:00, 16:00, 18:00, 19:00.',
    );
    expect(rigaGiorno(day2, MERCOLEDI, 8)).toBe(
      '- mercoledì 11/11/2026: la mattina 12:00 o 13:00, il pomeriggio 14:00 o 16:00, la sera 18:00 o 21:00.',
    );
  });
  it('il lead che vuole un\'ora piena se la tiene', () => {
    const b = bloccoOreDistribuite([day1, day2], DATI)!;
    expect(b).toContain('SE È IL LEAD A DIRTI UN\'ORA');
    expect(b).toContain('va bene quella anche se è fra le già piene');
    expect(b).toContain('Non dire "dalle 10", "dalle 10 in poi"');
  });
  it('niente dati o nessun giorno combacia: nessun blocco', () => {
    expect(bloccoOreDistribuite([day1, day2], null)).toBeNull();
    expect(bloccoOreDistribuite([day1, day2], { soglia: 8, giorni: { '2026-12-01': {} } })).toBeNull();
  });
});

describe('bookingSlotsContext con le ore occupate', () => {
  it('senza dati: identico a prima', () => {
    expect(bookingSlotsContext(LUN_SERA, { ranges: [] })).toBe(bookingSlotsContext(LUN_SERA, { ranges: [], oreOccupate: null }));
  });
  it('con i dati: il blocco di prima resta intatto e le ore vanno in coda', () => {
    const prima = bookingSlotsContext(LUN_SERA, { ranges: [] });
    const dopo = bookingSlotsContext(LUN_SERA, { ranges: [], oreOccupate: DATI });
    expect(dopo.startsWith(`${prima}\nORE DA PROPORRE`)).toBe(true);
    expect(dopo).toContain('la mattina 12:00 o 13:00');
  });
});

describe('ora scelta dal lead: la guardia non la scarta anche se piena', () => {
  it('martedì 10 alle 10:00 resta un appuntamento valido', () => {
    expect(checkDataAppuntamento('2026-11-10T10:00:00+01:00', LUN_SERA.getTime(), [])).toEqual({ ok: true });
  });
});

describe('parseOreOccupate', () => {
  it('accetta la forma del CRM', () => {
    expect(parseOreOccupate({ soglia: 8, giorni: { '2026-11-10': { 9: 0, 10: 19 } } })).toEqual({ soglia: 8, giorni: { '2026-11-10': { '9': 0, '10': 19 } } });
  });
  it('rifiuta forme strane', () => {
    expect(parseOreOccupate(null)).toBeNull();
    expect(parseOreOccupate({ soglia: 0, giorni: {} })).toBeNull();
    expect(parseOreOccupate({ soglia: 8, giorni: { ieri: {} } })).toBeNull();
    expect(parseOreOccupate({ soglia: 8, giorni: { '2026-11-10': { 10: 'tanti' } } })).toBeNull();
  });
});

describe('leggiOreOccupate', () => {
  const env = process.env.BOT_WEBHOOK_SECRET;
  beforeEach(() => { svuotaCacheOreOccupate(); process.env.BOT_WEBHOOK_SECRET = 'segreto'; });
  afterEach(() => { process.env.BOT_WEBHOOK_SECRET = env; });

  it('firma la richiesta, legge la risposta e la tiene in cache', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = String(init?.body);
      const firma = (init?.headers as Record<string, string>)['x-bot-signature'];
      expect(verifySignature(body, firma, 'segreto')).toEqual({ valid: true });
      expect(JSON.parse(body)).toEqual({ giorni: ['2026-11-10', '2026-11-11'] });
      return new Response(JSON.stringify(DATI), { status: 200 });
    }) as unknown as typeof fetch;
    expect(await leggiOreOccupate(['2026-11-11', '2026-11-10'], { fetchImpl, now: 1000 })).toEqual(DATI);
    expect(await leggiOreOccupate(['2026-11-10', '2026-11-11'], { fetchImpl, now: 60_000 })).toEqual(DATI);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('CRM giù o risposta strana: null, e non si mette in cache', async () => {
    const giu = vi.fn(async () => { throw new Error('timeout'); }) as unknown as typeof fetch;
    expect(await leggiOreOccupate(['2026-11-10'], { fetchImpl: giu })).toBeNull();
    const male = vi.fn(async () => new Response('{"error":"x"}', { status: 401 })) as unknown as typeof fetch;
    expect(await leggiOreOccupate(['2026-11-10'], { fetchImpl: male })).toBeNull();
  });
  it('senza segreto non chiama nessuno', async () => {
    delete process.env.BOT_WEBHOOK_SECRET;
    const f = vi.fn() as unknown as typeof fetch;
    expect(await leggiOreOccupate(['2026-11-10'], { fetchImpl: f })).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });
});
