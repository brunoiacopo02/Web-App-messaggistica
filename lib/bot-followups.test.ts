import { describe, it, expect } from 'vitest';
import { decideFollowupAction } from './bot-followups';

const H = 3600_000;
const start = 0;

describe('decideFollowupAction', () => {
  it('lead che ha risposto → none', () => {
    expect(decideFollowupAction({ startedAtMs: start, nowMs: 5 * H, followupsSent: 0, hasInbound: true })).toBe('none');
  });
  it('prima di 12h → none', () => {
    expect(decideFollowupAction({ startedAtMs: start, nowMs: 10 * H, followupsSent: 0, hasInbound: false })).toBe('none');
  });
  it('>=12h e nessun sollecito → sollecito_1', () => {
    expect(decideFollowupAction({ startedAtMs: start, nowMs: 13 * H, followupsSent: 0, hasInbound: false })).toBe('sollecito_1');
  });
  it('>=22h e 1 sollecito → sollecito_2', () => {
    expect(decideFollowupAction({ startedAtMs: start, nowMs: 23 * H, followupsSent: 1, hasInbound: false })).toBe('sollecito_2');
  });
  it('a 24h chiude con non_risposto', () => {
    expect(decideFollowupAction({ startedAtMs: start, nowMs: 24 * H, followupsSent: 2, hasInbound: false })).toBe('non_risposto');
  });
  it('oltre 24h chiude anche con un solo sollecito inviato (niente testo libero tardivo)', () => {
    expect(decideFollowupAction({ startedAtMs: start, nowMs: 25 * H, followupsSent: 1, hasInbound: false })).toBe('non_risposto');
  });
  it('oltre 24h chiude anche se nessun sollecito è partito (lead mai raggiunto)', () => {
    expect(decideFollowupAction({ startedAtMs: start, nowMs: 25 * H, followupsSent: 0, hasInbound: false })).toBe('non_risposto');
  });
});
