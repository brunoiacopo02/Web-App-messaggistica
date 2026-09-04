import { describe, it, expect } from 'vitest';
import { notaPrimoContatto, NOTA_PRIMO_CONTATTO } from './primo-contatto-note';

describe('notaPrimoContatto', () => {
  it('c\'è quando il lead ha scritto e noi non ancora', () => {
    expect(notaPrimoContatto([{ direction: 'in' }])).toBe(NOTA_PRIMO_CONTATTO);
  });
  it('non c\'è appena abbiamo risposto una volta', () => {
    expect(notaPrimoContatto([{ direction: 'in' }, { direction: 'out' }, { direction: 'in' }]))
      .toBeUndefined();
  });
  it('non c\'è su una chat aperta da un nostro template', () => {
    expect(notaPrimoContatto([{ direction: 'out' }, { direction: 'in' }])).toBeUndefined();
  });
  it('la nota dice di presentarsi come assistente digitale', () => {
    expect(NOTA_PRIMO_CONTATTO).toContain('assistente digitale di Fenice Academy');
  });
});
