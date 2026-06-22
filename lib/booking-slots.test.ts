import { describe, it, expect } from 'vitest';
import { computeBookingDays, bookingSlotsContext } from './booking-slots';

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

  it('tarda sera resta sul giorno di Roma, non scivola a quello dopo', () => {
    const { day1 } = computeBookingDays(new Date('2026-06-22T23:30:00+02:00'));
    expect(day1.date).toBe('2026-06-23');
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
