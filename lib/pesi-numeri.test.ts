import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  parsePesiNumeri, pesoDi, pesoPredefinito, caricoPesato, getPesiNumeri,
  PESO_ACCOUNT_PRINCIPALE, PESO_ALTRI_ACCOUNT,
} from './pesi-numeri';

const P = '+393520413199';
const N8061 = '+393520158061';
const N0047 = '+393522070047';
const N8718 = '+393522018718';
const N2245 = '+393522622245';
const N2508 = '+393522782508';

beforeEach(() => {
  // I tre account come in produzione: 3199 e 8061 sul principale, 0047 sul secondo,
  // 8718/2245/2508 sul terzo.
  vi.stubEnv('TWILIO_WHATSAPP_NUMBERS_2', N0047);
  vi.stubEnv('TWILIO_WHATSAPP_NUMBERS_3', `${N8718},whatsapp:${N2245}, ${N2508}`);
});
afterEach(() => { vi.unstubAllEnvs(); });

describe('pesoPredefinito (titolare 17/11/2026)', () => {
  it('0,9 per i numeri dell account principale, 1 per gli altri', () => {
    expect(PESO_ACCOUNT_PRINCIPALE).toBe(0.9);
    expect(PESO_ALTRI_ACCOUNT).toBe(1);
    for (const n of [P, N8061, `whatsapp:${P}`, `whatsapp:${N8061}`]) expect(pesoPredefinito(n), n).toBe(0.9);
    for (const n of [N0047, N8718, N2245, N2508, `whatsapp:${N2508}`]) expect(pesoPredefinito(n), n).toBe(1);
  });

  it('un numero non dichiarato su nessun altro account vale come principale: 0,9', () => {
    expect(pesoPredefinito('+393330000000')).toBe(0.9);
  });
});

describe('parsePesiNumeri', () => {
  it('legge la mappa e normalizza le chiavi', () => {
    const p = parsePesiNumeri({ [`whatsapp:${P}`]: 0.8, [N0047]: 1.2 });
    expect(p.get(P)).toBe(0.8);
    expect(p.get(N0047)).toBe(1.2);
  });

  it('accetta i numeri scritti a mano come stringa, col punto o con la virgola', () => {
    const p = parsePesiNumeri({ [P]: '0.85', [N8061]: '0,95', [N0047]: ' 1 ' });
    expect([p.get(P), p.get(N8061), p.get(N0047)]).toEqual([0.85, 0.95, 1]);
  });

  it('valori non validi (<= 0, non numerici, non finiti) si scartano', () => {
    const p = parsePesiNumeri({
      [P]: 0, [N8061]: -0.5, [N0047]: 'tanti', [N8718]: null, [N2245]: Number.NaN, [N2508]: Number.POSITIVE_INFINITY,
      '+391': '', '+392': {}, '+393': [1], '+394': true,
    });
    expect(p.size).toBe(0);
  });

  it('non un oggetto = mappa vuota', () => {
    for (const raw of [null, undefined, 'x', 3, [1, 2], true]) expect(parsePesiNumeri(raw).size).toBe(0);
  });
});

describe('pesoDi', () => {
  it('mappa vuota o assente: il predefinito di ogni numero', () => {
    for (const pesi of [new Map<string, number>(), null, undefined]) {
      expect(pesoDi(pesi, `whatsapp:${P}`)).toBe(0.9);
      expect(pesoDi(pesi, N8061)).toBe(0.9);
      expect(pesoDi(pesi, `whatsapp:${N0047}`)).toBe(1);
    }
  });

  it('mappa parziale: chi c e prende il suo peso, gli altri il predefinito', () => {
    const pesi = parsePesiNumeri({ [N8061]: 1, [N8718]: 0.5 });
    expect(pesoDi(pesi, `whatsapp:${N8061}`)).toBe(1);
    expect(pesoDi(pesi, N8718)).toBe(0.5);
    expect(pesoDi(pesi, P)).toBe(0.9);
    expect(pesoDi(pesi, N0047)).toBe(1);
  });

  it('una voce non valida nella mappa: quel numero torna al predefinito, le altre valgono', () => {
    const pesi = parsePesiNumeri({ [P]: 0, [N8061]: 'boh', [N0047]: -1, [N8718]: 0.7 });
    expect(pesoDi(pesi, P)).toBe(0.9);
    expect(pesoDi(pesi, N8061)).toBe(0.9);
    expect(pesoDi(pesi, N0047)).toBe(1);
    expect(pesoDi(pesi, N8718)).toBe(0.7);
  });
});

