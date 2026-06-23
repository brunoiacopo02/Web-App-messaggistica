import { describe, it, expect } from 'vitest';
import { shouldAutoReply, nextUnansweredInboundIndex, lastIsUnansweredInbound } from './fenice-autoreply';

describe('shouldAutoReply', () => {
  const ok = { toMatchesFenice: true, autoReplyOn: true, aiOwner: 'mario', aiStatus: 'active' };
  it('vero quando tutte le condizioni valgono (active)', () => {
    expect(shouldAutoReply(ok)).toBe(true);
  });
  it('vero anche se sta già rispondendo (replying) — il lock serializza', () => {
    expect(shouldAutoReply({ ...ok, aiStatus: 'replying' })).toBe(true);
  });
  it('falso se il numero non è Fenice', () => {
    expect(shouldAutoReply({ ...ok, toMatchesFenice: false })).toBe(false);
  });
  it('falso se lo switch è spento', () => {
    expect(shouldAutoReply({ ...ok, autoReplyOn: false })).toBe(false);
  });
  it('falso se non è gestita da Mario', () => {
    expect(shouldAutoReply({ ...ok, aiOwner: null })).toBe(false);
  });
  it('falso se handed_off o booked', () => {
    expect(shouldAutoReply({ ...ok, aiStatus: 'handed_off' })).toBe(false);
    expect(shouldAutoReply({ ...ok, aiStatus: 'booked' })).toBe(false);
  });
});

describe('nextUnansweredInboundIndex', () => {
  it('nessun messaggio -> -1', () => {
    expect(nextUnansweredInboundIndex([])).toBe(-1);
  });
  it('solo outbound (apertura) -> -1', () => {
    expect(nextUnansweredInboundIndex([{ direction: 'out', body: 'ciao' }])).toBe(-1);
  });
  it('primo inbound dopo l ultimo outbound', () => {
    const rows = [
      { direction: 'out', body: 'apertura' },
      { direction: 'in', body: 'msg1' },
      { direction: 'in', body: 'msg2' },
    ];
    expect(nextUnansweredInboundIndex(rows)).toBe(1);
  });
  it('tutti gli inbound già risposti -> -1', () => {
    const rows = [
      { direction: 'out', body: 'apertura' },
      { direction: 'in', body: 'msg1' },
      { direction: 'out', body: 'risposta1' },
    ];
    expect(nextUnansweredInboundIndex(rows)).toBe(-1);
  });
  it('inbound nuovo dopo una risposta', () => {
    const rows = [
      { direction: 'in', body: 'msg1' },
      { direction: 'out', body: 'risposta1' },
      { direction: 'in', body: 'msg2' },
    ];
    expect(nextUnansweredInboundIndex(rows)).toBe(2);
  });
});

describe('lastIsUnansweredInbound', () => {
  it('(a) ultimo messaggio inbound dopo un outbound → true', () => {
    const rows = [
      { direction: 'out', body: 'apertura' },
      { direction: 'in', body: 'risposta lead' },
    ];
    expect(lastIsUnansweredInbound(rows)).toBe(true);
  });
  it('(b) ultimo messaggio outbound → false', () => {
    const rows = [
      { direction: 'out', body: 'apertura' },
      { direction: 'in', body: 'msg1' },
      { direction: 'out', body: 'risposta bot' },
    ];
    expect(lastIsUnansweredInbound(rows)).toBe(false);
  });
  it('(c) array vuoto → false', () => {
    expect(lastIsUnansweredInbound([])).toBe(false);
  });
  it('(d) solo inbound senza outbound → true', () => {
    const rows = [
      { direction: 'in', body: 'primo messaggio lead' },
    ];
    expect(lastIsUnansweredInbound(rows)).toBe(true);
  });
});
