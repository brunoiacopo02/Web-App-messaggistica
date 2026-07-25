import { describe, it, expect } from 'vitest';
import { romeOffset, formatRomeDateTime, sameInstant } from './rome-time';

describe('romeOffset', () => {
  it('estate (DST) → +02:00', () => {
    expect(romeOffset(new Date('2026-06-20T12:00:00Z'))).toBe('+02:00');
  });
  it('inverno → +01:00', () => {
    expect(romeOffset(new Date('2026-01-20T12:00:00Z'))).toBe('+01:00');
  });
});

describe('formatRomeDateTime', () => {
  it('converte un timestamptz UTC (come torna da Postgres) nell\'ora locale di Roma, non in UTC', () => {
    // 13:00 UTC ad agosto (DST, +02:00) sono le 15:00 in Italia: una nota che mostrasse
    // "13:00" farebbe telefonare le Conferme due ore prima dell'orario vero.
    expect(formatRomeDateTime('2026-08-01T13:00:00+00:00')).toBe('sabato 1 agosto alle 15:00');
  });
  it('un fuso locale già corretto (+02:00) resta invariato nell\'orario risultante', () => {
    expect(formatRomeDateTime('2026-08-01T15:00:00+02:00')).toBe('sabato 1 agosto alle 15:00');
  });
  it('inverno (+01:00): nessuno scarto DST spurio', () => {
    expect(formatRomeDateTime('2026-01-20T14:00:00+01:00')).toBe('martedì 20 gennaio alle 14:00');
  });
  it('ISO non parsabile → non esplode, ritorna la stringa originale', () => {
    expect(formatRomeDateTime('non-una-data')).toBe('non-una-data');
  });
});

describe('sameInstant', () => {
  it('stesso istante scritto con offset diversi (UTC dal DB vs locale dal tag) → true', () => {
    expect(sameInstant('2026-08-01T13:00:00+00:00', '2026-08-01T15:00:00+02:00')).toBe(true);
  });
  it('istanti realmente diversi → false', () => {
    expect(sameInstant('2026-08-01T13:00:00+00:00', '2026-08-05T09:00:00+02:00')).toBe(false);
  });
  it('null/undefined su un lato → false, mai un falso "uguale"', () => {
    expect(sameInstant(null, '2026-08-01T13:00:00+00:00')).toBe(false);
    expect(sameInstant('2026-08-01T13:00:00+00:00', undefined)).toBe(false);
    expect(sameInstant(null, null)).toBe(false);
  });
  it('stringa non parsabile su un lato → false, non esplode', () => {
    expect(sameInstant('non-una-data', '2026-08-01T13:00:00+00:00')).toBe(false);
  });
});
