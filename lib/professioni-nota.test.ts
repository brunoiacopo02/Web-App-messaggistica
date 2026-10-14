import { describe, it, expect } from 'vitest';
import { professioniContextNote, schedaDaInviare } from './professioni-nota';

describe('professioniContextNote', () => {
  it('nomina il corso, la regola della scheda dopo l\'appuntamento e il tag', () => {
    const n = professioniContextNote('video_editor');
    expect(n).toContain('Video Editor');
    expect(n).toContain('[SCHEDA:video_editor]');
    expect(n).toMatch(/dopo/i);
  });
  it('senza corso chiede quale e mostra gli slug', () => {
    expect(professioniContextNote(null)).toContain('social_media_manager');
  });
});

describe('schedaDaInviare', () => {
  const base = { professione: 'copywriter', schedaInviataAt: null, appuntamentoConVideoOra: false };
  it('tag del modello → pre_appuntamento', () => {
    expect(schedaDaInviare({ ...base, schedaRichiesta: 'copywriter' })).toEqual({ slug: 'copywriter', momento: 'pre_appuntamento' });
  });
  it('video dell\'appuntamento uscito ora → post_appuntamento', () => {
    expect(schedaDaInviare({ ...base, appuntamentoConVideoOra: true })).toEqual({ slug: 'copywriter', momento: 'post_appuntamento' });
  });
  it('gia\' inviata → null', () => {
    expect(schedaDaInviare({ ...base, schedaInviataAt: '2026-10-14T10:00:00Z', appuntamentoConVideoOra: true })).toBeNull();
  });
  it('lead normale senza professione → null anche con appuntamento', () => {
    expect(schedaDaInviare({ ...base, professione: null, appuntamentoConVideoOra: true })).toBeNull();
  });
  it('professione salvata non valida → null', () => {
    expect(schedaDaInviare({ ...base, professione: 'boh', appuntamentoConVideoOra: true })).toBeNull();
  });
});
