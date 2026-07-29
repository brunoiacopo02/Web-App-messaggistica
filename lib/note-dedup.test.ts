import { describe, it, expect } from 'vitest';
import { noteFingerprint } from './note-dedup';

describe('noteFingerprint: due note equivalenti hanno la stessa impronta', () => {
  it('ignora spazi doppi e spazi ai bordi', () => {
    expect(noteFingerprint('  Il lead  vuole annullare ')).toBe(noteFingerprint('Il lead vuole annullare'));
  });

  it('ignora le differenze di maiuscole', () => {
    expect(noteFingerprint('Il Lead Vuole Annullare')).toBe(noteFingerprint('il lead vuole annullare'));
  });

  it('distingue note con contenuto diverso', () => {
    const a = noteFingerprint('Il lead ha chiesto di spostare a martedì 28 luglio alle 17:00.');
    const b = noteFingerprint('Il lead ha chiesto di spostare a martedì 28 luglio alle 15:00.');
    expect(a).not.toBe(b);
  });

  it('e stabile fra chiamate diverse', () => {
    const n = 'Il lead vuole annullare l\'appuntamento (fissato per lunedì 27 luglio alle 13:00).';
    expect(noteFingerprint(n)).toBe(noteFingerprint(n));
  });

  it('gestisce la nota vuota senza esplodere', () => {
    expect(typeof noteFingerprint('')).toBe('string');
  });
});
