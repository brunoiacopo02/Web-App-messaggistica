import { describe, it, expect, vi, afterEach } from 'vitest';
import { sidSbloccati } from './template-sbloccati';
import { martaSidsFromEnv } from './fenice-autoreply';
import { personaForConversation, OPENING_ENV_KEYS } from './persona';
import { ENV_KEYS_DATABASE } from './database-bot';

afterEach(() => { vi.unstubAllEnvs(); });

describe('SID delle aperture database: sblocco MARKETING e set "Marta"', () => {
  it('senza le env database lo sblocco e\' quello di prima', () => {
    for (const k of ENV_KEYS_DATABASE) vi.stubEnv(k, '');
    vi.stubEnv('UTILITY_ONLY_ALLOW', 'HXuno, HXdue');
    vi.stubEnv('LANCIO_SCELTA_NOTTE_TEMPLATE_SID', '');
    vi.stubEnv('LANCIO_SCELTA_GIORNO_TEMPLATE_SID', '');
    vi.stubEnv('LANCIO_FOLLOWUP_MARKETING_SID', '');
    vi.stubEnv('BF_OPENING_TEMPLATE_SID', 'HXbf');
    vi.stubEnv('SOLLECITO_PARCHEGGIO_SID', '');
    expect(sidSbloccati()).toEqual(['HXuno', 'HXdue', 'HXbf']);
  });

  it('con le env i cinque SID sono sbloccati (MARKETING voluto)', () => {
    ENV_KEYS_DATABASE.forEach((k, i) => vi.stubEnv(k, `HXdb${i}`));
    const s = sidSbloccati();
    for (let i = 0; i < 5; i++) expect(s).toContain(`HXdb${i}`);
  });

  it('senza le env database il set "Marta" e\' quello di prima', () => {
    const env = Object.fromEntries(OPENING_ENV_KEYS.map((k, i) => [k, `SID_${i}`])) as NodeJS.ProcessEnv;
    expect(martaSidsFromEnv(env).size).toBe(12);
  });

  it('una chat aperta con un template database prosegue come Marta', () => {
    const sids = martaSidsFromEnv({ DATABASE_OPENING_SID_C: 'HXdbc' } as unknown as NodeJS.ProcessEnv);
    expect(sids.has('HXdbc')).toBe(true);
    expect(personaForConversation(
      [{ direction: 'out', template_sid: 'HXdbc' }, { direction: 'in', template_sid: null }], sids,
    )).toBe('marta');
  });
});
