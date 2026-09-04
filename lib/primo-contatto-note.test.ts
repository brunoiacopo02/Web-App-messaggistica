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

// I 29 recuperati da adotta-mai-risposti: il riaggancio e' il loro primo contatto in
// assoluto e non dichiara l'IA. Se contasse come "gia' parlato", alla prima risposta
// libera la nota sparirebbe e non si dichiarerebbe nessuno (AI Act art. 50).
describe('notaPrimoContatto — il riaggancio non conta come nostro messaggio', () => {
  const env = { MARTA_REENGAGE_TEMPLATE_SID: 'HX_REENGAGE' } as unknown as NodeJS.ProcessEnv;

  it('solo il riaggancio in uscita → la nota c\'è ancora', () => {
    const rows = [
      { direction: 'in', template_sid: null },
      { direction: 'out', template_sid: 'HX_REENGAGE' },
      { direction: 'in', template_sid: null },
    ];
    expect(notaPrimoContatto(rows, env)).toBe(NOTA_PRIMO_CONTATTO);
  });

  it('riaggancio più una risposta libera → la nota non c\'è più', () => {
    const rows = [
      { direction: 'out', template_sid: 'HX_REENGAGE' },
      { direction: 'in', template_sid: null },
      { direction: 'out', template_sid: null },
      { direction: 'in', template_sid: null },
    ];
    expect(notaPrimoContatto(rows, env)).toBeUndefined();
  });

  it('un altro template in uscita conta eccome: quelli l\'IA la dichiarano', () => {
    expect(notaPrimoContatto([{ direction: 'out', template_sid: 'HX_APERTURA' }], env)).toBeUndefined();
  });

  it('senza env del riaggancio il comportamento è quello di prima', () => {
    const rows = [{ direction: 'out', template_sid: 'HX_REENGAGE' }];
    expect(notaPrimoContatto(rows, {} as NodeJS.ProcessEnv)).toBeUndefined();
  });
});
