import { describe, it, expect } from 'vitest';
import { confermaVideoVisto } from './video-visto';

describe('confermaVideoVisto', () => {
  it('riconosce le conferme secche', () => {
    for (const t of ['FATTO', 'fatto', 'fatto!', 'visto', 'l\'ho visto', 'guardato', 'l\'ho guardato tutto', 'video visto', 'ho finito di vederlo', 'fatto tutto grazie']) {
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
    ]) {
      expect(confermaVideoVisto(t)).toBe(false);
    }
  });

  it('non scambia altro per una conferma', () => {
    for (const t of ['ok', 'grazie', 'ma quanto dura?', 'ho fatto un altro corso', '']) {
      expect(confermaVideoVisto(t)).toBe(false);
    }
  });

  it('regge null e undefined', () => {
    expect(confermaVideoVisto(null)).toBe(false);
    expect(confermaVideoVisto(undefined)).toBe(false);
  });
});
