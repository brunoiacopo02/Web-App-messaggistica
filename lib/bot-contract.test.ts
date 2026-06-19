import { describe, it, expect } from 'vitest';
import { isoWithOffset, parseIntakePayload, validateOutcomeBody } from './bot-contract';

describe('isoWithOffset', () => {
  it('accetta offset esplicito', () => {
    expect(isoWithOffset('2026-06-20T15:00:00+02:00')).toBe(true);
    expect(isoWithOffset('2026-06-20T13:00:00Z')).toBe(true);
  });
  it('rifiuta senza fuso', () => {
    expect(isoWithOffset('2026-06-20T15:00:00')).toBe(false);
  });
  it('rifiuta spazzatura', () => {
    expect(isoWithOffset('domani alle 15')).toBe(false);
  });
});

describe('parseIntakePayload', () => {
  const base = { leadId: 'u1', name: 'Mario', phone: '333 123 4567', email: null, funnel: 'badanti', companyId: 'fenice' };
  it('accetta payload valido', () => {
    const r = parseIntakePayload(base);
    expect(r.ok).toBe(true);
  });
  it('rifiuta companyId errato', () => {
    const r = parseIntakePayload({ ...base, companyId: 'altro' });
    expect(r).toEqual({ ok: false, reason: 'forbidden' });
  });
  it('rifiuta leadId mancante', () => {
    const r = parseIntakePayload({ ...base, leadId: '' });
    expect(r).toEqual({ ok: false, reason: 'bad_request' });
  });
  it('rifiuta phone mancante', () => {
    const r = parseIntakePayload({ ...base, phone: '' });
    expect(r).toEqual({ ok: false, reason: 'bad_request' });
  });
});

describe('validateOutcomeBody', () => {
  it('APPUNTAMENTO richiede date con offset', () => {
    expect(validateOutcomeBody({ leadId: 'u1', outcome: 'APPUNTAMENTO' })).toEqual({ ok: false, reason: 'bad_request' });
    expect(validateOutcomeBody({ leadId: 'u1', outcome: 'APPUNTAMENTO', date: '2026-06-20T15:00:00' })).toEqual({ ok: false, reason: 'bad_request' });
    expect(validateOutcomeBody({ leadId: 'u1', outcome: 'APPUNTAMENTO', date: '2026-06-20T15:00:00+02:00' })).toEqual({ ok: true });
  });
  it('DA_SCARTARE non richiede date', () => {
    expect(validateOutcomeBody({ leadId: 'u1', outcome: 'DA_SCARTARE' })).toEqual({ ok: true });
  });
  it('outcome non valido → bad_request', () => {
    expect(validateOutcomeBody({ leadId: 'u1', outcome: 'BOH' as never })).toEqual({ ok: false, reason: 'bad_request' });
  });
});
