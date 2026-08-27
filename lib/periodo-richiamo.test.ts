import { describe, it, expect } from 'vitest';
import { estraiPeriodo } from './periodo-richiamo';

describe('estraiPeriodo', () => {
  it('prende il mese quando il lead lo nomina', () => {
    expect(estraiPeriodo('Ci risentiamo a settembre che ora sono in ferie')).toBe('a settembre');
    expect(estraiPeriodo('richiamami a ottobre')).toBe('a ottobre');
  });

  it('prende la settimana prossima', () => {
    expect(estraiPeriodo('Guarda, meglio la settimana prossima')).toBe('la settimana prossima');
    expect(estraiPeriodo('Sentiamoci la prossima settimana')).toBe('la prossima settimana');
  });

  it('prende "dopo le ferie" e simili', () => {
    expect(estraiPeriodo('Ne parliamo dopo le ferie')).toBe('dopo le ferie');
    expect(estraiPeriodo('Dopo l\'estate ci risentiamo')).toBe("dopo l'estate");
  });

  it('prende "tra N settimane"', () => {
    expect(estraiPeriodo('Mi richiami tra due settimane per favore')).toBe('tra due settimane');
    expect(estraiPeriodo('fra 10 giorni')).toBe('fra 10 giorni');
  });

  it('prende fine e inizio mese', () => {
    expect(estraiPeriodo('Meglio a fine mese')).toBe('a fine mese');
    expect(estraiPeriodo('Il mese prossimo va bene')).toBe('il mese prossimo');
  });

  it('non inventa niente quando il lead non dice quando', () => {
    expect(estraiPeriodo('Ora non posso')).toBeNull();
    expect(estraiPeriodo('Non mi interessa')).toBeNull();
    expect(estraiPeriodo('')).toBeNull();
    expect(estraiPeriodo(undefined)).toBeNull();
  });

  it('non scambia un orario per un periodo', () => {
    // "alle 15" e' un'ora dentro una giornata che non conosciamo: non e' un periodo.
    expect(estraiPeriodo('Richiamami alle 15')).toBeNull();
  });

  it('normalizza spazi e maiuscole ma resta nelle parole del lead', () => {
    expect(estraiPeriodo('Ci  sentiamo   A   SETTEMBRE')).toBe('a settembre');
  });

  it('quando ci sono piu\' espressioni prende la prima', () => {
    expect(estraiPeriodo('a settembre, o magari la settimana prossima')).toBe('a settembre');
  });

  it('taglia le frasi lunghe invece di far viaggiare un tema', () => {
    const p = estraiPeriodo('tra tre settimane circa');
    expect(p).toBe('tra tre settimane');
    expect((p ?? '').length).toBeLessThanOrEqual(60);
  });
});
