import { describe, it, expect } from 'vitest';
import { decideFollowupAction } from './bot-followups';

const H = 3600_000;
const start = 0;

describe('decideFollowupAction', () => {
  it('lead che ha risposto → none', () => {
    expect(decideFollowupAction({ startedAtMs: start, nowMs: 50 * H, followupsSent: 0, hasInbound: true })).toBe('none');
  });
  it('prima di 18h → none', () => {
    expect(decideFollowupAction({ startedAtMs: start, nowMs: 10 * H, followupsSent: 0, hasInbound: false })).toBe('none');
  });
  it('>=18h e nessun sollecito → sollecito_1', () => {
    expect(decideFollowupAction({ startedAtMs: start, nowMs: 20 * H, followupsSent: 0, hasInbound: false })).toBe('sollecito_1');
  });
  it('>=36h e 1 sollecito → sollecito_2', () => {
    expect(decideFollowupAction({ startedAtMs: start, nowMs: 37 * H, followupsSent: 1, hasInbound: false })).toBe('sollecito_2');
  });
  it('>=48h e 2 solleciti → non_risposto', () => {
    expect(decideFollowupAction({ startedAtMs: start, nowMs: 49 * H, followupsSent: 2, hasInbound: false })).toBe('non_risposto');
  });
  it('48h ma solo 1 sollecito → sollecito_2 (recupero)', () => {
    expect(decideFollowupAction({ startedAtMs: start, nowMs: 49 * H, followupsSent: 1, hasInbound: false })).toBe('sollecito_2');
  });
});
