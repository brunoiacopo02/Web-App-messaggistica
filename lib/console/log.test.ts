import { describe, expect, it } from 'vitest';
import { cursoreLog, leggiFiltriLog, queryLog } from './log';

describe('cursoreLog', () => {
  it('tiene i microsecondi di created_at, senza passare da toISOString', () => {
    expect(cursoreLog('2026-09-30T10:00:00.123456+00:00')).toBe('2026-09-30T10:00:00.123456+00:00');
    expect(cursoreLog('2026-09-30T10:00:00.123Z')).toBe('2026-09-30T10:00:00.123Z');
  });

  it('rimette il + dell\'offset arrivato come spazio da una query non codificata', () => {
    expect(cursoreLog('2026-09-30T10:00:00.123456 00:00')).toBe('2026-09-30T10:00:00.123456+00:00');
  });

  it('rifiuta ciò che non è un timestamp', () => {
    expect(cursoreLog('ieri')).toBeNull();
    expect(cursoreLog('2026-09-30T10:00:00.123456+00:00,id.gt.1')).toBeNull();
    expect(cursoreLog('2026-13-40T10:00:00Z')).toBeNull();
  });
});

describe('leggiFiltriLog', () => {
  it('il cursore prima= fa andata e ritorno da queryLog con i microsecondi intatti', () => {
    const cursore = '2026-09-30T10:00:00.123456+00:00';
    const qs = queryLog({ prima: cursore });
    expect(leggiFiltriLog(new URLSearchParams(qs.slice(1)))?.prima).toBe(cursore);
  });
});
