import { describe, it, expect } from 'vitest';
import { parseHoldoutGdo, braccioHoldout, secchielloHoldout } from './holdout-gdo';

describe('parseHoldoutGdo', () => {
  it('spento di default', () => {
    expect(parseHoldoutGdo(null)).toBeNull();
    expect(parseHoldoutGdo({ attivo: false, percentuale: 50, dal: '2026-11-07' })).toBeNull();
    expect(parseHoldoutGdo({ attivo: true, percentuale: 50 })).toBeNull();
  });
  it('acceso, default 50', () => {
    expect(parseHoldoutGdo({ attivo: true, dal: '2026-11-07' })).toEqual({ percentuale: 50, dal: '2026-11-07' });
  });
});

describe('braccioHoldout', () => {
  const cfg = { percentuale: 50, dal: '2026-11-07' };
  it("stabile e circa meta' / meta'", () => {
    let h = 0;
    for (let id = 1; id <= 10000; id++) if (braccioHoldout(cfg, id, '2026-11-08T10:00:00Z') === 'holdout') h++;
    expect(h).toBeGreaterThan(4700);
    expect(h).toBeLessThan(5300);
    expect(braccioHoldout(cfg, 1234, '2026-11-08T10:00:00Z')).toBe(braccioHoldout(cfg, 1234, '2026-11-09T10:00:00Z'));
    expect(secchielloHoldout(1234)).toBe(secchielloHoldout(1234));
  });
  it('fuori test: chat GDO prima di dal, senza agenda, holdout spento', () => {
    expect(braccioHoldout(cfg, 1, '2026-11-06T10:00:00Z')).toBeNull();
    expect(braccioHoldout(cfg, 1, null)).toBeNull();
    expect(braccioHoldout(null, 1, '2026-11-08T10:00:00Z')).toBeNull();
  });
});
