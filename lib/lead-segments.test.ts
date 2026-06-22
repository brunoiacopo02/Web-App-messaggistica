import { describe, it, expect } from 'vitest';
import { segmentOf, fermaReason, ACTIVE_WINDOW_MS } from './lead-segments';

const NOW = '2026-06-22T18:00:00.000Z';
const hoursAgo = (h: number) => new Date(Date.parse(NOW) - h * 3600_000).toISOString();

describe('segmentOf', () => {
  it('APPUNTAMENTO vince sempre → PRESO', () => {
    expect(segmentOf({ bot_outcome: 'APPUNTAMENTO', last_inbound_at: null, ai_status: 'closed' }, NOW)).toBe('PRESO');
  });
  it('nessun inbound → MAI_RISPOSTO', () => {
    expect(segmentOf({ bot_outcome: null, last_inbound_at: null, ai_status: 'active' }, NOW)).toBe('MAI_RISPOSTO');
  });
  it('ha risposto da poco e chat viva → ATTIVA', () => {
    expect(segmentOf({ bot_outcome: null, last_inbound_at: hoursAgo(2), ai_status: 'active' }, NOW)).toBe('ATTIVA');
  });
  it('ha risposto oltre 22h → FERMA (silente)', () => {
    expect(segmentOf({ bot_outcome: null, last_inbound_at: hoursAgo(30), ai_status: 'active' }, NOW)).toBe('FERMA');
  });
  it('chat chiusa pur con inbound recente → FERMA', () => {
    expect(segmentOf({ bot_outcome: 'NON_RISPOSTO', last_inbound_at: hoursAgo(1), ai_status: 'closed' }, NOW)).toBe('FERMA');
  });
  it('ai_status: replying e inbound recente → ATTIVA', () => {
    expect(segmentOf({ bot_outcome: null, last_inbound_at: hoursAgo(1), ai_status: 'replying' }, NOW)).toBe('ATTIVA');
  });
  it('ai_status: null e inbound recente, no bot_outcome → FERMA', () => {
    expect(segmentOf({ bot_outcome: null, last_inbound_at: hoursAgo(1), ai_status: null }, NOW)).toBe('FERMA');
  });
  it('boundary: 22h con ai_status active → ATTIVA (inclusive)', () => {
    expect(segmentOf({ bot_outcome: null, last_inbound_at: hoursAgo(22), ai_status: 'active' }, NOW)).toBe('ATTIVA');
  });
  it('boundary: 23h oltre soglia → FERMA', () => {
    expect(segmentOf({ bot_outcome: null, last_inbound_at: hoursAgo(23), ai_status: 'active' }, NOW)).toBe('FERMA');
  });
});

describe('fermaReason', () => {
  it('usa bot_outcome se presente', () => {
    expect(fermaReason({ bot_outcome: 'DA_SCARTARE', last_inbound_at: hoursAgo(1), ai_status: 'closed' }, NOW)).toBe('DA_SCARTARE');
  });
  it('SILENTE se ha risposto ma niente esito e oltre soglia', () => {
    expect(fermaReason({ bot_outcome: null, last_inbound_at: hoursAgo(30), ai_status: 'active' }, NOW)).toBe('SILENTE');
  });
  it('null per segmenti non FERMA', () => {
    expect(fermaReason({ bot_outcome: null, last_inbound_at: hoursAgo(1), ai_status: 'active' }, NOW)).toBeNull();
  });
});

describe('ACTIVE_WINDOW_MS', () => {
  it('è 22 ore', () => {
    expect(ACTIVE_WINDOW_MS).toBe(79_200_000);
  });
});
