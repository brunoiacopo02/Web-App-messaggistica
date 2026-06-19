import { describe, it, expect } from 'vitest';
import { romeOffset } from './rome-time';

describe('romeOffset', () => {
  it('estate (DST) → +02:00', () => {
    expect(romeOffset(new Date('2026-06-20T12:00:00Z'))).toBe('+02:00');
  });
  it('inverno → +01:00', () => {
    expect(romeOffset(new Date('2026-01-20T12:00:00Z'))).toBe('+01:00');
  });
});
