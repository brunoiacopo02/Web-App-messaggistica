import { describe, it, expect } from 'vitest';
import {
  BLACKOUT_DEFAULT,
  parseBlackout,
  bookingBlackout,
  isBookableDate,
} from './booking-blackout';

describe('parseBlackout', () => {
  it('env assente → null (vale il default)', () => {
    expect(parseBlackout(undefined)).toBeNull();
  });

  it('stringa vuota → nessun intervallo chiuso (interruttore di spegnimento)', () => {
    expect(parseBlackout('')).toEqual([]);
  });

  it('solo spazi → nessun intervallo chiuso', () => {
    expect(parseBlackout('   ')).toEqual([]);
  });

  it('un intervallo valido', () => {
    expect(parseBlackout('2026-08-11:2026-08-17')).toEqual([
      { from: '2026-08-11', to: '2026-08-17' },
    ]);
  });

  it('più intervalli separati da virgola', () => {
    expect(parseBlackout('2026-08-11:2026-08-17, 2026-12-24:2026-12-26')).toEqual([
      { from: '2026-08-11', to: '2026-08-17' },
      { from: '2026-12-24', to: '2026-12-26' },
    ]);
  });

  it('from dopo to → null, non ci si fida di una env sbagliata', () => {
    expect(parseBlackout('2026-08-17:2026-08-11')).toBeNull();
  });

  it('testo qualsiasi → null', () => {
    expect(parseBlackout('ciao')).toBeNull();
  });

  it('data inesistente → null', () => {
    expect(parseBlackout('2026-13-45:2026-08-17')).toBeNull();
  });

  it('un intervallo sporco invalida tutto, non solo se stesso', () => {
    expect(parseBlackout('2026-08-11:2026-08-17,rotto')).toBeNull();
  });
});

describe('bookingBlackout', () => {
  it('senza env vale il default 11-17 agosto', () => {
    expect(bookingBlackout(undefined)).toEqual(BLACKOUT_DEFAULT);
  });

  it('env sporca → si torna al default invece di lasciar passare tutto', () => {
    expect(bookingBlackout('ciao')).toEqual(BLACKOUT_DEFAULT);
  });

  it('env vuota → blocco disattivato', () => {
    expect(bookingBlackout('')).toEqual([]);
  });

  it('env valida → vince sulla costante', () => {
    expect(bookingBlackout('2026-08-11:2026-08-20')).toEqual([
      { from: '2026-08-11', to: '2026-08-20' },
    ]);
  });
});

describe('isBookableDate', () => {
  const ranges = BLACKOUT_DEFAULT;

  it('lunedì 10 agosto è ancora prenotabile', () => {
    expect(isBookableDate('2026-08-10', ranges)).toBe(true);
  });

  it('martedì 11 agosto è chiuso (primo giorno della finestra)', () => {
    expect(isBookableDate('2026-08-11', ranges)).toBe(false);
  });

  it('venerdì 14 agosto è chiuso', () => {
    expect(isBookableDate('2026-08-14', ranges)).toBe(false);
  });

  it('lunedì 17 agosto è chiuso (ultimo giorno della finestra)', () => {
    expect(isBookableDate('2026-08-17', ranges)).toBe(false);
  });

  it('martedì 18 agosto si riapre', () => {
    expect(isBookableDate('2026-08-18', ranges)).toBe(true);
  });

  it('senza intervalli tutto è prenotabile', () => {
    expect(isBookableDate('2026-08-14', [])).toBe(true);
  });
});
