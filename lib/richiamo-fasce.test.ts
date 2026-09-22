import { describe, it, expect } from 'vitest';
import {
  RICHIAMO_FASCIA_APERTA_GG,
  RICHIAMO_FASCIA_RESTITUZIONE_GG,
  classificaRichiamo,
  buildRichiamoRestituitoNote,
  buildRichiamoScartatoReason,
} from './richiamo-fasce';

// Riferimento fisso: martedì 22 settembre 2026, 10:00 ora di Roma.
const NOW = Date.parse('2026-09-22T10:00:00+02:00');
const fra = (giorni: number, ora = '10:00') => {
  const d = new Date(NOW + giorni * 24 * 3600_000);
  const iso = d.toISOString().slice(0, 10);
  return `${iso}T${ora}:00+02:00`;
};

describe('le soglie', () => {
  it('sono 3 e 7 giorni', () => {
    expect(RICHIAMO_FASCIA_APERTA_GG).toBe(3);
    expect(RICHIAMO_FASCIA_RESTITUZIONE_GG).toBe(7);
  });
});

describe('classificaRichiamo, con una data', () => {
  it('domani: la chat resta aperta, la sequenza lo ripesca', () => {
    expect(classificaRichiamo({ date: fra(1), nowMs: NOW }).fascia).toBe('tieni_aperta');
  });

  it('esattamente a 3 giorni: ancora dentro la sequenza', () => {
    expect(classificaRichiamo({ date: fra(3), nowMs: NOW }).fascia).toBe('tieni_aperta');
  });

  it('a 4 giorni: fuori dalla sequenza, torna a un GDO', () => {
    expect(classificaRichiamo({ date: fra(4), nowMs: NOW }).fascia).toBe('restituisci');
  });

  it('esattamente a 7 giorni: ancora restituzione', () => {
    expect(classificaRichiamo({ date: fra(7), nowMs: NOW }).fascia).toBe('restituisci');
  });

  it('a 8 giorni: scarto, riscriverà lui', () => {
    expect(classificaRichiamo({ date: fra(8), nowMs: NOW }).fascia).toBe('scarta');
  });

  it('fra tre mesi: scarto', () => {
    expect(classificaRichiamo({ date: fra(90), nowMs: NOW }).fascia).toBe('scarta');
  });

  it('restituisce il "quando" leggibile in ora di Roma', () => {
    const r = classificaRichiamo({ date: fra(5, '15:00'), nowMs: NOW });
    expect(r.quando).toContain('27 settembre');
  });
});

describe('classificaRichiamo, senza una data usabile', () => {
  it('una data nel passato non è un esito: si tiene la chat aperta', () => {
    expect(classificaRichiamo({ date: fra(-2), nowMs: NOW }).fascia).toBe('tieni_aperta');
  });

  it('nessuna data e nessuna parola sul quando: si tiene la chat aperta', () => {
    expect(classificaRichiamo({ nowMs: NOW }).fascia).toBe('tieni_aperta');
    expect(classificaRichiamo({ leadWords: 'ok ci sentiamo', nowMs: NOW }).fascia).toBe('tieni_aperta');
  });

  it('"la settimana prossima" può stare dentro i 7 giorni: restituzione', () => {
    const r = classificaRichiamo({ leadWords: 'guarda risentiamoci la settimana prossima', nowMs: NOW });
    expect(r.fascia).toBe('restituisci');
    expect(r.quando).toBe('la settimana prossima');
  });

  it('"tra 5 giorni": restituzione', () => {
    expect(classificaRichiamo({ leadWords: 'tra 5 giorni', nowMs: NOW }).fascia).toBe('restituisci');
  });

  it('"tra 20 giorni": scarto', () => {
    expect(classificaRichiamo({ leadWords: 'tra 20 giorni', nowMs: NOW }).fascia).toBe('scarta');
  });

  it('"a settembre": scarto, e riporta le parole del lead', () => {
    const r = classificaRichiamo({ leadWords: 'ci risentiamo a settembre allora', nowMs: NOW });
    expect(r.fascia).toBe('scarta');
    expect(r.quando).toBe('a settembre');
  });

  it('"dopo le ferie": scarto', () => {
    expect(classificaRichiamo({ leadWords: 'dopo le ferie ne riparliamo', nowMs: NOW }).fascia).toBe('scarta');
  });

  it('"il mese prossimo": scarto', () => {
    expect(classificaRichiamo({ leadWords: 'il mese prossimo', nowMs: NOW }).fascia).toBe('scarta');
  });

  it('"tra due settimane": scarto', () => {
    expect(classificaRichiamo({ leadWords: 'tra due settimane', nowMs: NOW }).fascia).toBe('scarta');
  });
});

describe('i testi', () => {
  it('la nota di restituzione dice il giorno e cita il lead', () => {
    const n = buildRichiamoRestituitoNote({
      quando: 'sabato 26 settembre alle 15:00',
      leadWords: 'guarda richiamami sabato che oggi non riesco',
    });
    expect(n).toContain('sabato 26 settembre alle 15:00');
    expect(n).toContain('Parole del lead');
    // Non deve promettere niente a nome del GDO.
    expect(n).not.toMatch(/ti chiamiamo|lo richiamiamo noi/i);
  });

  it('la nota di restituzione regge anche senza un quando', () => {
    const n = buildRichiamoRestituitoNote({ quando: null, leadWords: 'richiamami più avanti' });
    expect(n).toContain('non ha detto quando');
  });

  it('il motivo di scarto dice che riscriverà lui', () => {
    expect(buildRichiamoScartatoReason({ quando: 'a settembre' }))
      .toBe('vuole essere risentito a settembre: gli è stato detto di riscrivere quando sarà il momento');
  });

  it('il motivo di scarto regge senza un quando', () => {
    expect(buildRichiamoScartatoReason({ quando: null }))
      .toBe('vuole essere risentito più avanti: gli è stato detto di riscrivere quando sarà il momento');
  });
});
