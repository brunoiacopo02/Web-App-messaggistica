import { describe, it, expect } from 'vitest';
import { toE164, isValidE164 } from './phone';

describe('toE164', () => {
  it('aggiunge +39 a numero italiano senza prefisso', () => {
    expect(toE164('3331234567')).toBe('+393331234567');
    expect(toE164('333 123 4567')).toBe('+393331234567');
    expect(toE164('333-123-4567')).toBe('+393331234567');
  });

  it('mantiene il +39 se già presente', () => {
    expect(toE164('+393331234567')).toBe('+393331234567');
    expect(toE164('+39 333 123 4567')).toBe('+393331234567');
  });

  it('mantiene altri prefissi internazionali', () => {
    expect(toE164('+447911123456')).toBe('+447911123456');
    expect(toE164('+14155551234')).toBe('+14155551234');
  });

  it('gestisce 0039 trasformandolo in +39', () => {
    expect(toE164('00393331234567')).toBe('+393331234567');
  });

  it('rimuove caratteri di formattazione', () => {
    expect(toE164('(333) 123-4567')).toBe('+393331234567');
  });

  it('ritorna null per input invalidi', () => {
    expect(toE164('')).toBeNull();
    expect(toE164(null)).toBeNull();
    expect(toE164(undefined)).toBeNull();
    expect(toE164('abc')).toBeNull();
    expect(toE164('123')).toBeNull(); // troppo corto
  });

  it('strip whatsapp: prefix Twilio', () => {
    expect(toE164('whatsapp:+393331234567')).toBe('+393331234567');
  });
});

describe('isValidE164', () => {
  it('accetta numeri E.164 validi', () => {
    expect(isValidE164('+393331234567')).toBe(true);
    expect(isValidE164('+14155551234')).toBe(true);
  });
  it('rifiuta non E.164', () => {
    expect(isValidE164('3331234567')).toBe(false);
    expect(isValidE164('+0123')).toBe(false);
    expect(isValidE164('')).toBe(false);
  });
});
