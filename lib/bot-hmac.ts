import crypto from 'node:crypto';

const SIGNATURE_PREFIX = 'sha256=';

/** Genera l'header `x-bot-signature` per `rawBody` (la stringa JSON esatta inviata). */
export function signPayload(rawBody: string, secret: string): string {
  const hex = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return `${SIGNATURE_PREFIX}${hex}`;
}

/** Verifica timing-safe della firma ricevuta in `x-bot-signature`. */
export function verifySignature(
  rawBody: string,
  signatureHeader: string | null | undefined,
  secret: string,
): { valid: true } | { valid: false; reason: string } {
  if (!signatureHeader) return { valid: false, reason: 'missing_signature' };
  if (!signatureHeader.startsWith(SIGNATURE_PREFIX)) return { valid: false, reason: 'bad_prefix' };

  const expectedHex = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const providedHex = signatureHeader.slice(SIGNATURE_PREFIX.length);

  const a = Buffer.from(expectedHex, 'hex');
  const b = Buffer.from(providedHex, 'hex');
  if (a.length !== b.length) return { valid: false, reason: 'length_mismatch' };

  return crypto.timingSafeEqual(a, b)
    ? { valid: true }
    : { valid: false, reason: 'signature_mismatch' };
}
