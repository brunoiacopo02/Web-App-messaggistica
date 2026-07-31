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
    expect(senderLabel('')).toBeNull();
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
  it('regge il formato con microsecondi che restituisce PostgREST', () => {
    // Ancorati alla soglia, non a una data fissa: la costante viene riallineata
    // al momento reale di applicazione della migration a ogni go-live.
    const soglia = Date.parse(SENDER_STIMATO_PRIMA_DI);
    const conMicrosecondi = (ms: number) =>
      new Date(ms).toISOString().replace('Z', '123+00:00');
    expect(senderStimato(conMicrosecondi(soglia - 1000))).toBe(true);
    expect(senderStimato(conMicrosecondi(soglia + 1000))).toBe(false);
  });
});
