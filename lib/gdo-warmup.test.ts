import { describe, expect, it } from 'vitest';
import {
  accodaDomanda, decidiDomanda, DOMANDA_1, DOMANDA_2, domandaPrecedente, eRispostaDaNotare, motivoRiscaldamento,
  notaRisposta, parlaDiDisdireOSpostare, riscaldamentoInerte, segnaleBrutto, type TurnoRiscaldamento,
} from './gdo-warmup';

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

const turno = (over: Partial<TurnoRiscaldamento> = {}): TurnoRiscaldamento => ({
  esito: false, passaggio: false, disdettaOSpostamento: false, spiegaNoemi: false,
  fallback: false, videoInUscita: false, rispostaModello: 'Perfetto, grazie!', ...over,
});

describe('motivoRiscaldamento: le guardie', () => {
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
    ['call non parsabile', { appuntamentoAt: 'boh' }, 'meno_3h'],
    ['tutto a posto', {}, 'in_prompt'],
  ] as const)('%s → %s', (_, over, motivo) => {
    expect(motivoRiscaldamento({ ...base, ...over })).toBe(motivo);
  });

  it('spento vince su tutto il resto', () => {
    expect(motivoRiscaldamento({ ...base, enabled: false, postino: false, cancelRequested: true, step: 3 })).toBe('spento');
  });

  it('inerti: spento, non_postino, cancel (e nessun motivo)', () => {
    expect(riscaldamentoInerte('spento')).toBe(true);
    expect(riscaldamentoInerte('non_postino')).toBe(true);
    expect(riscaldamentoInerte('cancel')).toBe(true);
    expect(riscaldamentoInerte(null)).toBe(true);
    expect(riscaldamentoInerte('meno_3h')).toBe(false);
    expect(riscaldamentoInerte('in_prompt')).toBe(false);
  });
});

describe('decidiDomanda', () => {
  it('passo 0 → domanda 1, passo 1 → domanda 2, passo 2 → niente', () => {
    expect(decidiDomanda('in_prompt', null, turno()).domanda).toEqual({ testo: DOMANDA_1, step: 1 });
    expect(decidiDomanda('in_prompt', 1, turno()).domanda).toEqual({ testo: DOMANDA_2, step: 2 });
    expect(decidiDomanda('in_prompt', 2, turno())).toEqual({ domanda: null, salto: 'gia_fatte' });
  });

  it.each(['spento', 'cancel', 'chiuso', 'no_recap', 'recap_turno', 'noemi', 'meno_3h', 'non_postino'] as const)(
    'motivo %s → nessuna domanda',
    (m) => {
      expect(decidiDomanda(m, null, turno())).toEqual({ domanda: null, salto: m });
    },
  );

  it.each([
    ['esito', { esito: true }],
    ['passaggio', { passaggio: true }],
    ['disdetta_spostamento', { disdettaOSpostamento: true }],
    ['noemi', { spiegaNoemi: true }],
    ['fallback', { fallback: true }],
    ['video_in_uscita', { videoInUscita: true }],
    ['risposta_vuota', { rispostaModello: '  ' }],
    ['modello_ha_chiesto', { rispostaModello: 'Hai visto il video?' }],
  ] as const)('turno con %s → nessuna domanda', (salto, over) => {
    expect(decidiDomanda('in_prompt', null, turno(over))).toEqual({ domanda: null, salto });
  });
});

describe('accodaDomanda: nella stessa bolla, mai una bolla in più', () => {
  it('in fondo all\'ultima bolla, dopo una riga vuota', () => {
    const r = accodaDomanda(['Perfetto, grazie!'], DOMANDA_1);
    expect(r.parts).toEqual([`Perfetto, grazie!\n\n${DOMANDA_1}`]);
    expect(r.bolla).toBe(r.parts[0]);
  });
  it('con più bolle tocca solo l\'ultima', () => {
    const r = accodaDomanda(['a', 'b'], DOMANDA_2);
    expect(r.parts).toEqual(['a', `b\n\n${DOMANDA_2}`]);
  });
  it('senza bolle non parte nessuna domanda da sola', () => {
    expect(accodaDomanda([], DOMANDA_1)).toEqual({ parts: [], bolla: null });
  });
  it('mai due volte la stessa domanda', () => {
    const r = accodaDomanda([`ok\n\n${DOMANDA_1}`], DOMANDA_1);
    expect(r.bolla).toBeNull();
    expect(r.parts).toEqual([`ok\n\n${DOMANDA_1}`]);
  });
  it('le domande stanno in 2 righe circa e non hanno condizionali sulla chiusura', () => {
    for (const d of [DOMANDA_1, DOMANDA_2]) {
      expect(d.length).toBeLessThanOrEqual(140);
      expect(d).not.toMatch(/se ti (convince|interessa)|eventualmente/i);
      expect(d).not.toContain('\n');
    }
    expect(DOMANDA_2).toContain('1.000 a 3.000 euro');
    expect(DOMANDA_2).not.toMatch(/\d+\s*rat/i); // mai cifre di rata
  });
});

