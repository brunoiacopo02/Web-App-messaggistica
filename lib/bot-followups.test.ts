import { describe, it, expect } from 'vitest';
import { decideFollowupAction, FOLLOWUP_1_H, GIVEUP_H } from './bot-followups';

const H = 3600_000;
const NOW = Date.parse('2026-06-23T12:00:00Z');
const hAgo = (h: number) => NOW - h * H;

describe('decideFollowupAction — mai risposto (invariato)', () => {
  it('niente da fare prima del primo sollecito', () => {
    const a = decideFollowupAction({ startedAtMs: hAgo(2), nowMs: NOW, followupsSent: 0, hasInbound: false, lastInboundAtMs: null });
    expect(a).toBe('none');
  });
  it('primo sollecito dopo 12h', () => {
    const a = decideFollowupAction({ startedAtMs: hAgo(FOLLOWUP_1_H), nowMs: NOW, followupsSent: 0, hasInbound: false, lastInboundAtMs: null });
    expect(a).toBe('sollecito_1');
  });
  it('NON_RISPOSTO dopo 24h', () => {
    const a = decideFollowupAction({ startedAtMs: hAgo(GIVEUP_H), nowMs: NOW, followupsSent: 2, hasInbound: false, lastInboundAtMs: null });
    expect(a).toBe('non_risposto');
  });
});

describe('decideFollowupAction — ha risposto poi silente', () => {
  it('silente < 24h → none (nessun sollecito, ancora dentro finestra)', () => {
    const a = decideFollowupAction({ startedAtMs: hAgo(48), nowMs: NOW, followupsSent: 0, hasInbound: true, lastInboundAtMs: hAgo(10) });
    expect(a).toBe('none');
  });
  it('silente ≥ 24h dall ultimo inbound → INTERROTTO', () => {
    const a = decideFollowupAction({ startedAtMs: hAgo(60), nowMs: NOW, followupsSent: 0, hasInbound: true, lastInboundAtMs: hAgo(GIVEUP_H) });
    expect(a).toBe('interrotto');
  });
});
