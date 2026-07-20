import { describe, it, expect } from 'vitest';
import { decideFollowupAction, GIVEUP_H } from './bot-followups';

const H = 3600_000;
const NOW = Date.parse('2026-06-23T12:00:00Z');
const hAgo = (h: number) => NOW - h * H;

describe('decideFollowupAction — mai risposto', () => {
  it('< 24h → none', () => {
    const a = decideFollowupAction({ startedAtMs: hAgo(2), nowMs: NOW, followupsSent: 0, hasInbound: false, lastInboundAtMs: null });
    expect(a).toBe('none');
  });

  it('12h (ex sollecito_1) → none (nessun sollecito)', () => {
    const a = decideFollowupAction({ startedAtMs: hAgo(12), nowMs: NOW, followupsSent: 0, hasInbound: false, lastInboundAtMs: null });
    expect(a).toBe('none');
  });

  it('22h (ex sollecito_2) → none (nessun sollecito)', () => {
    const a = decideFollowupAction({ startedAtMs: hAgo(22), nowMs: NOW, followupsSent: 1, hasInbound: false, lastInboundAtMs: null });
    expect(a).toBe('none');
  });

  it('≥ 24h → non_risposto', () => {
    const a = decideFollowupAction({ startedAtMs: hAgo(GIVEUP_H), nowMs: NOW, followupsSent: 2, hasInbound: false, lastInboundAtMs: null });
    expect(a).toBe('non_risposto');
  });

  it('> 24h → non_risposto anche con 0 followups inviati', () => {
    const a = decideFollowupAction({ startedAtMs: hAgo(25), nowMs: NOW, followupsSent: 0, hasInbound: false, lastInboundAtMs: null });
    expect(a).toBe('non_risposto');
  });
});

describe('decideFollowupAction — lead terminale (APPUNTAMENTO)', () => {
  it('già APPUNTAMENTO, risposto poi silente ≥24h → none (mai riclassificare un fissato)', () => {
    const a = decideFollowupAction({ startedAtMs: hAgo(60), nowMs: NOW, hasInbound: true, lastInboundAtMs: hAgo(30), botOutcome: 'APPUNTAMENTO' });
    expect(a).toBe('none');
  });

  it('già APPUNTAMENTO, mai risposto ≥24h → none', () => {
    const a = decideFollowupAction({ startedAtMs: hAgo(48), nowMs: NOW, hasInbound: false, lastInboundAtMs: null, botOutcome: 'APPUNTAMENTO' });
    expect(a).toBe('none');
  });

  it('esito non terminale (NON_RISPOSTO) non blocca la classificazione', () => {
    const a = decideFollowupAction({ startedAtMs: hAgo(60), nowMs: NOW, hasInbound: true, lastInboundAtMs: hAgo(GIVEUP_H), botOutcome: 'NON_RISPOSTO' });
    expect(a).toBe('interrotto');
  });
});

describe('decideFollowupAction — ha risposto poi silente', () => {
  it('silente < 24h → none', () => {
    const a = decideFollowupAction({ startedAtMs: hAgo(48), nowMs: NOW, followupsSent: 0, hasInbound: true, lastInboundAtMs: hAgo(10) });
    expect(a).toBe('none');
  });

  it('silente ≥ 24h dall ultimo inbound → interrotto', () => {
    const a = decideFollowupAction({ startedAtMs: hAgo(60), nowMs: NOW, followupsSent: 0, hasInbound: true, lastInboundAtMs: hAgo(GIVEUP_H) });
    expect(a).toBe('interrotto');
  });

  it('hasInbound con lastInboundAtMs null → fallback su startedAt, interrotto se ≥24h', () => {
    const a = decideFollowupAction({ startedAtMs: hAgo(GIVEUP_H), nowMs: NOW, followupsSent: 0, hasInbound: true, lastInboundAtMs: null });
    expect(a).toBe('interrotto');
  });
});
