import { describe, it, expect } from 'vitest';
import {
  inCoorteVerifica, istanteVerifica, verificaRaggiungibile, decideVerifica, classificaRisposta,
  esitoDopoRisposta, verificaText, verificaVars, verificaAccesa, type DecisioneVerificaInput,
} from './verifica-presenza';

const at = (iso: string) => new Date(iso).getTime();
const MIN = 60_000;

// Lunedì 09/11/2026, ora solare (+01:00).
const CALL = '2026-11-09T16:00:00+01:00';

describe('inCoorteVerifica', () => {
  it('confermato sabato per la call di lunedì: dentro', () => {
    expect(inCoorteVerifica({ confermeOutcome: 'confermato', confermeOutcomeAt: '2026-11-07T15:00:00+01:00', appointmentAt: CALL })).toBe(true);
  });
  it('confermato lunedì mattina per la call di lunedì: fuori', () => {
    expect(inCoorteVerifica({ confermeOutcome: 'confermato', confermeOutcomeAt: '2026-11-09T09:10:00+01:00', appointmentAt: CALL })).toBe(false);
  });
  it('il giorno è di Roma, non UTC: conferma alle 00:30 di lunedì (23:30 UTC di domenica) = stesso giorno', () => {
    expect(inCoorteVerifica({ confermeOutcome: 'confermato', confermeOutcomeAt: '2026-11-08T23:30:00Z', appointmentAt: CALL })).toBe(false);
  });
  it('conferma alle 23:30 di domenica Roma (22:30 UTC): giorno prima', () => {
    expect(inCoorteVerifica({ confermeOutcome: 'confermato', confermeOutcomeAt: '2026-11-08T22:30:00Z', appointmentAt: CALL })).toBe(true);
  });
  it('scartato o da rifissare: fuori', () => {
    expect(inCoorteVerifica({ confermeOutcome: 'scartato', confermeOutcomeAt: '2026-11-07T15:00:00+01:00', appointmentAt: CALL })).toBe(false);
    expect(inCoorteVerifica({ confermeOutcome: 'da_rifissare', confermeOutcomeAt: '2026-11-07T15:00:00+01:00', appointmentAt: CALL })).toBe(false);
  });
  it('date mancanti: fuori', () => {
    expect(inCoorteVerifica({ confermeOutcome: 'confermato', confermeOutcomeAt: null, appointmentAt: CALL })).toBe(false);
    expect(inCoorteVerifica({ confermeOutcome: 'confermato', confermeOutcomeAt: '2026-11-07T15:00:00+01:00', appointmentAt: null })).toBe(false);
  });
  it('ora legale: conferma 25/10 sera per call del 26/10', () => {
    expect(inCoorteVerifica({ confermeOutcome: 'confermato', confermeOutcomeAt: '2026-10-25T20:00:00+01:00', appointmentAt: '2026-10-26T10:00:00+01:00' })).toBe(true);
  });
});

describe('istanteVerifica', () => {
  it('call alle 16:00: alle 15:00', () => {
    expect(istanteVerifica(at(CALL))).toBe(at('2026-11-09T15:00:00+01:00'));
  });
  it('call alle 9:30: alle 8:30 (fascia invii)', () => {
    expect(istanteVerifica(at('2026-11-09T09:30:00+01:00'))).toBe(at('2026-11-09T08:30:00+01:00'));
  });
  it('call alle 9:15: alle 8:30, ultimo istante utile', () => {
    expect(istanteVerifica(at('2026-11-09T09:15:00+01:00'))).toBe(at('2026-11-09T08:30:00+01:00'));
  });
  it('call alle 9:00: mai (8:00 fuori fascia, 8:30 troppo tardi)', () => {
    expect(istanteVerifica(at('2026-11-09T09:00:00+01:00'))).toBeNull();
  });
  it('call alle 21:00: alle 20:00', () => {
    expect(istanteVerifica(at('2026-11-09T21:00:00+01:00'))).toBe(at('2026-11-09T20:00:00+01:00'));
  });
  it('ora legale: call alle 16:00 del 20/10 alle 15:00 locali', () => {
    expect(istanteVerifica(at('2026-10-20T16:00:00+02:00'))).toBe(at('2026-10-20T15:00:00+02:00'));
  });
});

describe('verificaRaggiungibile', () => {
  it('alle 14:00 per la call delle 16: sì', () => {
    expect(verificaRaggiungibile(at(CALL), at('2026-11-09T14:00:00+01:00'))).toBe(true);
  });
  it('alle 15:16 per la call delle 16: no (oltre T-45)', () => {
    expect(verificaRaggiungibile(at(CALL), at('2026-11-09T15:16:00+01:00'))).toBe(false);
  });
  it('call delle 9:00: mai', () => {
    expect(verificaRaggiungibile(at('2026-11-09T09:00:00+01:00'), at('2026-11-09T06:00:00+01:00'))).toBe(false);
  });
});

