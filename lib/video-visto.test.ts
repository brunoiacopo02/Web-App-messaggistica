import { describe, it, expect } from 'vitest';
import { confermaVideoVisto } from './video-visto';

describe('confermaVideoVisto', () => {
  it('riconosce le conferme secche', () => {
    for (const t of ['FATTO', 'fatto', 'fatto!', 'visto', 'l\'ho visto', 'guardato', 'l\'ho guardato tutto', 'video visto', 'ho finito di vederlo', 'fatto tutto grazie', 'visto ieri sera']) {
      expect(confermaVideoVisto(t)).toBe(true);
    }
  });

  it('non scambia una promessa per una conferma', () => {
    for (const t of [
      'non l\'ho ancora visto',
      'devo ancora guardarlo',
      'lo guardo stasera',
      'lo vedo domani',
      'appena posso lo guardo',
      'quando lo devo vedere?',
      'non ho fatto in tempo',
      // fix round 1: "sarà"/"sara" è un futuro ("lo farò"), non una conferma.
      'sarà fatto',
      'ok sara fatto',
      'quasi fatto',
    ]) {
      expect(confermaVideoVisto(t)).toBe(false);
    }
  });

  it('non scambia altro per una conferma', () => {
    for (const t of ['ok', 'grazie', 'ma quanto dura?', 'ho fatto un altro corso', '']) {
      expect(confermaVideoVisto(t)).toBe(false);
    }
  });

  it('"visto che" è il connettivo causale, non la conferma del video', () => {
    for (const t of [
      'visto che sei stato bravo, buon lavoro',
      'visto che ci sentiamo la prossima settimana ti mando due info',
    ]) {
      expect(confermaVideoVisto(t)).toBe(false);
    }
  });

  it('una visione dichiarata parziale non è un "fatto"', () => {
    for (const t of [
      'video visto solo a metà',
      "visto solo l'inizio",
      'ho guardato solo i primi 5 minuti',
      "l'ho quasi finito di guardare",
      'quasi visto tutto',
    ]) {
      expect(confermaVideoVisto(t)).toBe(false);
    }
  });

  it('regge null e undefined', () => {
    expect(confermaVideoVisto(null)).toBe(false);
    expect(confermaVideoVisto(undefined)).toBe(false);
  });
});
