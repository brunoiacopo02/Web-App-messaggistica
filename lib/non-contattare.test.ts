import { describe, expect, it } from 'vitest';
import { chiedeDiNonEssereContattato } from './non-contattare';

describe('chiedeDiNonEssereContattato (PO 12/11/2026)', () => {
  it.each([
    // chat 32198, col refuso com'è arrivato
    'Allora oggi non posso dato che insistete non voglio più essere contatta',
    'non voglio più essere contattata',
    'Non voglio essere più chiamato',
    'non desidero essere contattato più',
    'Non contattatemi più',
    'non mi chiamate più',
    'NON CHIAMATEMI MAI PIÙ',
    'per favore non mi cercate più',
    'non mi dovete più chiamare',
    'al momento non sono più interessata, non contattarmi più',
    'non voglio più ricevere chiamate',
    'Cancella pure il mio contatto.',
    'cancellate il mio numero grazie',
    'toglietemi dalla lista',
    'vi chiedo di eliminare i miei dati',
  ])('sì: «%s»', (t) => expect(chiedeDiNonEssereContattato(t)).toBe(true));

  it.each([
    // il formato della call, non un addio (manuale: NON È UNA RICHIESTA DI PASSAGGIO)
    'non voglio essere chiamato',
    'Posso chiedere di non ricevere la chiamata ?',
    'non rispondo alle telefonate',
    // solo i messaggi del bot: decide il giudice leggendo la chat
    'ho già un appuntamento con Noemi domani, non rispondermi più',
    'non scrivermi più',
    // «più» che non c'entra col contatto
    'non mi chiamate più tardi delle 18',
    'non voglio essere chiamata più tardi',
    'non cerco più lavoro',
    'non mi sento più sicura',
    'non sono più interessato',
    'non posso più partecipare',
    // disdette e spostamenti normali
    'annullate la chiamata',
    'oggi non posso, possiamo fare domani?',
    'vi ricontatto io',
    'cancellate la call di domani',
    'cancella l\'appuntamento',
    '',
  ])('no: «%s»', (t) => expect(chiedeDiNonEssereContattato(t)).toBe(false));

  it('più messaggi dello stesso turno uniti', () => {
    expect(chiedeDiNonEssereContattato(['Cancello la chiamata', 'In questo momento non ho tempo', 'Non contattatemi più'].join(' / '))).toBe(true);
    expect(chiedeDiNonEssereContattato(null)).toBe(false);
  });
});
