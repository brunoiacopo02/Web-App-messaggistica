import { describe, it, expect } from 'vitest';
import { estraiPeriodo } from './periodo-richiamo';

describe('estraiPeriodo', () => {
  it('prende il mese quando il lead lo nomina', () => {
    expect(estraiPeriodo('Ci risentiamo a settembre che ora sono in ferie')).toBe('a settembre');
    expect(estraiPeriodo('richiamami a ottobre')).toBe('a ottobre');
  });

  it('prende la settimana prossima', () => {
    expect(estraiPeriodo('Guarda, meglio la settimana prossima')).toBe('la settimana prossima');
    expect(estraiPeriodo('Sentiamoci la prossima settimana')).toBe('la prossima settimana');
  });

  it('prende "dopo le ferie" e simili', () => {
    expect(estraiPeriodo('Ne parliamo dopo le ferie')).toBe('dopo le ferie');
    expect(estraiPeriodo('Dopo l\'estate ci risentiamo')).toBe("dopo l'estate");
  });

  it('prende "tra N settimane"', () => {
    expect(estraiPeriodo('Mi richiami tra due settimane per favore')).toBe('tra due settimane');
    expect(estraiPeriodo('fra 10 giorni')).toBe('fra 10 giorni');
  });

  it('prende fine e inizio mese', () => {
    expect(estraiPeriodo('Meglio a fine mese')).toBe('a fine mese');
    expect(estraiPeriodo('Il mese prossimo va bene')).toBe('il mese prossimo');
  });

  it('non inventa niente quando il lead non dice quando', () => {
    expect(estraiPeriodo('Ora non posso')).toBeNull();
    expect(estraiPeriodo('Non mi interessa')).toBeNull();
    expect(estraiPeriodo('')).toBeNull();
    expect(estraiPeriodo(undefined)).toBeNull();
  });

  it('non scambia un orario per un periodo', () => {
    // "alle 15" e' un'ora dentro una giornata che non conosciamo: non e' un periodo.
    expect(estraiPeriodo('Richiamami alle 15')).toBeNull();
  });

  it('normalizza spazi e maiuscole ma resta nelle parole del lead', () => {
    expect(estraiPeriodo('Ci  sentiamo   A   SETTEMBRE')).toBe('a settembre');
  });

  it('quando ci sono piu\' espressioni prende la prima', () => {
    expect(estraiPeriodo('a settembre, o magari la settimana prossima')).toBe('a settembre');
  });

  it('taglia le frasi lunghe invece di far viaggiare un tema', () => {
    const p = estraiPeriodo('tra tre settimane circa');
    expect(p).toBe('tra tre settimane');
    expect((p ?? '').length).toBeLessThanOrEqual(60);
  });

  // Fix round 2 (I-2): undici-diciannove non erano nella costante NUMERI. Un lead
  // che scriveva "tra undici giorni" restava senza periodo riconosciuto, e a valle
  // (lib/richiamo-fasce.ts) la conversazione restava `tieni_aperta` anche quando il
  // "quando" era chiaramente oltre la settimana — vedi il test corrispondente in
  // richiamo-fasce.test.ts per l'effetto end-to-end.
  it('prende i numeri a lettere da undici a diciannove, prima mancanti', () => {
    expect(estraiPeriodo('mi richiami tra undici giorni')).toBe('tra undici giorni');
    expect(estraiPeriodo('tra dodici giorni')).toBe('tra dodici giorni');
    expect(estraiPeriodo('fra tredici giorni')).toBe('fra tredici giorni');
    expect(estraiPeriodo('tra quattordici giorni')).toBe('tra quattordici giorni');
    expect(estraiPeriodo('tra sedici giorni')).toBe('tra sedici giorni');
    expect(estraiPeriodo('tra diciassette giorni')).toBe('tra diciassette giorni');
    expect(estraiPeriodo('tra diciotto giorni')).toBe('tra diciotto giorni');
    expect(estraiPeriodo('tra diciannove giorni')).toBe('tra diciannove giorni');
  });

  it('"quindici" e "venti" erano già riconosciuti prima di questo fix', () => {
    expect(estraiPeriodo('tra quindici giorni')).toBe('tra quindici giorni');
    expect(estraiPeriodo('tra venti giorni')).toBe('tra venti giorni');
  });

  it('prende "un paio di" e "qualche" davanti a giorni/settimane/mesi', () => {
    expect(estraiPeriodo('richiamami tra un paio di giorni')).toBe('tra un paio di giorni');
    expect(estraiPeriodo('fra un paio di settimane ci sentiamo')).toBe('fra un paio di settimane');
    expect(estraiPeriodo('tra un paio di mesi')).toBe('tra un paio di mesi');
    expect(estraiPeriodo('ci vediamo fra qualche giorno')).toBe('fra qualche giorno');
    expect(estraiPeriodo('tra qualche settimana')).toBe('tra qualche settimana');
    expect(estraiPeriodo('tra qualche mese')).toBe('tra qualche mese');
  });

  it('non scambia un orario per un periodo, anche dopo l\'estensione dei pattern', () => {
    // Stesso test di prima (riga sopra), ripetuto qui apposta a valle dell'estensione
    // di NUMERI e dei nuovi pattern "un paio di"/"qualche": un'estensione dei pattern
    // di riconoscimento è il punto più a rischio di un falso positivo nuovo.
    expect(estraiPeriodo('Richiamami alle 15')).toBeNull();
    expect(estraiPeriodo('ho un paio di cose da sistemare prima')).toBeNull();
    expect(estraiPeriodo('qualche volta ci penso')).toBeNull();
  });
});
