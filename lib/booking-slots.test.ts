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

  it('dice che gli slot valgono solo per gli appuntamenti che fissa lui', () => {
    const ctx = bookingSlotsContext(new Date('2026-06-22T10:00:00+02:00'));
    expect(ctx).toContain('appuntamenti che fissi TU');
    expect(ctx).toContain('non correggerlo con questi giorni');
  });

  it("l'ambito c'è anche nelle due forme della chiusura", () => {
    const primaDellaChiusura = bookingSlotsContext(new Date('2026-08-08T10:00:00+02:00'));
    const dentroLaChiusura = bookingSlotsContext(new Date('2026-08-12T10:00:00+02:00'));
    for (const ctx of [primaDellaChiusura, dentroLaChiusura]) {
      expect(ctx).toContain('appuntamenti che fissi TU');
      expect(ctx).toContain('non correggerlo con questi giorni');
    }
  });
});

// Chiusura ferragosto 2026: 11-17 agosto compresi, si riapre martedì 18.
describe('computeBookingDays con giorni chiusi', () => {
  it('venerdì 7 dopo le 20 → lunedì 10, poi si salta al 18', () => {
    const r = computeBookingDays(new Date('2026-08-07T18:00:00Z')); // Rome 20:00
    expect(r.day1.date).toBe('2026-08-10');
    expect(r.day2.date).toBe('2026-08-18');
  });

  it('sabato 8 → lunedì 10 e martedì 18', () => {
    const r = computeBookingDays(new Date('2026-08-08T10:00:00+02:00'));
    expect(r.day1.date).toBe('2026-08-10');
    expect(r.day2.date).toBe('2026-08-18');
  });

  it('domenica 9 → lunedì 10 e martedì 18', () => {
    const r = computeBookingDays(new Date('2026-08-09T10:00:00+02:00'));
    expect(r.day1.date).toBe('2026-08-10');
    expect(r.day2.date).toBe('2026-08-18');
  });

  it('sabato 8: la chiusura cade DOPO day1 e finisce lunedì 17', () => {
    const r = computeBookingDays(new Date('2026-08-08T10:00:00+02:00'));
    expect(r.chiusuraDopoDay1?.date).toBe('2026-08-17');
    expect(r.chiusuraPrimaDiDay1).toBeNull();
  });

  it('lunedì 10 di giorno → non propone più martedì 11, va al 18 e 19', () => {
    const r = computeBookingDays(new Date('2026-08-10T10:00:00+02:00'));
    expect(r.day1.date).toBe('2026-08-18');
    expect(r.day2.date).toBe('2026-08-19');
  });

  it('mercoledì 12, dentro la chiusura: la chiusura è PRIMA di day1', () => {
    const r = computeBookingDays(new Date('2026-08-12T10:00:00+02:00'));
    expect(r.day1.date).toBe('2026-08-18');
    expect(r.day2.date).toBe('2026-08-19');
    expect(r.chiusuraPrimaDiDay1?.date).toBe('2026-08-17');
    expect(r.chiusuraDopoDay1).toBeNull();
  });

  it('venerdì 14, dentro la chiusura → 18 e 19', () => {
    const r = computeBookingDays(new Date('2026-08-14T10:00:00+02:00'));
    expect(r.day1.date).toBe('2026-08-18');
    expect(r.day2.date).toBe('2026-08-19');
  });

  it('lunedì 17 → martedì 18 imminente, nessuna chiusura da annunciare', () => {
    const r = computeBookingDays(new Date('2026-08-17T10:00:00+02:00'));
    expect(r.day1.date).toBe('2026-08-18');
    expect(r.day2.date).toBe('2026-08-19');
    expect(r.day1Imminente).toBe(true);
    expect(r.chiusuraPrimaDiDay1).toBeNull();
    expect(r.chiusuraDopoDay1).toBeNull();
  });

  it('martedì 18, chiusura passata → si torna al comportamento normale', () => {
    const r = computeBookingDays(new Date('2026-08-18T10:00:00+02:00'));
    expect(r.day1.date).toBe('2026-08-19');
    expect(r.day2.date).toBe('2026-08-20');
    expect(r.chiusuraPrimaDiDay1).toBeNull();
    expect(r.chiusuraDopoDay1).toBeNull();
  });

  it('senza giorni chiusi il calcolo resta quello di sempre', () => {
    const r = computeBookingDays(new Date('2026-08-10T10:00:00+02:00'), []);
    expect(r.day1.date).toBe('2026-08-11');
    expect(r.day2.date).toBe('2026-08-12');
  });

  it('day1Imminente è falso quando per arrivarci si è saltato qualcosa', () => {
    const sab = computeBookingDays(new Date('2026-08-08T10:00:00+02:00'));
    expect(sab.day1Imminente).toBe(false); // sabato → lunedì, domenica saltata
    const lun = computeBookingDays(new Date('2026-06-22T10:00:00+02:00'));
    expect(lun.day1Imminente).toBe(true); // lunedì → martedì, nessun salto
  });

  it('una configurazione assurda non impedisce di fissare per sempre', () => {
    const r = computeBookingDays(new Date('2026-08-10T10:00:00+02:00'), [
      { from: '2026-01-01', to: '2027-12-31' },
    ]);
    expect(r.day1.date).toBe('2026-08-11');
    expect(r.day2.date).toBe('2026-08-12');
  });
});

describe('bookingSlotsContext durante la chiusura', () => {
  it('sabato 8: propone SOLO lunedì 10, il 18 resta un ripiego', () => {
    const ctx = bookingSlotsContext(new Date('2026-08-08T10:00:00+02:00'));
    expect(ctx).toContain('CHIUSURA');
    expect(ctx).toContain('2026-08-10');
    expect(ctx).toContain('Proponi SOLO');
    expect(ctx).toContain('Solo se il lead dice che non può');
    expect(ctx).toContain('lunedì 17/08/2026');
  });

  it('sabato 8: lunedì 10 ha la giornata intera, non solo il pomeriggio', () => {
    const ctx = bookingSlotsContext(new Date('2026-08-08T10:00:00+02:00'));
    expect(ctx).toContain('dalle 09:00 alle 21:00');
    expect(ctx).not.toContain('dalle 15:00 alle 21:00');
  });

  it('mercoledì 12: elenca 18 e 19 e dice da quando si riparte', () => {
    const ctx = bookingSlotsContext(new Date('2026-08-12T10:00:00+02:00'));
    expect(ctx).toContain('CHIUSURA');
    expect(ctx).toContain('2026-08-18');
    expect(ctx).toContain('2026-08-19');
    expect(ctx).toContain('lunedì 17/08/2026');
    expect(ctx).not.toContain('Proponi SOLO');
  });

  it('fuori dalla chiusura il testo non la nomina', () => {
    const ctx = bookingSlotsContext(new Date('2026-06-22T10:00:00+02:00'));
    expect(ctx).not.toContain('CHIUSURA');
  });
});