const base = (over: Partial<DecisioneVerificaInput> = {}): DecisioneVerificaInput => ({
  enabled: true,
  callMs: at(CALL),
  nowMs: at('2026-11-09T15:00:00+01:00'),
  chatDelLead: true,
  aiPausedAt: null,
  disdettaDopoConferma: false,
  giaInviata: false,
  finestraAperta: false,
  haTemplate: true,
  ...over,
});

describe('decideVerifica', () => {
  it('alle 15:00 per la call delle 16: template', () => {
    expect(decideVerifica(base())).toBe('template');
  });
  it('alle 14:59: non ancora', () => {
    expect(decideVerifica(base({ nowMs: at('2026-11-09T14:59:00+01:00') }))).toBeNull();
  });
  it('alle 15:15 ancora sì, alle 15:16 no', () => {
    expect(decideVerifica(base({ nowMs: at('2026-11-09T15:15:00+01:00') }))).toBe('template');
    expect(decideVerifica(base({ nowMs: at('2026-11-09T15:16:00+01:00') }))).toBeNull();
  });
  it('finestra aperta sul numero: testo libero', () => {
    expect(decideVerifica(base({ finestraAperta: true }))).toBe('testo');
  });
  it('senza template e finestra chiusa: niente', () => {
    expect(decideVerifica(base({ haTemplate: false }))).toBeNull();
  });
  it('nessun doppio invio: già presa per questa data', () => {
    expect(decideVerifica(base({ giaInviata: true }))).toBeNull();
  });
  it('spenta, chat ferma a mano, chat di un gemello, disdetta dopo la conferma: niente', () => {
    expect(decideVerifica(base({ enabled: false }))).toBeNull();
    expect(decideVerifica(base({ aiPausedAt: '2026-11-09T10:00:00+01:00' }))).toBeNull();
    expect(decideVerifica(base({ chatDelLead: false }))).toBeNull();
    expect(decideVerifica(base({ disdettaDopoConferma: true }))).toBeNull();
  });
  it('mai fuori fascia: call delle 9:00 alle 8:00', () => {
    expect(decideVerifica(base({ callMs: at('2026-11-09T09:00:00+01:00'), nowMs: at('2026-11-09T08:00:00+01:00') }))).toBeNull();
  });
});

describe('classificaRisposta', () => {
  it.each([
    'Sì', 'si', 'Si certo', 'Sì, ci sarò', 'Confermo', 'ci sono', 'Ok', 'ok grazie', 'Perfetto', 'va bene',
    '👍', 'Certamente, a dopo', 'Non vedo l\'ora!', 'Sì non mancherò', 'nessun problema',
  ])('"%s" = conferma', (t) => {
    expect(classificaRisposta(t)).toBe('conferma');
  });
  it.each([
    'No', 'non posso più', 'Sì ma possiamo spostarla?', 'devo rimandare', 'ho avuto un imprevisto',
    'Vorrei annullare', 'arrivo in ritardo di 10 minuti', 'no, oggi non riesco', 'Possiamo fare un altro giorno?',
  ])('"%s" = non_conferma', (t) => {
    expect(classificaRisposta(t)).toBe('non_conferma');
  });
  it.each(['Chi sei?', 'A che ora era?', '', '   ', 'Mi mandi il link?'])('"%s" = altro', (t) => {
    expect(classificaRisposta(t)).toBe('altro');
  });
});

describe('esitoDopoRisposta', () => {
  it('in attesa + sì = confermato', () => expect(esitoDopoRisposta('in_attesa', 'conferma')).toBe('confermato'));
  it('in attesa + altro = risposta', () => expect(esitoDopoRisposta('in_attesa', 'altro')).toBe('risposta'));
  it('risposta + sì = confermato', () => expect(esitoDopoRisposta('risposta', 'conferma')).toBe('confermato'));
  it('confermato + "ok grazie" o altro: resta', () => {
    expect(esitoDopoRisposta('confermato', 'conferma')).toBeNull();
    expect(esitoDopoRisposta('confermato', 'altro')).toBeNull();
  });
  it('confermato + disdetta = non_conferma', () => expect(esitoDopoRisposta('confermato', 'non_conferma')).toBe('non_conferma'));
  it('non_conferma + altro: resta; + sì: confermato', () => {
    expect(esitoDopoRisposta('non_conferma', 'altro')).toBeNull();
    expect(esitoDopoRisposta('non_conferma', 'conferma')).toBe('confermato');
  });
});

describe('testo e interruttore', () => {
  it('il testo non invita a spostare né disdire', () => {
    const t = verificaText(verificaVars('Luca Rossi', at(CALL), at('2026-11-09T15:00:00+01:00')));
    expect(t).toBe('Promemoria appuntamento: ciao Luca, la tua videocall con Fenice Academy è in programma oggi alle 16:00. Mi confermi che ci sarai? Rispondi pure qui.');
    expect(/spost|disdi|annull|cambia/i.test(t)).toBe(false);
  });
  it('spento salvo VERIFICA_1H_ENABLED=1', () => {
    expect(verificaAccesa({})).toBe(false);
    expect(verificaAccesa({ VERIFICA_1H_ENABLED: '0' })).toBe(false);
    expect(verificaAccesa({ VERIFICA_1H_ENABLED: '1' })).toBe(true);
  });
});
