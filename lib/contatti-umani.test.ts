import { describe, it, expect } from 'vitest';
import { motivoRichiesta, CATEGORIE, type MessaggioIn } from './contatti-umani';

const m = (body: string, created_at: string): MessaggioIn => ({ body, created_at });

describe('motivoRichiesta', () => {
  it('prende il messaggio in cui il lead ha chiesto la persona, non l\'ultimo in assoluto', () => {
    const r = motivoRichiesta([
      m('Ciao', '2026-08-01T10:00:00Z'),
      m('Mi puoi mettere in contatto con Marta', '2026-08-01T10:05:00Z'),
      m('Ok', '2026-08-01T10:30:00Z'),
      m('Grazie', '2026-08-01T10:31:00Z'),
    ]);
    expect(r.parole).toBe('Mi puoi mettere in contatto con Marta');
    expect(r.richiestoIl).toBe('2026-08-01T10:05:00Z');
    expect(r.categoria).toBe('chiede_una_persona');
  });

  it('se nessun messaggio contiene una richiesta esplicita, ripiega sull\'ultimo', () => {
    const r = motivoRichiesta([m('Ciao', '2026-08-01T10:00:00Z'), m('Boh', '2026-08-01T10:05:00Z')]);
    expect(r.parole).toBe('Boh');
    expect(r.categoria).toBe('altro');
  });

  it('la richiesta più recente vince, se il lead l\'ha ripetuta', () => {
    const r = motivoRichiesta([
      m('Chiamami', '2026-08-01T10:00:00Z'),
      m('Mi puoi chiamare per favore', '2026-08-02T10:00:00Z'),
    ]);
    expect(r.richiestoIl).toBe('2026-08-02T10:00:00Z');
  });

  it('nessun messaggio: niente parole, categoria altro', () => {
    const r = motivoRichiesta([]);
    expect(r.parole).toBe('');
    expect(r.categoria).toBe('altro');
    expect(r.richiestoIl).toBeNull();
  });

  it('salta i messaggi vuoti (media senza didascalia)', () => {
    const r = motivoRichiesta([m('Mi puoi chiamare', '2026-08-01T10:00:00Z'), m('', '2026-08-01T11:00:00Z')]);
    expect(r.parole).toBe('Mi puoi chiamare');
  });

  it('normalizza gli a capo: la nota al CRM è una riga sola', () => {
    const r = motivoRichiesta([m('Mi puoi\n\nchiamare   subito', '2026-08-01T10:00:00Z')]);
    expect(r.parole).toBe('Mi puoi chiamare subito');
  });

  describe('categorie', () => {
    const caso = (testo: string) => motivoRichiesta([m(testo, '2026-08-01T10:00:00Z')]).categoria;

    it('vuole essere richiamato', () => {
      expect(caso('Mi puoi chiamare')).toBe('vuole_essere_chiamato');
      expect(caso('Chiamami quando puoi')).toBe('vuole_essere_chiamato');
      expect(caso('Se mi chiamate entro 5 minuti ci sono')).toBe('vuole_essere_chiamato');
    });

    it('chiede una persona', () => {
      expect(caso('Voglio parlare con un operatore')).toBe('chiede_una_persona');
      expect(caso('Ho capito, farmi sentire la tua collega.')).toBe('chiede_una_persona');
      expect(caso('Posso parlare con una persona vera?')).toBe('chiede_una_persona');
    });

    it('disdetta o spostamento della call', () => {
      expect(caso('Purtroppo devo annullare la call di oggi')).toBe('disdetta_o_spostamento');
      expect(caso('Possiamo spostare a domani?')).toBe('disdetta_o_spostamento');
      // Casi veri del 25/08: le forme flesse cadevano tutte in "altro".
      expect(caso('Buongiorno oggi ho la call, purtroppo devo annullarla per motivi familiari')).toBe('disdetta_o_spostamento');
      expect(caso('Volevo spostarla a settimana prossima')).toBe('disdetta_o_spostamento');
      expect(caso('La disdico, non me la sento')).toBe('disdetta_o_spostamento');
    });

    it('nominare un collega non è chiedere un collega', () => {
      // Conv 3781: il lead sta ricostruendo cos'è successo al suo appuntamento.
      expect(caso('Forse lo ha cancellato la tua collega?')).toBe('disdetta_o_spostamento');
      expect(caso('Me lo aveva detto la tua collega')).toBe('altro');
    });

    it('problema con la prenotazione', () => {
      expect(caso('Nessuna fascia oraria disponibile mi dice')).toBe('problema_prenotazione');
      expect(caso('Il link non funziona')).toBe('problema_prenotazione');
    });

    it('dubbio su prezzo o pagamento', () => {
      expect(caso('Parlavi di rate')).toBe('prezzo_o_pagamento');
      expect(caso('Quanto costa esattamente?')).toBe('prezzo_o_pagamento');
    });

    it('lamentela', () => {
      expect(caso('Siete imbarazzanti')).toBe('lamentela');
      expect(caso('Questa è una truffa')).toBe('lamentela');
    });

    it('la richiesta esplicita batte la categoria del contenuto', () => {
      // Contiene sia il prezzo sia la richiesta di una persona: conta la richiesta.
      expect(caso('Vorrei parlare con un operatore per capire il costo')).toBe('chiede_una_persona');
    });

    it('tutte le categorie prodotte stanno nell\'insieme chiuso', () => {
      for (const t of ['Ok', 'Chiamami', 'Siete imbarazzanti', 'Parlavi di rate']) {
        expect(CATEGORIE).toContain(caso(t));
      }
    });
  });
});
