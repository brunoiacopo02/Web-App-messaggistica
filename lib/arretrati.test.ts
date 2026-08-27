import { describe, it, expect } from 'vitest';
import { buildEsitoRifiutatoNote } from './arretrati';

describe('buildEsitoRifiutatoNote', () => {
  const base = { outcome: 'DA_SCARTARE', quandoIso: '2026-08-10T14:30:00+02:00' };

  it('dice cosa aveva concluso il bot e quando', () => {
    const n = buildEsitoRifiutatoNote(base);
    expect(n).toContain('ESITO CHE NON VI ERA ARRIVATO');
    expect(n).toContain('chiuso come da scartare');
    expect(n).toContain('10 agosto');
  });

  it('non chiede al CRM di cambiare niente: il lead e\' tornato loro', () => {
    const n = buildEsitoRifiutatoNote(base);
    expect(n).toContain('il lead resta vostro');
  });

  it('porta motivo e parole del lead quando ci sono', () => {
    const n = buildEsitoRifiutatoNote({ ...base, discardReason: 'non interessato', leadWords: 'no grazie' });
    expect(n).toContain('Motivo: non interessato.');
    expect(n).toContain('"no grazie"');
  });

  it('senza motivo ne\' parole resta una nota pulita', () => {
    const n = buildEsitoRifiutatoNote(base);
    expect(n).not.toContain('Motivo:');
    expect(n).not.toContain('Parole del lead');
  });

  it('taglia le parole lunghissime invece di spedire mezza chat', () => {
    const n = buildEsitoRifiutatoNote({ ...base, leadWords: 'a'.repeat(900) });
    expect(n.length).toBeLessThan(700);
  });

  it('un esito che non conosciamo non fa saltare la nota', () => {
    expect(buildEsitoRifiutatoNote({ ...base, outcome: 'BOH' })).toContain("l'esito BOH");
  });
});
