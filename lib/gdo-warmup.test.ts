import { describe, expect, it } from 'vitest';
import { avanzaRiscaldamento, motivoRiscaldamento, notaRiscaldamento } from './gdo-warmup';

const NOW = Date.parse('2026-10-21T12:00:00+02:00');
const CALL = '2026-10-23T10:00:00+02:00'; // venerdì 23

const base = {
  enabled: true,
  step: null as number | null,
  recapForAt: CALL,
  recapInQuestoTurno: false,
  appuntamentoAt: CALL,
  serveNoemi: false,
  nowMs: NOW,
};

describe('notaRiscaldamento: quando tace', () => {
  it.each([
    ['interruttore spento', { enabled: false }],
    ['riscaldamento chiuso (passo 3)', { step: 3 }],
    ['recap mai mandato', { recapForAt: null }],
    ['recap partito in questo turno', { recapInQuestoTurno: true }],
    ['in questo turno si spiega Noemi', { serveNoemi: true }],
    ['call fra 2 ore', { appuntamentoAt: new Date(NOW + 2 * 3600_000).toISOString() }],
    ['call senza data', { appuntamentoAt: null }],
    ['call non parsabile', { appuntamentoAt: 'boh' }],
  ])('%s → null', (_, over) => {
    expect(notaRiscaldamento({ ...base, ...over })).toBeNull();
  });
});

describe('notaRiscaldamento: i tre passi', () => {
  it('passo null → domanda 1, col giorno della call', () => {
    const n = notaRiscaldamento(base) ?? '';
    expect(n).toContain('RISCALDAMENTO, PASSO 1');
    expect(n).toContain('videochiamata di venerdì 23');
    expect(n).toContain('[RISCALDAMENTO:1]');
  });
  it('passo 1 → domanda 2, la cifra senza rate', () => {
    const n = notaRiscaldamento({ ...base, step: 1 }) ?? '';
    expect(n).toContain('RISCALDAMENTO, PASSO 2');
    expect(n).toContain('1.000 a 3.000');
  });
  it('passo 2 → chiusura con nota al CRM, giorno e ora', () => {
    const n = notaRiscaldamento({ ...base, step: 2 }) ?? '';
    expect(n).toContain('RISCALDAMENTO, CHIUSURA');
    expect(n).toContain('⚠️ Da verificare');
    expect(n).toContain('venerdì 23 alle 10:00');
  });
});

describe('avanzaRiscaldamento', () => {
  it.each([
    [null, 1, { step: 1, chiuso: false }],
    [null, 2, { step: 2, chiuso: false }], // domanda 1 saltata: ammesso dal passo 1
    [1, undefined, { step: 1, chiuso: false }],
    [1, 0, { step: 3, chiuso: true }],
    [2, 3, { step: 3, chiuso: true }],
    [1, 3, { step: 1, chiuso: false }],
    [1, 2, { step: 2, chiuso: false }],
    [null, 3, { step: null, chiuso: false }],
    [null, undefined, { step: null, chiuso: false }],
    [3, 0, { step: 3, chiuso: false }], // già chiuso: niente da chiudere
  ] as const)('(%s, %s)', (step, tag, atteso) => {
    expect(avanzaRiscaldamento(step, tag)).toEqual(atteso);
  });
});

describe('motivoRiscaldamento: perché la nota parte o salta', () => {
  it.each([
    ['interruttore spento', { enabled: false }, 'spento'],
    ['turno non del postino', { postino: false }, 'non_postino'],
    ['lead con cancel', { cancelRequested: true }, 'cancel'],
    ['riscaldamento chiuso (passo 3)', { step: 3 }, 'chiuso'],
    ['recap mai mandato', { recapForAt: null }, 'no_recap'],
    ['recap partito in questo turno', { recapInQuestoTurno: true }, 'recap_turno'],
    ['in questo turno si spiega Noemi', { serveNoemi: true }, 'noemi'],
    ['call fra 2 ore', { appuntamentoAt: new Date(NOW + 2 * 3600_000).toISOString() }, 'meno_3h'],
    ['call senza data', { appuntamentoAt: null }, 'meno_3h'],
    ['tutto a posto', {}, 'in_prompt'],
    ['passo 2, tutto a posto', { step: 2, postino: true, cancelRequested: false }, 'in_prompt'],
  ] as const)('%s → %s', (_, over, motivo) => {
    expect(motivoRiscaldamento({ ...base, ...over })).toBe(motivo);
  });

  it('spento vince su tutto il resto', () => {
    expect(motivoRiscaldamento({ ...base, enabled: false, postino: false, cancelRequested: true, step: 3 })).toBe('spento');
  });

  it('la nota esiste se e solo se il motivo è in_prompt', () => {
    const casi = [{}, { step: 1 }, { step: 3 }, { recapForAt: null }, { serveNoemi: true }, { enabled: false }];
    for (const over of casi) {
      const i = { ...base, ...over };
      expect(notaRiscaldamento(i) !== null).toBe(motivoRiscaldamento(i) === 'in_prompt');
    }
  });
});
