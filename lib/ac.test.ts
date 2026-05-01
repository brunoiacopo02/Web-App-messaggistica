import { describe, it, expect } from 'vitest';
import { parseAcPayload, type AcParsedLead } from './ac';

describe('parseAcPayload', () => {
  it('estrae i campi standard AC dal payload form-encoded', () => {
    const payload = {
      'contact[email]': 'mario@example.com',
      'contact[first_name]': 'Mario',
      'contact[last_name]': 'Rossi',
      'contact[phone]': '3331234567',
      'contact[id]': '12345',
      'list[name]': 'Webinar Marzo',
      'list[id]': '7',
    };
    const out = parseAcPayload(payload);
    expect(out).toEqual<AcParsedLead>({
      email: 'mario@example.com',
      firstName: 'Mario',
      lastName: 'Rossi',
      phone: '3331234567',
      acContactId: '12345',
      listName: 'Webinar Marzo',
      listId: '7',
    });
  });

  it('gestisce payload JSON nested (formato alternativo)', () => {
    const payload = {
      contact: { email: 'a@b.c', first_name: 'A', phone: '+393331234567' },
      list: { name: 'X' },
    };
    const out = parseAcPayload(payload);
    expect(out.email).toBe('a@b.c');
    expect(out.firstName).toBe('A');
    expect(out.phone).toBe('+393331234567');
    expect(out.listName).toBe('X');
  });

  it('campi mancanti diventano null', () => {
    const out = parseAcPayload({ 'contact[email]': 'x@y.z' });
    expect(out.email).toBe('x@y.z');
    expect(out.phone).toBeNull();
    expect(out.firstName).toBeNull();
    expect(out.listName).toBeNull();
  });
});
