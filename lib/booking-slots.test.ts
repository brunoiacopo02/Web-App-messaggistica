import { describe, it, expect } from 'vitest';
import { computeBookingDays, bookingSlotsContext } from './booking-slots';
import { romeHour } from './rome-time';

describe('computeBookingDays', () => {
  it('lunedì → martedì e mercoledì', () => {
    const { day1, day2 } = computeBookingDays(new Date('2026-06-22T10:00:00+02:00'));
    expect(day1.date).toBe('2026-06-23');
    expect(day2.date).toBe('2026-06-24');
  });

  it('venerdì → sabato e lunedì (salta la domenica)', () => {
    const { day1, day2 } = computeBookingDays(new Date('2026-06-26T10:00:00+02:00'));
    expect(day1.date).toBe('2026-06-27'); // sabato
    expect(day2.date).toBe('2026-06-29'); // lunedì
  });

  it('sabato → lunedì e martedì (salta la domenica)', () => {
    const { day1, day2 } = computeBookingDays(new Date('2026-06-27T10:00:00+02:00'));
    expect(day1.date).toBe('2026-06-29'); // lunedì
    expect(day2.date).toBe('2026-06-30'); // martedì
  });

  it('domenica → lunedì e martedì', () => {
    const { day1, day2 } = computeBookingDays(new Date('2026-06-28T10:00:00+02:00'));
    expect(day1.date).toBe('2026-06-29');
    expect(day2.date).toBe('2026-06-30');
  });
});

describe('romeHour', () => {
  it('ritorna l\'ora locale Europe/Rome (DST estiva +02:00)', () => {
    expect(romeHour(new Date('2026-06-25T17:00:00Z'))).toBe(19);
    expect(romeHour(new Date('2026-06-25T18:00:00Z'))).toBe(20);
  });
});

describe('computeBookingDays rollover 20:00', () => {
  it('prima delle 20:00 NON scivola: giovedì 19:00 → ven e sab', () => {
    const { day1, day2 } = computeBookingDays(new Date('2026-06-25T17:00:00Z')); // Rome 19:00
    expect(day1.date).toBe('2026-06-26'); // venerdì
    expect(day2.date).toBe('2026-06-27'); // sabato
  });

  it('alle 20:00 scivola al giorno dopo: giovedì 20:00 → sab e lun (salta domenica)', () => {
    const { day1, day2 } = computeBookingDays(new Date('2026-06-25T18:00:00Z')); // Rome 20:00
    expect(day1.date).toBe('2026-06-27'); // sabato (anchor spostato a venerdì)
    expect(day2.date).toBe('2026-06-29'); // lunedì (salta domenica 28)
  });

  it('sabato sera dopo le 20 → lun e mar', () => {
    const { day1, day2 } = computeBookingDays(new Date('2026-06-27T18:00:00Z')); // Rome 20:00
    expect(day1.date).toBe('2026-06-29'); // lunedì
    expect(day2.date).toBe('2026-06-30'); // martedì
  });
});

describe('bookingSlotsContext', () => {
  it('riporta le fasce orarie corrette e le date assolute', () => {
    const ctx = bookingSlotsContext(new Date('2026-06-22T10:00:00+02:00'));
    expect(ctx).toContain('dalle 15:00 alle 21:00');
    expect(ctx).toContain('dalle 09:00 alle 21:00');
    expect(ctx).toContain('2026-06-23');
    expect(ctx).toContain('2026-06-24');
    expect(ctx).toContain('La domenica'.toLowerCase());
  });
});

describe('bookingSlotsContext — un giorno alla volta', () => {
  const now = new Date('2026-08-06T10:00:00+02:00');
  const ctx = bookingSlotsContext(now);
  const { day1, day2 } = computeBookingDays(now);

  it('dice di proporre per primo il giorno dopo', () => {
    expect(ctx).toContain('PROPONI SEMPRE PRIMA');
    expect(ctx.indexOf(day1.label)).toBeLessThan(ctx.indexOf(day2.label));
  });

  it('il secondo giorno si nomina solo se il lead non riesce', () => {
    expect(ctx).toMatch(/SOLO se il lead proprio non riesce/i);
    expect(ctx).toMatch(/non nominare l'altro/i);
  });

  it('spiega perché: la call vicina è quella che il lead non salta', () => {
    expect(ctx).toMatch(/più è vicina.*meno/i);
  });

  it('entrambe le date restano legali per il tag', () => {
    expect(ctx).toContain(day1.date);
    expect(ctx).toContain(day2.date);
  });

  it('le fasce orarie non cambiano', () => {
    expect(ctx).toContain('dalle 15:00 alle 21:00');
    expect(ctx).toContain('dalle 09:00 alle 21:00');
  });

  it('la domenica resta esclusa', () => {
    expect(ctx).toContain('la domenica non è mai disponibile');
  });
});
