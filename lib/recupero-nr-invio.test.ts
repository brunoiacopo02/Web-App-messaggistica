import { describe, it, expect } from 'vitest';
import {
  dentroFinestra, quandoLeggibile, notaRecuperoNr,
  controllaAppointmentAt, TURNO_RIPRESA_RECUPERO_NR, SCARTO_DATE_TOLLERATO_MS,
} from './recupero-nr-invio';

const H = 3600_000;
const NOW = Date.parse('2026-08-28T12:00:00+02:00');
/** Ultimo messaggio del lead: le due prove sul confine si costruiscono da qui. */
const iso = (msPrima: number) => new Date(NOW - msPrima).toISOString();

describe('dentroFinestra', () => {
  it('lead che non ha mai scritto: fuori, non c\'è nessuna finestra aperta', () => {
    expect(dentroFinestra(null, NOW)).toBe(false);
  });

  it('a 23h59m dall\'ultimo messaggio del lead: dentro', () => {
    expect(dentroFinestra(iso(23 * H + 59 * 60_000), NOW)).toBe(true);
  });

  it('a 24h01m dall\'ultimo messaggio del lead: fuori', () => {
    expect(dentroFinestra(iso(24 * H + 60_000), NOW)).toBe(false);
  });

  it('messaggio di un minuto fa: dentro', () => {
    expect(dentroFinestra(iso(60_000), NOW)).toBe(true);
  });

  it('data non parsabile: fuori — si va di template, che parte comunque', () => {
    expect(dentroFinestra('non-una-data', NOW)).toBe(false);
  });
});

describe('quandoLeggibile', () => {
  it('rende giorno e ora in italiano, nel fuso di Roma', () => {
    expect(quandoLeggibile('2026-08-29T15:00:00+02:00')).toBe('sabato 29 agosto alle 15:00');
  });

  it('un timestamptz in UTC diventa l\'ora italiana, non quella di Greenwich', () => {
    expect(quandoLeggibile('2026-08-29T13:00:00Z')).toBe('sabato 29 agosto alle 15:00');
  });
});

describe('notaRecuperoNr', () => {
  const QUANDO = 'sabato 29 agosto alle 15:00';

  it('dice al modello cosa è successo e cosa deve chiedere', () => {
    const n = notaRecuperoNr(QUANDO, 1);
    expect(n).toContain(QUANDO);
    expect(n).toMatch(/chiamat/i);       // gli hanno appena telefonato
    expect(n).toMatch(/Noemi/);          // chi lo richiama
    expect(n).toMatch(/richiam/i);       // quando gli va bene essere richiamato
  });

  it('al terzo tentativo mette in chiaro che senza risposta si annulla', () => {
    const n = notaRecuperoNr(QUANDO, 3);
    expect(n).toMatch(/terz/i);
    expect(n).toMatch(/annull/i);
  });

  it('al primo tentativo non minaccia l\'annullamento', () => {
    expect(notaRecuperoNr(QUANDO, 1)).not.toMatch(/annull/i);
  });

  it('non usa mai la parola "disturbo": non si scusa di esistere', () => {
    expect(notaRecuperoNr(QUANDO, 1)).not.toMatch(/disturb/i);
    expect(notaRecuperoNr(QUANDO, 3)).not.toMatch(/disturb/i);
  });

  it('vieta di spostare l\'appuntamento: la data è quella, e resta quella', () => {
    for (const t of [1, 3]) {
      const n = notaRecuperoNr(QUANDO, t);
      expect(n).toMatch(/non (cambiare|spostare|proporre)/i);
    }
  });
});

describe('controllaAppointmentAt', () => {
  const NOSTRO = Date.parse('2026-08-29T15:00:00+02:00');

  it('stessa data del CRM e nostra: passa, nessuna incoerenza', () => {
    const r = controllaAppointmentAt('2026-08-29T15:00:00+02:00', NOSTRO, NOW);
    expect(r).toEqual({ ok: true, scartoMs: 0, incoerente: false });
  });

  it('appuntamento gia passato: si rifiuta, e il motivo si legge', () => {
    // Confermare una call di ieri e peggio del silenzio: il lead capisce che il
    // sistema non sa cosa sta dicendo.
    const r = controllaAppointmentAt('2026-08-27T15:00:00+02:00', NOSTRO, NOW);
    expect(r).toEqual({ ok: false, motivo: 'appuntamento_gia_passato' });
  });

  it('data illeggibile: si rifiuta invece di scrivere una data a caso', () => {
    const r = controllaAppointmentAt('non-una-data', NOSTRO, NOW);
    expect(r).toEqual({ ok: false, motivo: 'appointment_at_illeggibile' });
  });

  it('slot spostato di un ora: passa e non e incoerente, la loro e la fonte di verita', () => {
    const r = controllaAppointmentAt('2026-08-29T16:00:00+02:00', NOSTRO, NOW);
    expect(r).toMatchObject({ ok: true, incoerente: false });
  });

  it('un giorno di scarto: si manda comunque, ma resta scritto', () => {
    const r = controllaAppointmentAt('2026-08-30T15:00:00+02:00', NOSTRO, NOW);
    expect(r).toMatchObject({ ok: true, incoerente: true });
    expect((r as { scartoMs: number }).scartoMs).toBeGreaterThan(SCARTO_DATE_TOLLERATO_MS);
  });

  it('non abbiamo nessuna data nostra: niente con cui confrontarsi, niente allarme', () => {
    // I lead che il CRM ci manda senza che noi abbiamo mai visto l'appuntamento: il
    // confronto non si puo fare, e inventarsi un allarme sarebbe rumore.
    const r = controllaAppointmentAt('2026-08-30T15:00:00+02:00', null, NOW);
    expect(r).toEqual({ ok: true, scartoMs: null, incoerente: false });
  });
});

describe('TURNO_RIPRESA_RECUPERO_NR', () => {
  it('si dichiara nota di sistema: il modello non deve scambiarlo per il lead', () => {
    expect(TURNO_RIPRESA_RECUPERO_NR).toMatch(/nota di sistema/);
    expect(TURNO_RIPRESA_RECUPERO_NR).toMatch(/non . un messaggio del lead/);
  });

  it('dice il motivo vero della ripresa: la telefonata a vuoto, non il silenzio', () => {
    expect(TURNO_RIPRESA_RECUPERO_NR).toMatch(/telefon/i);
  });
});
