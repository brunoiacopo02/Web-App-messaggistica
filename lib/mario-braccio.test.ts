import { describe, it, expect, beforeEach } from 'vitest';
import {
  secchielloConversazione, braccioDaPercentuale, normalizzaPercentuale, leggiPercentualeOpus,
  braccioConversazione, _azzeraCachePercentuale, SETTING_PERCENTUALE_OPUS,
} from './mario-braccio';

/** Supabase finto: app_settings con una percentuale, conversations con mario_braccio. */
function finto(opts: { percentuale?: unknown; braccio?: string | null; appSettingsErrore?: boolean } = {}) {
  const stato = { braccio: opts.braccio ?? null, update: 0 };
  const supa = {
    from(tabella: string) {
      const q: Record<string, unknown> = {};
      let isUpdate = false;
      let payload: Record<string, unknown> = {};
      let condNull = false;
      const api = {
        select: () => api,
        eq: () => api,
        is: (_c: string, _v: null) => { condNull = true; return api; },
        update: (p: Record<string, unknown>) => { isUpdate = true; payload = p; return api; },
        maybeSingle: async () => {
          if (tabella === 'app_settings') {
            if (opts.appSettingsErrore) throw new Error('giu');
            return { data: opts.percentuale === undefined ? null : { value: opts.percentuale } };
          }
          return { data: { mario_braccio: stato.braccio } };
        },
        then: (res: (v: unknown) => void) => {
          // update ... .select(): risolve qui
          if (isUpdate) {
            stato.update++;
            if (condNull && stato.braccio !== null) return res({ data: [] });
            stato.braccio = payload.mario_braccio as string;
            return res({ data: [{ mario_braccio: stato.braccio }] });
          }
          return res({ data: null });
        },
      };
      void q;
      return api;
    },
  };
  return { supa: supa as never, stato };
}

beforeEach(() => {
  _azzeraCachePercentuale();
  delete process.env.MARIO_OPUS_PERCENTUALE;
});

describe('secchiello e braccio', () => {
  it('stabile e fra 0 e 99', () => {
    for (const id of [1, 42, 25581, 999999]) {
      const s = secchielloConversazione(id);
      expect(s).toBe(secchielloConversazione(id));
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThan(100);
    }
  });

  it('a 0 tutti sonnet, a 100 tutti opus, a 25 circa un quarto', () => {
    const ids = Array.from({ length: 4000 }, (_, i) => 20000 + i);
    expect(ids.every((id) => braccioDaPercentuale(id, 0) === 'sonnet')).toBe(true);
    expect(ids.every((id) => braccioDaPercentuale(id, 100) === 'opus')).toBe(true);
    const quota = ids.filter((id) => braccioDaPercentuale(id, 25) === 'opus').length / ids.length;
    expect(quota).toBeGreaterThan(0.21);
    expect(quota).toBeLessThan(0.29);
  });

  it('alzare la percentuale non toglie nessuno dal braccio opus', () => {
    const ids = Array.from({ length: 2000 }, (_, i) => 30000 + i);
    for (const id of ids) if (braccioDaPercentuale(id, 25) === 'opus') expect(braccioDaPercentuale(id, 50)).toBe('opus');
  });

  it('normalizza la percentuale', () => {
    expect(normalizzaPercentuale(25)).toBe(25);
    expect(normalizzaPercentuale('50')).toBe(50);
    expect(normalizzaPercentuale(140)).toBe(100);
    expect(normalizzaPercentuale(-3)).toBe(0);
    expect(normalizzaPercentuale('boh')).toBeNull();
    expect(normalizzaPercentuale(null)).toBeNull();
  });
});

describe('percentuale da app_settings', () => {
  it(`legge ${SETTING_PERCENTUALE_OPUS}`, async () => {
    expect(await leggiPercentualeOpus(finto({ percentuale: 25 }).supa)).toBe(25);
  });
  it("senza riga vale l'env, senza env vale 0", async () => {
    expect(await leggiPercentualeOpus(finto().supa)).toBe(0);
    _azzeraCachePercentuale();
    process.env.MARIO_OPUS_PERCENTUALE = '30';
    expect(await leggiPercentualeOpus(finto().supa)).toBe(30);
  });
  it('un errore del DB non rompe niente', async () => {
    expect(await leggiPercentualeOpus(finto({ appSettingsErrore: true }).supa)).toBe(0);
  });
});

describe('braccioConversazione', () => {
  it('a percentuale 0 sempre sonnet, anche se la chat era su opus (interruttore)', async () => {
    const { supa } = finto({ percentuale: 0, braccio: 'opus' });
    expect(await braccioConversazione(supa, 123)).toBe('sonnet');
  });

  it('il braccio gia scritto vince sulla percentuale', async () => {
    const { supa, stato } = finto({ percentuale: 100, braccio: 'sonnet' });
    expect(await braccioConversazione(supa, 123)).toBe('sonnet');
    expect(stato.update).toBe(0);
  });

  it('al primo uso assegna dall hash e lo scrive', async () => {
    const { supa, stato } = finto({ percentuale: 100 });
    expect(await braccioConversazione(supa, 123)).toBe('opus');
    expect(stato.braccio).toBe('opus');
    expect(stato.update).toBe(1);
  });
});
