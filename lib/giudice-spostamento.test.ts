import { describe, it, expect } from 'vitest';
import {
  agendaVecchia,
  applicaGuardieSpostamento,
  chiedeDiSpostare,
  costruisciInputSpostamento,
  giudiceSpostamentiAcceso,
  type FattiSpostamento,
} from './giudice-spostamento';
import type { MessaggioChat } from './giudice-disdetta';

const m = (direction: 'in' | 'out', body: string, created_at: string): MessaggioChat => ({ direction, body, created_at });
const ADESSO = '2026-11-04T08:00:00Z';
const base: FattiSpostamento = { adesso: ADESSO, canale: 'gdo', agendaAt: '2026-11-04T13:00:00Z' };

describe('interruttore', () => {
  it('assente o diverso da 1 = spento', () => {
    expect(giudiceSpostamentiAcceso({})).toBe(false);
    expect(giudiceSpostamentiAcceso({ GIUDICE_SPOSTAMENTI_ENABLED: '0' })).toBe(false);
    expect(giudiceSpostamentiAcceso({ GIUDICE_SPOSTAMENTI_ENABLED: 'true' })).toBe(false);
    expect(giudiceSpostamentiAcceso({ GIUDICE_SPOSTAMENTI_ENABLED: ' 1 ' })).toBe(true);
  });
});

describe('agendaVecchia', () => {
  const now = Date.parse(ADESSO);
  it('oltre 7 giorni passata', () => {
    expect(agendaVecchia('2026-10-27T07:00:00Z', now)).toBe(true);
    expect(agendaVecchia('2026-10-29T08:00:00Z', now)).toBe(false);
    expect(agendaVecchia('2026-11-05T08:00:00Z', now)).toBe(false);
    expect(agendaVecchia(null, now)).toBe(false);
    expect(agendaVecchia('boh', now)).toBe(false);
  });
});

describe('chiedeDiSpostare', () => {
  it('richieste esplicite', () => {
    for (const t of ['possiamo spostare nel pomeriggio?', 'oggi non riesco', 'non posso alle 15', 'facciamo un altro giorno', 'Si può rimandare?']) {
      expect(chiedeDiSpostare([t])).toBe(true);
    }
  });
  it('non su conferme e saluti', () => {
    for (const t of ['ok grazie', 'Perfetto a domani', 'Altrettanto', 'ho visto il video']) expect(chiedeDiSpostare([t])).toBe(false);
  });
});

describe('applicaGuardieSpostamento', () => {
  const chat = [
    m('out', 'Ti ricordo la call di oggi alle 14', '2026-11-04T07:00:00Z'),
    m('in', 'Buongiorno, possiamo spostare nel pomeriggio?', '2026-11-04T07:59:00Z'),
    m('out', 'Certo, lo sistemi con Noemi', '2026-11-04T07:59:30Z'),
  ];
  it('non_spostamento con richiesta esplicita nel turno → dubbio', () => {
    const g = applicaGuardieSpostamento({ verdetto: 'non_spostamento', citazione: '' }, chat, base);
    expect(g).toEqual({ verdetto: 'dubbio', guardia: ['richiesta_esplicita_nel_turno'] });
  });
  it('… ma non se il bot ha già spostato dopo quel turno', () => {
    const g = applicaGuardieSpostamento({ verdetto: 'non_spostamento', citazione: '' }, chat, {
      ...base,
      spostamentiBot: [{ at: '2026-11-04T07:59:40Z', da: null, a: '2026-11-04T15:00:00Z' }],
    });
    expect(g.verdetto).toBe('non_spostamento');
  });
  it('… né se la nota è già arrivata alle Conferme dopo quel turno', () => {
    const g = applicaGuardieSpostamento({ verdetto: 'non_spostamento', citazione: '' }, chat, {
      ...base,
      noteGiaInviate: [{ at: '2026-11-04T07:59:50Z', nota: 'SPOSTAMENTO CHIESTO — …' }],
    });
    expect(g.verdetto).toBe('non_spostamento');
  });
  it('non_spostamento su un «grazie» resta', () => {
    const g = applicaGuardieSpostamento({ verdetto: 'non_spostamento', citazione: '' }, [m('in', 'grazie mille', '2026-11-04T07:59:00Z')], base);
    expect(g.verdetto).toBe('non_spostamento');
  });
  it('disdetta senza la frase del lead → dubbio', () => {
    const g = applicaGuardieSpostamento({ verdetto: 'disdetta', citazione: 'non mi interessa più del corso' }, chat, base);
    expect(g).toEqual({ verdetto: 'dubbio', guardia: ['disdetta_senza_citazione'] });
  });
  it('disdetta con la frase vera resta disdetta', () => {
    const c = [m('in', 'Non sono in grado di pagarmi il corso, mi dispiace', '2026-11-04T07:59:00Z')];
    const g = applicaGuardieSpostamento({ verdetto: 'disdetta', citazione: 'non sono in grado di pagarmi il corso' }, c, base);
    expect(g.verdetto).toBe('disdetta');
  });
  it('spostamento_vero e dubbio non si toccano', () => {
    expect(applicaGuardieSpostamento({ verdetto: 'spostamento_vero', citazione: '' }, chat, base).verdetto).toBe('spostamento_vero');
    expect(applicaGuardieSpostamento({ verdetto: 'dubbio', citazione: '' }, chat, base).verdetto).toBe('dubbio');
  });
});

describe('costruisciInputSpostamento', () => {
  it('fatti in testa (agenda, spostamenti, note già inviate) e chat fino ad adesso', () => {
    const t = costruisciInputSpostamento(
      [m('in', 'oggi non riesco', '2026-11-04T07:59:00Z'), m('in', 'dopo', '2026-11-04T09:00:00Z')],
      {
        ...base,
        dataChiesta: '2026-11-05T16:00:00Z',
        spostamentiBot: [{ at: '2026-11-03T10:00:00Z', da: '2026-11-03T13:00:00Z', a: '2026-11-04T13:00:00Z' }],
        noteGiaInviate: [{ at: '2026-11-03T09:00:00Z', nota: 'SPOSTAMENTO CHIESTO — x' }],
      },
    );
    expect(t).toContain("l'ha fissata al telefono un operatore");
    expect(t).toContain('Videochiamata in agenda: mercoledì 4 novembre alle 14:00 (fra 5 ore)');
    expect(t).toContain('Il BOT ha capito che il lead chiede: giovedì 5 novembre alle 17:00');
    expect(t).toContain('il BOT ha GIÀ spostato la videochiamata');
    expect(t).toContain('è GIÀ arrivata alle Conferme');
    expect(t).toContain('LEAD: oggi non riesco');
    expect(t).not.toContain('LEAD: dopo');
  });
});
