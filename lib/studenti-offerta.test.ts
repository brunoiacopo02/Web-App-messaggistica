import { describe, it, expect } from 'vitest';
import { chatStudenteFerma, eStudenteOfferta, HANDOFF_STUDENTI, STUDENTI_CONTEXT_NOTE } from './studenti-offerta';

describe('studenti lista 135', () => {
  it('la chat ferma è solo quella col motivo studenti', () => {
    expect(chatStudenteFerma({ handed_off_reason: HANDOFF_STUDENTI })).toBe(true);
    expect(chatStudenteFerma({ handed_off_reason: 'lancio_pool_vergini' })).toBe(false);
    expect(chatStudenteFerma({ handed_off_reason: null })).toBe(false);
  });
  it('il segno sta in lancio_info.studente_offerta', () => {
    expect(eStudenteOfferta({ studente_offerta: { at: '2026-10-10' } })).toBe(true);
    expect(eStudenteOfferta({})).toBe(false);
    expect(eStudenteOfferta(null)).toBe(false);
  });
  it('la nota non dà dettagli dell\'offerta e tiene il video dopo la call', () => {
    expect(STUDENTI_CONTEXT_NOTE).toContain('Sviluppatore Web AI');
    expect(STUDENTI_CONTEXT_NOTE).toContain('NON dire come funziona, quando scade né perché');
    expect(STUDENTI_CONTEXT_NOTE).toContain('SOLO dopo che ha fissato la call');
  });
});
