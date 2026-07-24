import { describe, it, expect } from 'vitest';
import { buildMarioSystem, MARIO_SYSTEM_PROMPT } from './mario-prompt';

describe('buildMarioSystem', () => {
  it('con "Marta" presenta la persona Marta e non contiene mai "Mario"', () => {
    const p = buildMarioSystem('Marta');
    expect(p).toContain('Sei Marta, consulente di Fenice Academy');
    expect(p).toContain('Presentati come Marta di Fenice Academy');
    expect(p).not.toContain('Mario');
  });

  it('con "Mario" produce esattamente il prompt storico (default invariato)', () => {
    const p = buildMarioSystem('Mario');
    expect(p).toBe(MARIO_SYSTEM_PROMPT);
    expect(p).toContain('Sei Mario, consulente di Fenice Academy');
    expect(p).toContain('Presentati come Mario di Fenice Academy');
  });

  it('cambia SOLO il nome: i due prompt differiscono solo per Mario/Marta', () => {
    const marta = buildMarioSystem('Marta');
    const mario = buildMarioSystem('Mario');
    expect(marta.replace(/Marta/g, 'Mario')).toBe(mario);
  });
});
