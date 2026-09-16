import { describe, it, expect } from 'vitest';
import {
  leggiTettoOrario,
  sottoTettoOrario,
  TETTO_ORARIO_BENVENUTI_DEFAULT,
  FINESTRA_TETTO_MS,
} from './lancio-tetto';

describe('sottoTettoOrario', () => {
  it('sotto il tetto si manda', () => {
    expect(sottoTettoOrario({ inviatiUltimaOra: 199, cap: 200 })).toBe(true);
  });

  it('al pari del tetto NON si manda: il cap e’ il massimo, non il primo di troppo', () => {
    expect(sottoTettoOrario({ inviatiUltimaOra: 200, cap: 200 })).toBe(false);
  });

  it('oltre il tetto non si manda', () => {
    expect(sottoTettoOrario({ inviatiUltimaOra: 512, cap: 200 })).toBe(false);
  });

  it('ora vuota: si manda', () => {
    expect(sottoTettoOrario({ inviatiUltimaOra: 0, cap: 1 })).toBe(true);
  });
});

describe('leggiTettoOrario', () => {
  it('env assente → default della spec (200)', () => {
    expect(leggiTettoOrario(undefined)).toBe(TETTO_ORARIO_BENVENUTI_DEFAULT);
    expect(TETTO_ORARIO_BENVENUTI_DEFAULT).toBe(200);
  });

  it('env valido → quello', () => {
    expect(leggiTettoOrario('400')).toBe(400);
  });

  it('env spazzatura → default, non NaN (un NaN farebbe passare tutto)', () => {
    for (const spazzatura of ['boh', '', '  ', 'duecento', null]) {
      expect(leggiTettoOrario(spazzatura)).toBe(TETTO_ORARIO_BENVENUTI_DEFAULT);
    }
  });

  it('zero → default: per spegnere i benvenuti c’e’ lancio_attivo, non un tetto a zero', () => {
    expect(leggiTettoOrario('0')).toBe(TETTO_ORARIO_BENVENUTI_DEFAULT);
  });

  it('negativo → 1, mai zero', () => {
    expect(leggiTettoOrario('-50')).toBe(1);
  });

  it('decimale → intero per difetto', () => {
    expect(leggiTettoOrario('250.9')).toBe(250);
  });
});

describe('FINESTRA_TETTO_MS', () => {
  it('sono 60 minuti', () => {
    expect(FINESTRA_TETTO_MS).toBe(60 * 60 * 1000);
  });
});
