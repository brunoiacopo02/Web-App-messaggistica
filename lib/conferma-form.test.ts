import { describe, it, expect } from 'vitest';
import { rispostaAllaVerificaForm, haConfermatoIlForm } from './conferma-form';

// Il bot chiede: "quando hai cliccato su invia, che nome ti è comparso?".
// La pagina di ringraziamento di JotForm mostra "Noemi": il lead lo ricopia.
describe('rispostaAllaVerificaForm', () => {
  it('riconosce le risposte viste davvero in chat', () => {
    for (const b of [
      'Noemi', 'noemi', 'NOEMI', ' Noemi ', 'Noemi.', 'noemi!',
      'Il nome Noemi', 'mi è comparso Noemi', 'è comparso noemi',
      'nome noemi', 'Noemy', 'Noemii', 'Noemi mi è comparso',
    ]) {
      expect(rispostaAllaVerificaForm(b), b).toBe(true);
    }
  });

  it("NON scatta su una frase in cui Noemi è solo nominata", () => {
    for (const b of [
      "Ho provato a telefonare a Noemi fino ad ora ma c'è la segreteria telefonica",
      'chi è Noemi?',
      'Noemi non mi ha chiamato',
      'ok grazie, aspetto la chiamata di Noemi',
      'quando mi chiama Noemi?',
      'Noemi mi ha chiamato ma non ho potuto rispondere',
      'scusa ma Noemi chi è',
    ]) {
      expect(rispostaAllaVerificaForm(b), b).toBe(false);
    }
  });

  it('non scatta su vuoto o testo senza Noemi', () => {
    expect(rispostaAllaVerificaForm(null)).toBe(false);
    expect(rispostaAllaVerificaForm('')).toBe(false);
    expect(rispostaAllaVerificaForm('ok perfetto')).toBe(false);
  });
});

describe('haConfermatoIlForm', () => {
  it('guarda solo i messaggi del lead', () => {
    expect(haConfermatoIlForm([
      { direction: 'out', body: 'Dimmi, quando hai cliccato su invia, che nome ti è comparso?' },
      { direction: 'in', body: 'Noemi' },
    ])).toBe(true);
  });

  it('un "Noemi" scritto dal bot non conta', () => {
    expect(haConfermatoIlForm([
      { direction: 'out', body: 'Noemi è la collega della preselezione' },
      { direction: 'in', body: 'ok' },
    ])).toBe(false);
  });

  it('falso su una chat senza conferma', () => {
    expect(haConfermatoIlForm([{ direction: 'in', body: 'ciao' }])).toBe(false);
  });
});

describe('haConfermatoIlForm col contesto della domanda', () => {
  const domanda = { direction: 'out', body: 'Dimmi, quando hai cliccato su invia, che nome ti è comparso?' };

  it('riconosce le conferme che la sola frase non basta a capire', () => {
    for (const risposta of [
      'Il nome comparso è Noemi.',
      'Fatto, Noemi',
      'Cmq nome NOEMI',
      'Noemi. Ma ho potuto selezionare solamente 17. Non ci sono .30',
      'Ah ok, ho visto, Noemi mi è venuto fuori',
      'Mi è comparso Noemi. Ripeto, spero di non farle perdere tempo',
    ]) {
      expect(haConfermatoIlForm([domanda, { direction: 'in', body: risposta }]), risposta).toBe(true);
    }
  });

  it('senza la domanda del bot, una frase che nomina Noemi non basta', () => {
    expect(haConfermatoIlForm([
      { direction: 'out', body: 'Noemi è la collega della preselezione' },
      { direction: 'in', body: 'ok grazie, aspetto la chiamata di Noemi' },
    ])).toBe(false);
  });

  it('un inbound estraneo dopo la domanda chiude la finestra', () => {
    expect(haConfermatoIlForm([
      domanda,
      { direction: 'in', body: 'scusa un attimo che sono al lavoro' },
      { direction: 'in', body: 'comunque chi è Noemi?' },
    ])).toBe(false);
  });
});
