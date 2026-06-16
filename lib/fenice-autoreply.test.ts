import { describe, it, expect } from 'vitest';
import { shouldAutoReply } from './fenice-autoreply';

describe('shouldAutoReply', () => {
  const ok = {
    toMatchesFenice: true, autoReplyOn: true, aiOwner: 'mario', aiStatus: 'active',
  };
  it('vero quando tutte le condizioni valgono', () => {
    expect(shouldAutoReply(ok)).toBe(true);
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
