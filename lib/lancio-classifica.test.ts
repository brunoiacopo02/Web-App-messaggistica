import { describe, it, expect } from 'vitest';
import { classificaLancio, parseLancioReply } from './lancio-classifica';

describe('classificaLancio — il sì che blocca il posto', () => {
  it.each(['sì', 'si', 'Si!', 'ok', 'Ok grazie', 'certo', 'confermo', 'sono interessato', 'interessata', 'ci sono', 'ci sarò', 'va bene', 'perfetto', 'bloccami il posto', 'ci sto'])(
    '"%s" → si', (b) => expect(classificaLancio(b)).toBe('si'),
  );
  it('un sì lungo più di sei parole non è più un sì secco: decide il modello', () => {
    expect(classificaLancio('si ma non so se riesco quella sera perche lavoro fino tardi')).toBe('incerto');
  });
});

describe('classificaLancio — il no che congeda', () => {
  it.each(['no', 'No grazie', 'non mi interessa', 'non sono interessata', 'toglietemi dalla lista', 'cancellatemi', 'basta messaggi', 'STOP', 'non voglio più ricevere messaggi', 'lasciatemi in pace', 'numero sbagliato', 'non mi sono mai iscritto'])(
    '"%s" → no', (b) => expect(classificaLancio(b)).toBe('no'),
  );
  it('"non vedo l\'ora" NON è un no', () => {
    expect(classificaLancio("non vedo l'ora!")).not.toBe('no');
  });
});

describe('classificaLancio — la domanda', () => {
  it.each(['è a pagamento?', 'Quanto costa', 'a che ora inizia', 'come mi collego?', 'sì, ma è gratis?', 'serve installare zoom?', 'posso partecipare dal telefono'])(
    '"%s" → domanda', (b) => expect(classificaLancio(b)).toBe('domanda'),
  );
  it('un punto di domanda vince sul sì: "si ma quanto dura?" è una domanda', () => {
    expect(classificaLancio('si ma quanto dura?')).toBe('domanda');
  });
});

describe('classificaLancio — incerto va al modello', () => {
  it.each(['', '   ', 'boh', 'vediamo', 'ne parlo con mio marito', 'chi sei', 'ok ma poi come funziona per il resto'])(
    '"%s" → incerto o domanda, mai sì/no', (b) => expect(['incerto', 'domanda']).toContain(classificaLancio(b)),
  );
  it('media senza testo → incerto', () => {
    expect(classificaLancio(null)).toBe('incerto');
    expect(classificaLancio(undefined)).toBe('incerto');
  });
});

describe('parseLancioReply — i tag del modello', () => {
  it('[LANCIO:SI] → classe si, tag rimosso', () => {
    const r = parseLancioReply('Che bello! [LANCIO:SI]');
    expect(r.classe).toBe('si');
    expect(r.visibleReply).toBe('Che bello!');
  });
  it('[LANCIO:NO] → classe no', () => {
    expect(parseLancioReply('Capisco. [LANCIO:NO]').classe).toBe('no');
  });
  it('[LANCIO:DOMANDA] → classe domanda col testo visibile', () => {
    const r = parseLancioReply('È gratuita, tranquillo. [LANCIO:DOMANDA]');
    expect(r).toEqual({ classe: 'domanda', passToHuman: false, visibleReply: 'È gratuita, tranquillo.' });
  });
  it('senza tag → domanda: il modello ha risposto qualcosa, si manda', () => {
    expect(parseLancioReply('Alle 21, su Zoom.').classe).toBe('domanda');
  });
  it('[PASSAGGIO_UMANO] resta possibile e non finisce al lead', () => {
    const r = parseLancioReply('Certo, ti faccio contattare. [PASSAGGIO_UMANO] [LANCIO:DOMANDA]');
    expect(r.passToHuman).toBe(true);
    expect(r.visibleReply).toBe('Certo, ti faccio contattare.');
  });
  it('minuscole e tag in mezzo al testo: comunque puliti', () => {
    const r = parseLancioReply('[lancio:si] Perfetto, ci sei.');
    expect(r.classe).toBe('si');
    expect(r.visibleReply).toBe('Perfetto, ci sei.');
  });
  it('un tag di Mario finito per sbaglio nel testo non arriva al lead', () => {
    expect(parseLancioReply('Ok [ESITO:SCARTO|x] [LANCIO:NO]').visibleReply).toBe('Ok');
  });
});
