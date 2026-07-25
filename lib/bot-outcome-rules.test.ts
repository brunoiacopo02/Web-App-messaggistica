import { describe, it, expect } from 'vitest';
import { resolveOutcomeAction, buildLockedNote } from './bot-outcome-rules';

const DATE = '2026-06-29T17:00:00Z';

describe('resolveOutcomeAction', () => {
  it('non-APPUNTAMENTO corrente → normal', () => {
    expect(resolveOutcomeAction(null, { outcome: 'DA_SCARTARE' }, null))
      .toEqual({ kind: 'normal' });
    expect(resolveOutcomeAction('RICHIAMO', { outcome: 'APPUNTAMENTO', date: DATE }, null).kind)
      .toBe('normal');
  });

  it('APPUNTAMENTO corrente + qualsiasi esito → locked con NOTA, data sempre null (la data originale resta nel testo della nota)', () => {
    const a = resolveOutcomeAction('APPUNTAMENTO', { outcome: 'DA_SCARTARE', discardReason: 'la madre non paga' }, DATE);
    expect(a.kind).toBe('locked');
    if (a.kind === 'locked') {
      expect(a.outcome).toBe('NOTA');
      expect(a.date).toBeNull();
      expect(a.note).toContain('annullare');
      expect(a.note).toContain('la madre non paga');
    }
  });

  it('APPUNTAMENTO corrente senza data originale → locked con date null', () => {
    const a = resolveOutcomeAction('APPUNTAMENTO', { outcome: 'INTERROTTO' }, null);
    expect(a).toMatchObject({ kind: 'locked', date: null });
  });
});

describe('buildLockedNote', () => {
  it('SCARTO → motivo annullamento e data dell\'appuntamento originale (unico modo per le Conferme di sapere quale appuntamento è in gioco, ora che la data non è più inviata al CRM)', () => {
    const n = buildLockedNote({ outcome: 'DA_SCARTARE', discardReason: 'no budget' }, DATE);
    expect(n).toContain('no budget');
    expect(n).toContain(DATE);
  });
  it('INTERROTTO → nota interruzione, appuntamento mantenuto', () => {
    expect(buildLockedNote({ outcome: 'INTERROTTO' }, DATE).toLowerCase())
      .toContain('interrotta');
  });
  it('APPUNTAMENTO stessa data → riconferma', () => {
    expect(buildLockedNote({ outcome: 'APPUNTAMENTO', date: DATE }, DATE).toLowerCase())
      .toContain('riconfermato');
  });
  it('APPUNTAMENTO data diversa → richiesta di spostamento, originale mantenuto', () => {
    const n = buildLockedNote({ outcome: 'APPUNTAMENTO', date: '2026-07-01T10:00:00Z' }, DATE);
    expect(n).toContain('spostare');
    expect(n).toContain(DATE);
  });
});

// RICHIAMO ora significa "il lead vuole spostare l'appuntamento già fissato" (non più
// "vuole essere richiamato"): la nota letta dalle Conferme deve dirlo esplicitamente,
// riportare la data indicata dal lead SOLO se ne ha data una davvero, e indicare in
// ogni caso la data che resta in agenda (unico posto dove sopravvive, ora che il campo
// data non viene più inviato al CRM).
describe('buildLockedNote — RICHIAMO (richiesta di spostamento)', () => {
  it('con una data indicata dal lead diversa da quella fissata → dice chiaramente "spostare", riporta la data indicata e quella in agenda', () => {
    const n = buildLockedNote({ outcome: 'RICHIAMO', date: '2026-07-01T10:00:00Z' }, DATE);
    expect(n).toContain('spostare');
    expect(n).toContain('2026-07-01T10:00:00Z');
    expect(n).toContain(DATE);
    expect(n.toLowerCase()).toContain('mantenuto');
  });

  it('senza data indicata dal lead → dice "spostare" ma non inventa una data, riporta solo quella in agenda', () => {
    const n = buildLockedNote({ outcome: 'RICHIAMO' }, DATE);
    expect(n).toContain('spostare');
    expect(n).toContain(DATE);
    // Una sola occorrenza della data: quella in agenda, non una finta "data indicata".
    expect(n.split(DATE).length - 1).toBe(1);
  });

  it('quando il tag riporta la stessa data dell\'appuntamento (il prompt la usa come fallback quando il lead non ne dà una) → NON la presenta come data indicata dal lead, resta solo la data in agenda una volta sola', () => {
    const n = buildLockedNote({ outcome: 'RICHIAMO', date: DATE }, DATE);
    expect(n).toContain('spostare');
    expect(n.split(DATE).length - 1).toBe(1);
  });
});
