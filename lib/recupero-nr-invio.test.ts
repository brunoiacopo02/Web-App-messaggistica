import { describe, it, expect } from 'vitest';
import { dentroFinestra, quandoLeggibile, notaRecuperoNr } from './recupero-nr-invio';

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
