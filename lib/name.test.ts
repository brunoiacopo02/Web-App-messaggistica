import { describe, it, expect } from 'vitest';
import { firstNameOf, templateName } from './name';

describe('firstNameOf', () => {
  it('prende solo il nome quando arriva nome e cognome', () => {
    expect(firstNameOf('Mario Rossi')).toBe('Mario');
  });

  it('prende il primo token anche con nomi composti o più cognomi', () => {
    expect(firstNameOf('Maria Grazia De Luca')).toBe('Maria');
  });

  it('normalizza il maiuscolo urlato', () => {
    expect(firstNameOf('MARIO ROSSI')).toBe('Mario');
  });

  it('normalizza il tutto minuscolo', () => {
    expect(firstNameOf('mario rossi')).toBe('Mario');
  });

  it('mantiene le maiuscole interne di apostrofi e trattini', () => {
    expect(firstNameOf("d'angelo")).toBe("D'Angelo");
    expect(firstNameOf('MARIA-CHIARA verdi')).toBe('Maria-Chiara');
  });

  it('conserva gli accenti', () => {
    expect(firstNameOf('nicolò bianchi')).toBe('Nicolò');
  });

  it('ignora spazi e punteggiatura attorno al nome', () => {
    expect(firstNameOf('  anna,  ')).toBe('Anna');
  });

  it('rifiuta un indirizzo email nel campo nome', () => {
    expect(firstNameOf('mario.rossi@gmail.com')).toBeNull();
  });

  it('rifiuta numeri di telefono e token senza lettere', () => {
    expect(firstNameOf('3480300004')).toBeNull();
    expect(firstNameOf('123 rossi')).toBeNull();
  });

  it('rifiuta token troppo corti', () => {
    expect(firstNameOf('A')).toBeNull();
    expect(firstNameOf('.')).toBeNull();
  });

  it('rifiuta segnaposto e ragioni sociali', () => {
    expect(firstNameOf('test')).toBeNull();
    expect(firstNameOf('TEST TEST')).toBeNull();
    expect(firstNameOf('Rossi srl')).toBeNull();
    expect(firstNameOf('cliente')).toBeNull();
  });

  it('rifiuta valori vuoti o assenti', () => {
    expect(firstNameOf(null)).toBeNull();
    expect(firstNameOf(undefined)).toBeNull();
    expect(firstNameOf('   ')).toBeNull();
  });

  it('è idempotente su un nome già pulito', () => {
    expect(firstNameOf(firstNameOf('Mario Rossi'))).toBe('Mario');
  });
});

describe('templateName', () => {
  it('usa il nome quando è valido', () => {
    expect(templateName('Mario Rossi')).toBe('Mario');
  });

  it('usa un vocativo neutro quando il nome non è utilizzabile', () => {
    // I template Meta hanno "Ciao {{1}}," nel body: la variabile non può essere
    // vuota, e "benvenuto" sbagliava il genere. "a te" regge in ogni caso.
    expect(templateName('mario.rossi@gmail.com')).toBe('a te');
    expect(templateName(null)).toBe('a te');
  });
});
