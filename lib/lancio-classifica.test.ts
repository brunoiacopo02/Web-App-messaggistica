import { describe, it, expect } from 'vitest';
import { classificaLancio, congedoEsplicito, parseLancioReply } from './lancio-classifica';

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
  it.each(['certo che no', 'assolutamente no', 'no, assolutamente', 'ok no', "no grazie, magari un'altra volta"])(
    'un "no" isolato in mezzo a una parola da sì non diventa mai si: "%s" → no', (b) => expect(classificaLancio(b)).toBe('no'),
  );
  it('"non lo so" resta incerto (non è un "no" isolato, "non" non è "no")', () => {
    expect(['incerto', 'domanda']).toContain(classificaLancio('non lo so'));
    expect(classificaLancio('non lo so')).not.toBe('si');
  });
});

describe('classificaLancio — "no" in apertura: solo un rifiuto vero forza il no', () => {
  it.each(['no, assolutamente', 'no grazie', 'no non mi interessa', 'no'])(
    '"%s" → no (il resto resta un rifiuto)', (b) => expect(classificaLancio(b)).toBe('no'),
  );
  it.each(['no ma sono interessato', 'no dai, in realtà mi interessa'])(
    '"%s" → incerto (il resto non è un rifiuto: avversativo o segnale da sì)', (b) => expect(classificaLancio(b)).toBe('incerto'),
  );
});

describe('classificaLancio — la domanda', () => {
  it.each(['è a pagamento?', 'Quanto costa', 'a che ora inizia', 'come mi collego?', 'sì, ma è gratis?', 'serve installare zoom?', 'posso partecipare dal telefono'])(
    '"%s" → domanda', (b) => expect(classificaLancio(b)).toBe('domanda'),
  );
  it('un punto di domanda vince sul sì: "si ma quanto dura?" è una domanda', () => {
    expect(classificaLancio('si ma quanto dura?')).toBe('domanda');
  });
  it('un punto di domanda vince anche su un "no": "no? e quando sarebbe?" è una domanda', () => {
    expect(classificaLancio('no? e quando sarebbe?')).toBe('domanda');
  });
});

describe('classificaLancio — il "no" isolato non è un martello: solo in testa o in coda', () => {
  it('"no problem, ci sono!" è un sì: "no problem" è un idioma, non una negazione', () => {
    expect(classificaLancio('no problem, ci sono!')).toBe('si');
  });
  it('"nessun problema, ci sono" è un sì: "nessun problema" è un idioma, non una negazione', () => {
    expect(classificaLancio('nessun problema, ci sono')).toBe('si');
  });
  it('"sì sì, no aspetta, va bene": il "no" in mezzo alla frase è ambiguo, mai un sì (né un no automatico)', () => {
    expect(classificaLancio('sì sì, no aspetta, va bene')).toBe('incerto');
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
  it('[passaggio_umano] minuscolo: rilevato e non arriva al lead', () => {
    const r = parseLancioReply('Ok. [passaggio_umano] [LANCIO:DOMANDA]');
    expect(r.passToHuman).toBe(true);
    expect(r.visibleReply).toBe('Ok.');
  });
  it('tag da solo sulla sua riga: niente riga vuota nel testo visibile', () => {
    const r = parseLancioReply('Riga1\n[LANCIO:SI]\nRiga2');
    expect(r.visibleReply).toBe('Riga1\nRiga2');
  });
  it('tag fra righe vuote: comunque niente righe vuote', () => {
    const r = parseLancioReply('Riga1\n\n[LANCIO:SI]\n\nRiga2');
    expect(r.visibleReply).toBe('Riga1\nRiga2');
  });
});

describe('congedoEsplicito — solo le frasi di rifiuto, mai il "no" secco', () => {
  it.each(['non mi interessa', 'non mi interessa più', 'toglimi dalla lista', 'non scrivermi più', 'no grazie', 'numero sbagliato'])(
    '"%s" → congedo', (b) => expect(congedoEsplicito(b)).toBe(true),
  );
  // Sono tutti "no" che `classificaLancio` legge come no: in assistenza sono la risposta
  // a una domanda del bot, e lì il congedo non lo devono far scattare.
  it.each(['no', 'No', 'nope', 'nah', 'certo che no', 'assolutamente no'])(
    '"%s" → non è un congedo', (b) => expect(congedoEsplicito(b)).toBe(false),
  );
  it('vuoto e media: falso, mai un congedo', () => {
    expect(congedoEsplicito('')).toBe(false);
    expect(congedoEsplicito(null)).toBe(false);
    expect(congedoEsplicito('👍')).toBe(false);
  });
});
