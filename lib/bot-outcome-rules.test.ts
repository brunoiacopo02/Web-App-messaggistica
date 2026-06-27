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

  it('APPUNTAMENTO corrente + qualsiasi esito → locked con data originale', () => {
    const a = resolveOutcomeAction('APPUNTAMENTO', { outcome: 'DA_SCARTARE', discardReason: 'la madre non paga' }, DATE);
    expect(a.kind).toBe('locked');
    if (a.kind === 'locked') {
      expect(a.date).toBe(DATE);
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
  it('SCARTO → motivo annullamento', () => {
    expect(buildLockedNote({ outcome: 'DA_SCARTARE', discardReason: 'no budget' }, DATE))
      .toContain('no budget');
  });
  it('INTERROTTO → nota interruzione, appuntamento mantenuto', () => {
    expect(buildLockedNote({ outcome: 'INTERROTTO' }, DATE).toLowerCase())
      .toContain('interrotta');
  });
  it('RICHIAMO → appuntamento mantenuto', () => {
    expect(buildLockedNote({ outcome: 'RICHIAMO', date: DATE }, DATE).toLowerCase())
      .toContain('mantenuto');
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
