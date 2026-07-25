import { describe, it, expect } from 'vitest';
import { buildMarioSystem, MARIO_SYSTEM_PROMPT } from './mario-prompt';

describe('buildMarioSystem', () => {
  it('con "Marta" presenta la persona Marta e non contiene mai "Mario"', () => {
    const p = buildMarioSystem('Marta');
    expect(p).toContain('Sei Marta, consulente di Fenice Academy');
    expect(p).toContain('Presentati come Marta di Fenice Academy');
    expect(p).not.toContain('Mario');
  });

  it('con "Mario" produce esattamente il prompt storico (default invariato)', () => {
    const p = buildMarioSystem('Mario');
    expect(p).toBe(MARIO_SYSTEM_PROMPT);
    expect(p).toContain('Sei Mario, consulente di Fenice Academy');
    expect(p).toContain('Presentati come Mario di Fenice Academy');
  });

  it('cambia SOLO il nome: i due prompt differiscono solo per Mario/Marta', () => {
    const marta = buildMarioSystem('Marta');
    const mario = buildMarioSystem('Mario');
    expect(marta.replace(/Marta/g, 'Mario')).toBe(mario);
  });
});

describe('prezzo', () => {
  const p = buildMarioSystem('Marta');

  it('dice la quota intera e che si può rateizzare', () => {
    expect(p).toContain('dai 1.000 ai 3.000 euro a seconda del percorso');
    expect(p).toContain('si può rateizzare');
    expect(p).toContain('troviamo una soluzione praticamente con tutti');
  });

  it('vieta qualunque cifra di rata o numero di rate', () => {
    expect(p).toContain('MAI CIFRE DI RATA');
    expect(p).not.toMatch(/\d+\s*rate\b/i);
    // L'unica cifra "al mese" ammessa nel prompt è la forbice di guadagno
    // post-corso nella sezione CHI SIAMO. Qualunque altra sarebbe una rata.
    const alMese = p.match(/[\d.]+\s*(?:euro|€)\s*al mese/gi) ?? [];
    expect(alMese).toEqual(['5.000 euro al mese']);
  });

  it('vieta le analogie di frazionamento del prezzo', () => {
    expect(p).toContain('come un caffè al giorno');
    expect(p).toContain('meno di un pacchetto di sigarette');
    expect(p).toMatch(/non fare paragoni tipo/i);
  });

  it('propone la call subito dopo aver detto la quota', () => {
    expect(p).toContain('proponi la call nello stesso giro di messaggi');
  });

  it('lascia fare il conto al lead invece di minimizzare la spesa', () => {
    expect(p).toContain('quanto vale per te arrivarci?');
    expect(p).toContain('Il conto lo deve fare lui');
    expect(p).toMatch(/vietate frasi come "è solo", "è poco", "è un piccolo sacrificio"/);
  });
});

describe('conferme: anticipo e micro-impegni', () => {
  const p = buildMarioSystem('Marta');

  it('anticipa Noemi e il video PRIMA di mandare il link', () => {
    expect(p).toContain('Prima di fissare ti dico come funziona');
    expect(p).toContain('Aspetta il sì, poi manda il link');
  });

  it('fa riscrivere giorno e ora al lead', () => {
    expect(p).toContain('Confermami tu giorno e ora della call');
  });

  it('sul video usa la scelta attiva invece del divieto', () => {
    expect(p).toContain('Quando riesci a vederlo, stasera o domani?');
    expect(p).not.toContain('Non è facoltativo');
    expect(p).not.toContain('non potrà essere effettuato');
  });

  it('chiede un FATTO scritto come conferma della visione', () => {
    expect(p).toContain("Scrivimi FATTO qui quando l'hai visto");
  });

  it('non minaccia il lead sulla chiamata di Noemi', () => {
    expect(p).toContain('Se ti scappa la chiamata non è un problema');
  });
});

describe('comportamento a appuntamento già fissato', () => {
  const p = buildMarioSystem('Marta');

  it('vieta di ripartire col pitch e di riproporre la call', () => {
    expect(p).toContain("SE L'APPUNTAMENTO È GIÀ FISSATO");
    expect(p).toContain('non ripartire col pitch e non riproporre la call');
  });

  it('istruisce a emettere [VIDEO_VISTO] alla conferma del lead', () => {
    expect(p).toContain('[VIDEO_VISTO]');
  });

  it('manda a un umano le richieste di spostamento o disdetta', () => {
    expect(p).toContain('Se vuole spostare o disdire');
  });
});
