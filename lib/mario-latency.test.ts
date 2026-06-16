import { describe, it, expect } from 'vitest';
import { marioDelayMs, MARIO_MIN_DELAY_MS, MARIO_MAX_DELAY_MS } from './mario-latency';

describe('marioDelayMs', () => {
  it('rand=0 -> minimo', () => {
    expect(marioDelayMs(() => 0)).toBe(MARIO_MIN_DELAY_MS);
  });

  it('rand~1 -> vicino al massimo (sotto il cap)', () => {
    const d = marioDelayMs(() => 0.999999);
    expect(d).toBeLessThan(MARIO_MAX_DELAY_MS);
    expect(d).toBeGreaterThan(MARIO_MAX_DELAY_MS - 100);
  });

  it('sempre dentro [min, max]', () => {
    for (let i = 0; i < 200; i++) {
      const d = marioDelayMs();
      expect(d).toBeGreaterThanOrEqual(MARIO_MIN_DELAY_MS);
      expect(d).toBeLessThanOrEqual(MARIO_MAX_DELAY_MS);
    }
  });
});
