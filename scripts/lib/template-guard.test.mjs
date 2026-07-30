import { describe, it, expect, vi, afterEach } from 'vitest';
import { assertApprovedUtility } from './template-guard.mjs';

const SID = 'HXtest0000000000000000000000000000';

/** Content API finta: risponde con lo stato di approvazione che le si passa. */
const api = (whatsapp, ok = true) => vi.fn(async () => ({
  ok,
  status: ok ? 200 : 500,
  json: async () => ({ whatsapp }),
}));

const opts = (fetchImpl) => ({ fetchImpl, auth: 'Basic x' });

afterEach(() => { vi.unstubAllEnvs(); });

describe('assertApprovedUtility — il presidio che ferma i template MARKETING', () => {
  it('template approvato UTILITY: passa e restituisce la categoria', async () => {
    const r = await assertApprovedUtility(SID, opts(api({ status: 'approved', category: 'UTILITY', name: 'x_v3' })));
    expect(r).toMatchObject({ category: 'UTILITY', status: 'approved' });
  });

  it('template MARKETING: si ferma prima di spedire, dicendo SID e categoria', async () => {
    await expect(assertApprovedUtility(SID, opts(api({ status: 'approved', category: 'MARKETING', name: 'x_par' }))))
      .rejects.toThrow(/MARKETING/);
    await expect(assertApprovedUtility(SID, opts(api({ status: 'approved', category: 'MARKETING' }))))
      .rejects.toThrow(SID);
  });

  it('template ancora in attesa di Meta: non parte niente', async () => {
    await expect(assertApprovedUtility(SID, opts(api({ status: 'pending', category: 'UTILITY' }))))
      .rejects.toThrow(/pending/);
  });

  // Fail-closed: senza risposta dalla Content API non sappiamo cosa stiamo spedendo,
  // ed è esattamente la situazione in cui il 29/07 è partito il template sbagliato.
  it('Content API irraggiungibile: si ferma, non si spedisce alla cieca', async () => {
    const boom = vi.fn(async () => { throw new Error('ENOTFOUND'); });
    await expect(assertApprovedUtility(SID, opts(boom))).rejects.toThrow(/verifica/i);
  });

  it('risposta HTTP non ok: si ferma', async () => {
    await expect(assertApprovedUtility(SID, opts(api(null, false)))).rejects.toThrow(/verifica/i);
  });

  it('override consapevole: vale solo per il SID scritto per esteso in env', async () => {
    vi.stubEnv('TEMPLATE_GUARD_OVERRIDE', SID);
    const r = await assertApprovedUtility(SID, opts(api({ status: 'approved', category: 'MARKETING' })));
    expect(r).toMatchObject({ category: 'MARKETING', override: true });
  });

  it('override di un altro SID non sblocca questo', async () => {
    vi.stubEnv('TEMPLATE_GUARD_OVERRIDE', 'HXaltro');
    await expect(assertApprovedUtility(SID, opts(api({ status: 'approved', category: 'MARKETING' }))))
      .rejects.toThrow(/MARKETING/);
  });

  it('senza SID non si finge una verifica riuscita', async () => {
    await expect(assertApprovedUtility('', opts(api({ status: 'approved', category: 'UTILITY' }))))
      .rejects.toThrow(/SID/);
  });
});