describe('caricoPesato', () => {
  it('9 aperture a peso 0,9 e 10 a peso 1 sono pari', () => {
    expect(caricoPesato(9, 0.9)).toBe(caricoPesato(10, 1));
    expect(caricoPesato(18, 0.9)).toBe(caricoPesato(20, 1));
    expect(caricoPesato(0, 0.9)).toBe(caricoPesato(0, 1));
  });

  it('a pari aperture il peso piu basso e piu carico', () => {
    expect(caricoPesato(5, 0.9)).toBeGreaterThan(caricoPesato(5, 1));
  });

  it('i resti della virgola mobile non rompono la parita', () => {
    // 0.1 + 0.2 !== 0.3, e 3 / 0.3 puo' non fare 10 tondo.
    expect(caricoPesato(3, 0.1 + 0.2)).toBe(caricoPesato(10, 1));
    for (let k = 1; k <= 500; k++) expect(caricoPesato(9 * k, 0.9), String(k)).toBe(10 * k);
  });

  it('un peso non valido arrivato fin qui vale 1', () => {
    expect(caricoPesato(7, 0)).toBe(7);
    expect(caricoPesato(7, Number.NaN)).toBe(7);
  });
});

describe('getPesiNumeri', () => {
  const finto = (risposta: { data?: unknown; error?: unknown; lancia?: boolean }) => {
    const chiavi: unknown[] = [];
    const s = {
      from: (t: string) => ({ select: () => ({ eq: (_k: string, v: unknown) => {
        chiavi.push([t, v]);
        return { maybeSingle: async () => {
          if (risposta.lancia) throw new Error('rete giu');
          return { data: risposta.data ?? null, error: risposta.error ?? null };
        } };
      } }) }),
    } as never;
    return { s, chiavi };
  };

  it('legge app_settings.pesi_numeri', async () => {
    const { s, chiavi } = finto({ data: { value: { [P]: 0.8, [`whatsapp:${N0047}`]: 1.1 } } });
    const pesi = await getPesiNumeri(s);
    expect(chiavi).toEqual([['app_settings', 'pesi_numeri']]);
    expect(pesoDi(pesi, P)).toBe(0.8);
    expect(pesoDi(pesi, N0047)).toBe(1.1);
    expect(pesoDi(pesi, N8061)).toBe(0.9);
  });

  it('riga assente: tutti al predefinito', async () => {
    const pesi = await getPesiNumeri(finto({ data: null }).s);
    expect(pesi.size).toBe(0);
    expect(pesoDi(pesi, P)).toBe(0.9);
    expect(pesoDi(pesi, N2245)).toBe(1);
  });

  it('riga malformata (non un oggetto, o piena di valori non validi): tutti al predefinito', async () => {
    for (const value of ['0.9', 5, [0.9, 1], null, { [P]: 'x', [N0047]: 0 }]) {
      const pesi = await getPesiNumeri(finto({ data: { value } }).s);
      expect(pesi.size, JSON.stringify(value)).toBe(0);
      expect(pesoDi(pesi, P)).toBe(0.9);
      expect(pesoDi(pesi, N0047)).toBe(1);
    }
  });

  it('riga parziale: vale per chi c e', async () => {
    const pesi = await getPesiNumeri(finto({ data: { value: { [N8061]: 1 } } }).s);
    expect(pesoDi(pesi, N8061)).toBe(1);
    expect(pesoDi(pesi, P)).toBe(0.9);
  });

  it('errore o eccezione nella lettura: non lancia, tutti al predefinito', async () => {
    expect((await getPesiNumeri(finto({ error: { message: 'boom' } }).s)).size).toBe(0);
    expect((await getPesiNumeri(finto({ lancia: true }).s)).size).toBe(0);
  });
});
