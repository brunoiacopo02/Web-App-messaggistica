import { describe, it, expect } from 'vitest';
import { config } from './proxy';

// Il matcher di Next e' una regex sul percorso: la ricostruiamo dalla stessa stringa.
const matcher = new RegExp(`^${config.matcher[0]}$`);

describe('proxy matcher', () => {
  it('lascia passare le schede PDF senza sessione (Twilio le scarica senza login)', () => {
    expect(matcher.test('/schede/copywriter.pdf')).toBe(false);
  });

  it('continua a proteggere le pagine', () => {
    expect(matcher.test('/dashboard')).toBe(true);
  });
});
