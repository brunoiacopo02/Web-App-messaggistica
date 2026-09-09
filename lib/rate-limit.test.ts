import { describe, it, expect } from 'vitest';
import { checkRateLimit, _resetRateLimitForTests } from './rate-limit';

describe('checkRateLimit', () => {
  it('permette 60 req/min poi blocca', () => {
    _resetRateLimitForTests();
    for (let i = 0; i < 60; i++) {
      expect(checkRateLimit('ip1', 60, 60_000).ok).toBe(true);
    }
    expect(checkRateLimit('ip1', 60, 60_000).ok).toBe(false);
  });

  it('dice quando riapre la finestra, così il chiamante sa quando ritentare', () => {
    _resetRateLimitForTests();
    const primo = checkRateLimit('ip2', 1, 60_000);
    expect(primo.resetAt).toBeGreaterThan(Date.now());
    const bloccato = checkRateLimit('ip2', 1, 60_000);
    expect(bloccato.ok).toBe(false);
    expect(bloccato.resetAt).toBe(primo.resetAt);
  });

  it('chiavi diverse hanno conteggi separati', () => {
    _resetRateLimitForTests();
    expect(checkRateLimit('a', 1, 60_000).ok).toBe(true);
    expect(checkRateLimit('a', 1, 60_000).ok).toBe(false);
    expect(checkRateLimit('b', 1, 60_000).ok).toBe(true);
  });
});
