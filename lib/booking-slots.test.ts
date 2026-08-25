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

// Il giorno di riapertura si riempie da solo: il 18/08/2026 ha raccolto 98 call in una
// giornata sola. Un giorno pieno si salta come si salta una domenica — ma NON è una
// chiusura: al lead non si racconta che siamo chiusi quando siamo solo al completo.
describe('computeBookingDays con giorni al completo', () => {
  const NIENTE_CHIUSURE: { from: string; to: string }[] = [];

  it('senza giorni pieni si comporta come prima', () => {
    const r = computeBookingDays(new Date('2026-06-22T10:00:00+02:00'), NIENTE_CHIUSURE, []);
    expect(r.day1.date).toBe('2026-06-23');
    expect(r.day2.date).toBe('2026-06-24');
  });

  it('salta il primo giorno se è al completo', () => {
    const r = computeBookingDays(new Date('2026-06-22T10:00:00+02:00'), NIENTE_CHIUSURE, ['2026-06-23']);
    expect(r.day1.date).toBe('2026-06-24');
    expect(r.day2.date).toBe('2026-06-25');
  });

  it('salta più giorni pieni di fila', () => {
    const r = computeBookingDays(new Date('2026-06-22T10:00:00+02:00'), NIENTE_CHIUSURE, ['2026-06-23', '2026-06-24', '2026-06-25']);
    expect(r.day1.date).toBe('2026-06-26');
  });

  it('un giorno pieno non viene raccontato come chiusura', () => {
    const r = computeBookingDays(new Date('2026-06-22T10:00:00+02:00'), NIENTE_CHIUSURE, ['2026-06-23']);
    expect(r.chiusuraPrimaDiDay1).toBeNull();
    expect(r.chiusuraDopoDay1).toBeNull();
  });

  it('day1Imminente è falso se domani è al completo: non è più "domani"', () => {
    const r = computeBookingDays(new Date('2026-06-22T10:00:00+02:00'), NIENTE_CHIUSURE, ['2026-06-23']);
    expect(r.day1Imminente).toBe(false);
  });

  it('pieno e chiuso insieme: salta entrambi, e la chiusura resta segnalata', () => {
    const r = computeBookingDays(
      new Date('2026-08-07T10:00:00+02:00'),
      [{ from: '2026-08-11', to: '2026-08-17' }],
      ['2026-08-08'],
    );
    expect(r.day1.date).toBe('2026-08-10'); // 8 pieno, 9 domenica
    expect(r.day2.date).toBe('2026-08-18'); // 11-17 chiuso
    expect(r.chiusuraDopoDay1?.date).toBe('2026-08-17');
  });

  it('se sono pieni tutti i giorni dell\'orizzonte non azzera l\'agenda: torna comunque due giorni', () => {
    const pieni = Array.from({ length: 90 }, (_, i) => {
      const d = new Date(Date.UTC(2026, 5, 23, 12));
      d.setUTCDate(d.getUTCDate() + i);
      return d.toISOString().slice(0, 10);
    });
    const r = computeBookingDays(new Date('2026-06-22T10:00:00+02:00'), NIENTE_CHIUSURE, pieni);
    expect(r.day1.date).toBeTruthy();
    expect(r.day2.date).toBeTruthy();
    expect(r.day1.date).not.toBe(r.day2.date);
  });

  it('bookingSlotsContext usa i giorni liberi, e non dice mai che siamo chiusi', () => {
    const testo = bookingSlotsContext(new Date('2026-06-22T10:00:00+02:00'), {
      ranges: NIENTE_CHIUSURE,
      pieni: ['2026-06-23'],
    });
    expect(testo).toContain('2026-06-24');
    expect(testo).not.toContain('2026-06-23');
    expect(testo.toLowerCase()).not.toContain('chius');
  });
});
