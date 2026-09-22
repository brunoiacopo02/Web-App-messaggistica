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

describe('classificaRichiamo, periodoWords contro leadWords (fix round 1, I-4)', () => {
  it('entrambi presenti e discordi: vince periodoWords, il campo curato dal modello', () => {
    const r = classificaRichiamo({
      periodoWords: 'ci risentiamo a settembre',
      leadWords: 'va bene, ci sentiamo tra 2 giorni',
      nowMs: NOW,
    });
    // Letto solo su leadWords sarebbe stato "tieni_aperta" (tra 2 giorni, dentro i 3):
    // periodoWords deve vincere e portare a "scarta".
    expect(r.fascia).toBe('scarta');
    expect(r.quando).toBe('a settembre');
  });

  it('periodoWords senza un periodo riconoscibile: si prova leadWords come ripiego', () => {
    const r = classificaRichiamo({
      periodoWords: 'ok va bene',
      leadWords: 'allora ci sentiamo tra 5 giorni',
      nowMs: NOW,
    });
    expect(r.fascia).toBe('restituisci');
    expect(r.quando).toBe('tra 5 giorni');
  });

  it('solo leadWords (comportamento di prima, invariato)', () => {
    const r = classificaRichiamo({ leadWords: 'ci risentiamo a settembre', nowMs: NOW });
    expect(r.fascia).toBe('scarta');
    expect(r.quando).toBe('a settembre');
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

  it('"tra una settimana": sono 7 giorni, restituzione', () => {
    expect(classificaRichiamo({ leadWords: 'tra una settimana', nowMs: NOW }).fascia).toBe('restituisci');
  });

  it('"tra 1 settimana": stessa cosa scritta in cifre, restituzione', () => {
    expect(classificaRichiamo({ leadWords: 'tra 1 settimana', nowMs: NOW }).fascia).toBe('restituisci');
  });

  // Fix round 1, C-1 (Critical): il percorso a parole aveva SOLO due esiti
  // (restituisci/scarta), senza la fascia "tieni_aperta" che invece esiste sul
  // percorso con la data ISO. Un "fra due giorni" o "tra 3 giorni" veniva
  // restituito a un GDO e la chat si chiudeva (INTERROTTO), mentre il prompt
  // prometteva al lead che entro pochi giorni la chat sarebbe rimasta aperta.
  // Questi test coprono i confini richiesti dalla review sul percorso a parole,
  // simmetrici a quelli già esistenti sul percorso con la data ISO.
  describe('fix round 1 (C-1): la fascia "tieni_aperta" esiste anche sul percorso a parole', () => {
    it('"fra due giorni": dentro i 3 giorni, chat tenuta aperta', () => {
      expect(classificaRichiamo({ leadWords: 'fra due giorni', nowMs: NOW }).fascia).toBe('tieni_aperta');
    });

    it('"tra 3 giorni": esattamente al bordo, ancora tenuta aperta', () => {
      expect(classificaRichiamo({ leadWords: 'tra 3 giorni', nowMs: NOW }).fascia).toBe('tieni_aperta');
    });

    it('"fra 4 giorni": appena fuori dai 3 giorni, restituzione', () => {
      expect(classificaRichiamo({ leadWords: 'fra 4 giorni', nowMs: NOW }).fascia).toBe('restituisci');
    });

    it('"tra una settimana": restano 7 giorni, restituzione (non tieni_aperta)', () => {
      expect(classificaRichiamo({ leadWords: 'tra una settimana', nowMs: NOW }).fascia).toBe('restituisci');
    });

    it('"tra due settimane": oltre i 7 giorni, scarto', () => {
      expect(classificaRichiamo({ leadWords: 'tra due settimane', nowMs: NOW }).fascia).toBe('scarta');
    });
  });

  it('"tra due settimane": scarto per il motivo giusto (14 giorni > 7, non unità ignota)', () => {
    // Prova indiretta che l'unità è riconosciuta e moltiplicata, non che il pattern
    // fallisce a monte: "tra 14 giorni" (stessa distanza, unità già supportata prima
    // di questo fix) deve dare lo stesso esito di "tra due settimane".
    expect(classificaRichiamo({ leadWords: 'tra due settimane', nowMs: NOW }).fascia).toBe('scarta');
    expect(classificaRichiamo({ leadWords: 'tra 14 giorni', nowMs: NOW }).fascia).toBe('scarta');
  });

  it('"tra un mese": scarto', () => {
    expect(classificaRichiamo({ leadWords: 'tra un mese', nowMs: NOW }).fascia).toBe('scarta');
  });

  it('"tra 11 giorni" (cifre): scarto, mappa dei numeri a parole non serve qui', () => {
    expect(classificaRichiamo({ leadWords: 'tra 11 giorni', nowMs: NOW }).fascia).toBe('scarta');
  });

  // Fix round 2, I-2 (era il peggior difetto rimasto): fino a qui "tra undici giorni"
  // tornava `tieni_aperta` perché `estraiPeriodo` (lib/periodo-richiamo.ts, costante
  // NUMERI) non riconosceva "undici" come numero — con la conseguenza che il prompt,
  // avendo capito che il "quando" era oltre una settimana, congedava il lead ("da qui
  // non ti scrivo più io"), e la sequenza di follow-up gli riscriveva comunque entro
  // 4 giorni: un congedo seguito da un messaggio, la promessa rotta che questo intero
  // piano esiste per chiudere. `NUMERI` ora copre undici-diciannove, quindi il periodo
  // si estrae e la fascia si calcola per davvero.
  it('"tra undici giorni" (a parole): ora si riconosce, ed è oltre la settimana', () => {
    expect(classificaRichiamo({ leadWords: 'tra undici giorni', nowMs: NOW }).fascia).toBe('scarta');
  });

  it('gli altri numeri a lettere prima mancanti (dodici, tredici, quattordici, sedici, diciassette, diciotto, diciannove) si riconoscono tutti', () => {
    expect(classificaRichiamo({ leadWords: 'tra dodici giorni', nowMs: NOW }).fascia).toBe('scarta');
    expect(classificaRichiamo({ leadWords: 'fra tredici giorni', nowMs: NOW }).fascia).toBe('scarta');
    expect(classificaRichiamo({ leadWords: 'tra quattordici giorni', nowMs: NOW }).fascia).toBe('scarta');
    expect(classificaRichiamo({ leadWords: 'tra sedici giorni', nowMs: NOW }).fascia).toBe('scarta');
    expect(classificaRichiamo({ leadWords: 'tra diciassette giorni', nowMs: NOW }).fascia).toBe('scarta');
    expect(classificaRichiamo({ leadWords: 'tra diciotto giorni', nowMs: NOW }).fascia).toBe('scarta');
    expect(classificaRichiamo({ leadWords: 'tra diciannove giorni', nowMs: NOW }).fascia).toBe('scarta');
  });

  // "quindici" era già in NUMERI prima di questo fix (non era fra i mancanti): questo
  // test conferma solo che la catena estrazione→conversione funzionava già per lui.
  it('"tra quindici giorni" (a parole): già riconosciuto prima di questo fix, resta scarto', () => {
    expect(classificaRichiamo({ leadWords: 'tra quindici giorni', nowMs: NOW }).fascia).toBe('scarta');
  });

  describe('fix round 2 (I-2): "un paio di" e "qualche" non finiscono più su tieni_aperta di default', () => {
    it('"tra un paio di giorni": paio vale 2, dentro i 3 giorni, tieni_aperta', () => {
      expect(classificaRichiamo({ leadWords: 'tra un paio di giorni', nowMs: NOW }).fascia).toBe('tieni_aperta');
    });

    it('"fra un paio di settimane": 14 giorni, scarto', () => {
      expect(classificaRichiamo({ leadWords: 'fra un paio di settimane', nowMs: NOW }).fascia).toBe('scarta');
    });

    it('"tra un paio di mesi": 60 giorni, scarto', () => {
      expect(classificaRichiamo({ leadWords: 'tra un paio di mesi', nowMs: NOW }).fascia).toBe('scarta');
    });

    it('"tra qualche giorno": vago ma può superare i 3 giorni, mai tieni_aperta: restituzione', () => {
      expect(classificaRichiamo({ leadWords: 'tra qualche giorno', nowMs: NOW }).fascia).toBe('restituisci');
    });

    it('"fra qualche settimana": scarto', () => {
      expect(classificaRichiamo({ leadWords: 'fra qualche settimana', nowMs: NOW }).fascia).toBe('scarta');
    });

    it('"tra qualche mese": scarto', () => {
      expect(classificaRichiamo({ leadWords: 'tra qualche mese', nowMs: NOW }).fascia).toBe('scarta');
    });
  });
});

describe('classificaRichiamo, cambio dell\'ora legale', () => {
  it('esattamente 7 giorni di calendario a cavallo del 25/10/2026 (notte di 25h): restituzione, non scarto', () => {
    // Scritte a mano con l'offset reale di ciascuna data (niente fra(), che userebbe
    // la stessa aritmetica in millisecondi del bug e non lo vedrebbe mai).
    const nowMs = Date.parse('2026-10-22T10:00:00+02:00'); // giovedì, ancora CEST
    const date = '2026-10-29T10:00:00+01:00'; // giovedì successivo, già CET
    // In millisecondi sono 7 giorni + 1 ora (169h): sull'aritmetica ingenua supererebbe
    // 7 e finirebbe scartato. Sul calendario di Roma sono esattamente 7 giorni civili.
    expect(classificaRichiamo({ date, nowMs }).fascia).toBe('restituisci');
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

  // Fix round 1, "Important": il congedo dipende dal giudizio del modello sul
  // turno, non da questa funzione: il motivo non può più affermare come fatto
  // compiuto ("gli è stato detto") qualcosa che il codice non ha controllato.
  it('il motivo di scarto riporta l\'istruzione data al bot, non un fatto compiuto', () => {
    expect(buildRichiamoScartatoReason({ quando: 'a settembre' }))
      .toBe("vuole essere risentito a settembre: il bot aveva l'istruzione di dirgli che può riscrivere lui quando sarà il momento");
  });

  it('il motivo di scarto regge senza un quando', () => {
    expect(buildRichiamoScartatoReason({ quando: null }))
      .toBe("vuole essere risentito più avanti: il bot aveva l'istruzione di dirgli che può riscrivere lui quando sarà il momento");
  });
});