describe('domandaPrecedente', () => {
  const out = (body: string) => ({ direction: 'out', body });
  const inn = (body: string) => ({ direction: 'in', body });
  it('la nostra ultima bolla prima del turno aveva la domanda 1 → 1', () => {
    expect(domandaPrecedente([out('recap'), inn('ok'), out(`Bene!\n\n${DOMANDA_1}`), inn('voglio cambiare lavoro')], 3)).toBe(1);
  });
  it('domanda 2 → 2', () => {
    expect(domandaPrecedente([out(`Grazie!\n\n${DOMANDA_2}`), inn('decido io')], 1)).toBe(2);
  });
  it('domanda in una bolla più vecchia: non è il turno dopo', () => {
    expect(domandaPrecedente([out(`x\n\n${DOMANDA_1}`), inn('a'), out('altro'), inn('b')], 3)).toBeNull();
  });
  it('nessun outbound prima → null', () => {
    expect(domandaPrecedente([inn('ciao')], 0)).toBeNull();
  });
});

describe('notaRisposta: la nota al CRM', () => {
  it('domanda 1 senza segnali brutti', () => {
    expect(notaRisposta(1, 'voglio  cambiare lavoro\nperché sono stufo')).toEqual({
      nota: 'Riscaldamento – obiettivo e perché adesso: «voglio cambiare lavoro perché sono stufo»',
      alert: false,
    });
  });
  it('domanda 2 con segnale brutto → ⚠️ in testa', () => {
    expect(notaRisposta(2, 'Non ho soldi, devo chiedere a mia moglie')).toEqual({
      nota: '⚠️ Riscaldamento – budget e chi decide: «Non ho soldi, devo chiedere a mia moglie»',
      alert: true,
    });
  });
  it('testo lunghissimo tagliato', () => {
    const { nota } = notaRisposta(1, 'a'.repeat(2000));
    expect(nota.length).toBeLessThan(700);
    expect(nota).toContain('…»');
  });
});

describe('segnaleBrutto', () => {
  it.each([
    'non ho soldi', 'i soldi sono un problema', 'non posso permettermelo', 'quanto costa?',
    'non mi interessa più', 'non ricordo di aver fissato', 'era per curiosità', 'devo chiedere a mio padre',
  ])('"%s" → ⚠️', (t) => {
    expect(segnaleBrutto(t)).toBe(true);
  });
  it.each(['voglio diventare sviluppatore', 'decido io', 'costante impegno', 'ricordo tutto'])('"%s" → niente', (t) => {
    expect(segnaleBrutto(t)).toBe(false);
  });
});

describe('parlaDiDisdireOSpostare', () => {
  it.each(['devo spostare la call', 'posso rimandare?', 'annullo tutto', 'voglio disdire', 'non posso venire', 'ho un imprevisto'])(
    '"%s" → sì', (t) => { expect(parlaDiDisdireOSpostare(t)).toBe(true); },
  );
  it.each(['voglio cambiare lavoro', 'decido io', 'ok grazie'])('"%s" → no', (t) => {
    expect(parlaDiDisdireOSpostare(t)).toBe(false);
  });
});

describe('eRispostaDaNotare', () => {
  const r = { testo: 'voglio cambiare lavoro', esito: false, passaggio: false, soloPresaDAtto: false, soloConfermaVideo: false };
  it('risposta vera → sì', () => { expect(eRispostaDaNotare(r)).toBe(true); });
  it.each([
    ['testo vuoto', { testo: ' ' }],
    ['esito', { esito: true }],
    ['passaggio', { passaggio: true }],
    ['solo ok', { soloPresaDAtto: true }],
    ['solo fatto', { soloConfermaVideo: true }],
    ['disdetta', { testo: 'devo annullare' }],
  ] as const)('%s → no', (_, over) => {
    expect(eRispostaDaNotare({ ...r, ...over })).toBe(false);
  });
});
