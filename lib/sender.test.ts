import { describe, it, expect } from 'vitest';
import { senderLabel, senderStimato, SENDER_STIMATO_PRIMA_DI } from './sender';

describe('senderLabel', () => {
  it('traduce i tre valori', () => {
    expect(senderLabel('bot')).toBe('Mario');
    expect(senderLabel('automazione')).toBe('Automazione');
    expect(senderLabel('operatore')).toBe('Operatore');
  });
  it('niente etichetta per gli inbound e per i valori ignoti', () => {
    expect(senderLabel(null)).toBeNull();
    expect(senderLabel(undefined)).toBeNull();
    expect(senderLabel('marziano')).toBeNull();
  });
});

describe('senderStimato', () => {
  it('prima della soglia: stima', () => {
    expect(senderStimato('2026-07-01T10:00:00+00:00')).toBe(true);
  });
  it('dopo la soglia: dato certo', () => {
    expect(senderStimato('2026-12-31T10:00:00+00:00')).toBe(false);
  });
  it('la soglia è una ISO valida', () => {
    expect(Number.isNaN(Date.parse(SENDER_STIMATO_PRIMA_DI))).toBe(false);
  });
});
