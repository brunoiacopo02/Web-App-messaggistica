import { describe, it, expect } from 'vitest';
import {
  templateSchedaPer, templateSchedaAcceso, testoTemplateScheda, testoTemplateSceltaCorso, elencoCorsi, fileScheda,
} from './scheda-template';
import { PROFESSIONI } from './professioni';

describe('template della scheda (campagna brochure, PO 10/11/2026)', () => {
  it('corso noto: variante col PDF, nome, corso e file del catalogo', () => {
    const s = templateSchedaPer('Giulia', 'social_media_manager');
    expect(s.tipo).toBe('scheda');
    expect(s.envKey).toBe('SCHEDA_TEMPLATE_SID');
    expect(s.variabili).toEqual({ '1': 'Giulia', '2': 'Social Media Manager', '3': 'social-media-manager.pdf' });
    expect(s.testo).toBe(testoTemplateScheda('Giulia', 'Social Media Manager'));
  });
  it('corso non noto: variante senza PDF che chiede il corso', () => {
    const s = templateSchedaPer('Naomi', null);
    expect(s.tipo).toBe('scelta_corso');
    expect(s.envKey).toBe('SCHEDA_SCELTA_TEMPLATE_SID');
    expect(s.variabili).toEqual({ '1': 'Naomi' });
    for (const p of PROFESSIONI) expect(s.testo).toContain(p.nome);
  });
  it('ogni corso ha il suo PDF', () => {
    for (const p of PROFESSIONI) expect(fileScheda(p.slug)).toMatch(/\.pdf$/);
  });
  it('testi: niente prezzi, niente "se ti convince", chiudono con una domanda', () => {
    for (const t of [testoTemplateScheda('{{1}}', '{{2}}'), testoTemplateSceltaCorso('{{1}}')]) {
      expect(t).not.toMatch(/€|euro|sconto|offerta|se ti convince/i);
      expect(t.trim().endsWith('?')).toBe(true);
    }
    expect(elencoCorsi()).toMatch(/, Copywriter o Sviluppatore Web AI$/);
  });
  it('interruttore spento di default', () => {
    expect(templateSchedaAcceso({})).toBe(false);
    expect(templateSchedaAcceso({ SCHEDA_TEMPLATE_ENABLED: '0' })).toBe(false);
    expect(templateSchedaAcceso({ SCHEDA_TEMPLATE_ENABLED: '1' })).toBe(true);
  });
});
