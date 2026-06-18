import { describe, it, expect } from 'vitest';
import { signPayload, verifySignature } from './bot-hmac';

const SECRET = 'shh-secret';
const BODY = JSON.stringify({ a: 1, b: 'x' });

describe('bot-hmac', () => {
  it('sign produce prefisso sha256= ed è verificabile', () => {
    const sig = signPayload(BODY, SECRET);
    expect(sig.startsWith('sha256=')).toBe(true);
    expect(verifySignature(BODY, sig, SECRET)).toEqual({ valid: true });
  });

  it('firma mancante → missing_signature', () => {
    expect(verifySignature(BODY, null, SECRET)).toEqual({ valid: false, reason: 'missing_signature' });
  });

  it('prefisso errato → bad_prefix', () => {
    expect(verifySignature(BODY, 'md5=abcd', SECRET)).toEqual({ valid: false, reason: 'bad_prefix' });
  });

  it('lunghezza diversa → length_mismatch', () => {
    expect(verifySignature(BODY, 'sha256=dead', SECRET)).toEqual({ valid: false, reason: 'length_mismatch' });
  });

  it('body manomesso → signature_mismatch', () => {
    const sig = signPayload(BODY, SECRET);
    expect(verifySignature(BODY + ' ', sig, SECRET)).toEqual({ valid: false, reason: 'signature_mismatch' });
  });

  it('secret errato → signature_mismatch', () => {
    const sig = signPayload(BODY, SECRET);
    expect(verifySignature(BODY, sig, 'other')).toEqual({ valid: false, reason: 'signature_mismatch' });
  });
});
