import { describe, it, expect } from 'vitest';
import { deveSegnalare } from './risposta-post-nr';
import { buildRispostaPostNrNote } from './bot-outcome-rules';

const NR = '2026-08-29T10:00:00.000Z';

describe('deveSegnalare', () => {
  it('segnala quando il lead scrive dopo il messaggio del terzo tentativo', () => {
    expect(deveSegnalare({
      terzoNrInviatoAt: NR,
      ultimoInboundAt: '2026-08-29T10:04:00.000Z',
      giaSegnalato: false,
    })).toBe(true);
  });

  it('non segnala se il lead non ha mai scritto dopo', () => {
    expect(deveSegnalare({
      terzoNrInviatoAt: NR,
      ultimoInboundAt: '2026-08-29T09:12:00.000Z',
      giaSegnalato: false,
    })).toBe(false);
  });

  it('non segnala due volte: due messaggi di fila del lead sono una notifica sola', () => {
    expect(deveSegnalare({
      terzoNrInviatoAt: NR,
      ultimoInboundAt: '2026-08-29T10:04:00.000Z',
      giaSegnalato: true,
    })).toBe(false);
  });

  it('non segnala se il terzo tentativo non e\' mai partito', () => {
    expect(deveSegnalare({
      terzoNrInviatoAt: null,
      ultimoInboundAt: '2026-08-29T10:04:00.000Z',
      giaSegnalato: false,
    })).toBe(false);
  });

  it('non segnala se il lead non ha mai scritto', () => {
    expect(deveSegnalare({ terzoNrInviatoAt: NR, ultimoInboundAt: null, giaSegnalato: false })).toBe(false);
  });

  it('una data illeggibile non fa partire niente', () => {
    expect(deveSegnalare({ terzoNrInviatoAt: 'boh', ultimoInboundAt: 'mai', giaSegnalato: false })).toBe(false);
  });
});

describe('buildRispostaPostNrNote', () => {
  it('dice il fatto e riporta le parole del lead', () => {
    const n = buildRispostaPostNrNote({ leadWords: 'Si scusate ero al lavoro', quandoNrIso: NR });
    expect(n).toContain('HA RISPOSTO DOPO IL TERZO TENTATIVO');
    expect(n).toContain('"Si scusate ero al lavoro"');
  });

  it('regge anche senza parole: il fatto resta quello', () => {
    const n = buildRispostaPostNrNote({ quandoNrIso: NR });
    expect(n).toContain('HA RISPOSTO DOPO IL TERZO TENTATIVO');
    expect(n).not.toContain('""');
  });

  it('dice quando gli avevamo scritto, in ora italiana e per esteso', () => {
    // Le legge una persona pochi minuti prima di telefonare: "sabato 29 agosto alle
    // 12:00" si capisce a colpo d'occhio, una data ISO no.
    expect(buildRispostaPostNrNote({ quandoNrIso: NR })).toContain('29 agosto alle 12:00');
  });
});
