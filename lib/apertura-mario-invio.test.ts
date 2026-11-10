import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('./twilio', () => ({
  sendTemplate: vi.fn(async () => ({ sid: 'SM1', status: 'queued' })),
  getTemplateBody: vi.fn(async () => null),
}));

import { inviaAperturaMario } from './apertura-mario-invio';
import { sendTemplate } from './twilio';

function fakeSupa() {
  const chain: any = { insert: async () => ({}), update: () => chain, eq: async () => ({}) };
  return { from: () => chain } as any;
}

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe('inviaAperturaMario — lead PROFESSIONI dalla campagna brochure (PO 10/11/2026)', () => {
  it('apertura differita: il neutro legacy anche con le aperture per funnel accese', async () => {
    vi.stubEnv('NEW_OPENING_ENABLED', '1');
    vi.stubEnv('FENICE_OPENING_TEMPLATE_SID', 'HX_OPENING');
    vi.stubEnv('OPENING_SID_C1', 'HX_C1');
    vi.stubEnv('OPENING_SID_C2', 'HX_C2');
    const r = await inviaAperturaMario(fakeSupa(), {
      conversationId: 7, phone: '+393331234567', firstName: 'Ana', funnel: 'PROFESSIONI', from: 'whatsapp:+393520413199',
      logConfigError: async () => {}, logOpeningConfigError: async () => {},
    });
    expect(r).toMatchObject({ ok: true, tentato: true });
    expect(vi.mocked(sendTemplate).mock.calls[0][0]).toMatchObject({ contentSid: 'HX_OPENING' });
  });
  it('gli altri funnel restano sulle aperture per funnel', async () => {
    vi.stubEnv('NEW_OPENING_ENABLED', '1');
    vi.stubEnv('FENICE_OPENING_TEMPLATE_SID', 'HX_OPENING');
    vi.stubEnv('OPENING_SID_T1', 'HX_T1');
    vi.stubEnv('OPENING_SID_T2', 'HX_T2');
    await inviaAperturaMario(fakeSupa(), {
      conversationId: 8, phone: '+393331234567', firstName: 'Ana', funnel: 'TELEGRAM', from: 'whatsapp:+393520413199',
      logConfigError: async () => {}, logOpeningConfigError: async () => {},
    });
    expect(vi.mocked(sendTemplate).mock.calls[0][0].contentSid).not.toBe('HX_OPENING');
  });
});
