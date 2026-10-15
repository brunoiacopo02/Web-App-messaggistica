import { describe, it, expect } from 'vitest';
import { professioniContextNote, professioniVince, schedaDaInviare } from './professioni-nota';

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

describe('professioniVince (PO 15/10/2026, conv 3292)', () => {
  const NOW = Date.parse('2026-10-15T12:00:00Z');
  const base = {
    professione: 'copywriter' as string | null, crmFunnel: null as string | null,
    lancioSlug: null as string | null, lancioFase: null as string | null,
    gdoAgendaAt: null as string | null, botScheduledAt: null as string | null, gdoAppuntamentoAt: null as string | null,
    now: NOW,
  };
  it('niente lancio e niente agenda: vince', () => {
    expect(professioniVince(base)).toBe(true);
  });
  it('funnel PROFESSIONI senza corso: vince', () => {
    expect(professioniVince({ ...base, professione: null, crmFunnel: 'PROFESSIONI' })).toBe(true);
  });
  it('lancio chiuso + agenda GDO vecchia senza ora della call (forma della conv 3292): vince', () => {
    expect(professioniVince({
      ...base, lancioSlug: 'webdev-2026-10', lancioFase: 'chiuso', gdoAgendaAt: '2026-09-17T12:37:38Z', crmFunnel: 'Lancio Web Dev AI',
    })).toBe(true);
  });
  it('lancio restituito (fase terminale): vince', () => {
    expect(professioniVince({ ...base, lancioSlug: 'webdev-2026-10', lancioFase: 'restituito' })).toBe(true);
  });
  it('agenda con la call GDO gia passata: vince', () => {
    expect(professioniVince({ ...base, gdoAgendaAt: '2026-10-10T09:00:00Z', gdoAppuntamentoAt: '2026-10-12T15:00:00Z' })).toBe(true);
  });
  it('fase del lancio attiva: perde', () => {
    for (const fase of ['attesa', 'posto_bloccato', 'post_pitch', null]) {
      expect(professioniVince({ ...base, lancioSlug: 'webdev-2026-10', lancioFase: fase })).toBe(false);
    }
  });
  it('agenda con la call GDO ancora da fare: perde', () => {
    expect(professioniVince({ ...base, gdoAgendaAt: '2026-10-14T09:00:00Z', gdoAppuntamentoAt: '2026-10-16T15:00:00Z' })).toBe(false);
    expect(professioniVince({ ...base, gdoAgendaAt: '2026-10-14T09:00:00Z', botScheduledAt: '2026-10-16T15:00:00Z' })).toBe(false);
  });
  it('vince la piu recente fra le due colonne della call', () => {
    expect(professioniVince({
      ...base, gdoAgendaAt: '2026-10-01T09:00:00Z', gdoAppuntamentoAt: '2026-10-03T15:00:00Z', botScheduledAt: '2026-10-17T15:00:00Z',
    })).toBe(false);
  });
  it('agenda recente senza ora della call: la call puo essere ancora da fare, perde', () => {
    expect(professioniVince({ ...base, gdoAgendaAt: '2026-10-13T09:00:00Z' })).toBe(false);
  });
  it('agenda senza ora della call oltre la finestra di 7 giorni: vince', () => {
    expect(professioniVince({ ...base, gdoAgendaAt: '2026-10-08T11:59:00Z' })).toBe(true);
  });
  it('niente corso e funnel non PROFESSIONI: perde', () => {
    expect(professioniVince({ ...base, professione: null, crmFunnel: 'Lancio Web Dev AI' })).toBe(false);
    expect(professioniVince({ ...base, professione: null })).toBe(false);
  });
});
