import { createHmac } from 'node:crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const messagesCreate = vi.fn();
// `validateRequest` simulata: risponde true solo se la firma corrisponde
// DAVVERO al token passato. Con un `() => true` fisso il test sui due account
// non proverebbe niente — accetterebbe anche una firma inventata.
vi.mock('twilio', () => ({
  default: () => ({ messages: { create: messagesCreate } }),
  validateRequest: vi.fn((token: string, signature: string, url: string, params: Record<string, string>) => {
    const base = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
    const atteso = createHmac('sha1', token).update(Buffer.from(base, 'utf-8')).digest('base64');
    return signature === atteso;
  }),
}));

import { sendTemplate, sendFreeText, validateTwilioSignature } from './twilio';

beforeEach(() => {
  messagesCreate.mockReset();
  process.env.TWILIO_ACCOUNT_SID = 'AC_test';
  process.env.TWILIO_AUTH_TOKEN = 'tok_test';
  process.env.TWILIO_WHATSAPP_NUMBER = 'whatsapp:+10000000000';
  process.env.NEXT_PUBLIC_APP_URL = 'https://example.com';
});

describe('sendTemplate', () => {
  it('chiama Twilio con contentSid + variables + statusCallback', async () => {
    messagesCreate.mockResolvedValueOnce({ sid: 'SM123', status: 'queued' });

    const out = await sendTemplate({
      to: '+393331234567',
      contentSid: 'HX1',
      variables: { '1': 'Mario' },
    });

    expect(messagesCreate).toHaveBeenCalledWith({
      from: 'whatsapp:+10000000000',
      to: 'whatsapp:+393331234567',
      contentSid: 'HX1',
      contentVariables: JSON.stringify({ '1': 'Mario' }),
      statusCallback: 'https://example.com/api/webhooks/twilio',
    });
    expect(out).toEqual({ sid: 'SM123', status: 'queued' });
  });

  it('retry su 5xx fino a 2 volte', async () => {
    messagesCreate
      .mockRejectedValueOnce({ status: 503 })
      .mockRejectedValueOnce({ status: 502 })
      .mockResolvedValueOnce({ sid: 'SM_OK', status: 'queued' });

    const out = await sendTemplate({
      to: '+393331234567', contentSid: 'HX1', variables: {},
    }, { backoffMs: () => 0 });

    expect(messagesCreate).toHaveBeenCalledTimes(3);
    expect(out.sid).toBe('SM_OK');
  });

  it('non retry su 4xx', async () => {
    messagesCreate.mockRejectedValueOnce({ status: 400, code: 21211, message: 'Invalid To' });
    await expect(sendTemplate({
      to: '+393331234567', contentSid: 'HX1', variables: {},
    }, { backoffMs: () => 0 })).rejects.toMatchObject({ code: 21211 });
    expect(messagesCreate).toHaveBeenCalledTimes(1);
  });
});

describe('sendFreeText', () => {
  it('invia body libero', async () => {
    messagesCreate.mockResolvedValueOnce({ sid: 'SM_F', status: 'queued' });
    const out = await sendFreeText({ to: '+393331234567', body: 'ciao' });
    expect(messagesCreate).toHaveBeenCalledWith(expect.objectContaining({
      from: 'whatsapp:+10000000000',
      to: 'whatsapp:+393331234567',
      body: 'ciao',
    }));
    expect(out.sid).toBe('SM_F');
  });
});

describe('from override', () => {
  it('sendTemplate usa il from passato', async () => {
    messagesCreate.mockResolvedValueOnce({ sid: 'SM_O', status: 'queued' });
    await sendTemplate({
      to: '+393331234567', contentSid: 'HX1', variables: {}, from: 'whatsapp:+393520413199',
    });
    expect(messagesCreate).toHaveBeenCalledWith(expect.objectContaining({
      from: 'whatsapp:+393520413199',
    }));
  });

  it('sendFreeText usa il from passato', async () => {
    messagesCreate.mockResolvedValueOnce({ sid: 'SM_O2', status: 'queued' });
    await sendFreeText({ to: '+393331234567', body: 'ciao', from: 'whatsapp:+393520413199' });
    expect(messagesCreate).toHaveBeenCalledWith(expect.objectContaining({
      from: 'whatsapp:+393520413199',
    }));
  });
});

describe('presidio categoria (UTILITY_ONLY)', () => {
  const mockCategory = (category: string | null, ok = true) =>
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok, status: ok ? 200 : 500, json: async () => ({ whatsapp: { category } }),
    })));

  beforeEach(() => {
    delete process.env.UTILITY_ONLY;
    delete process.env.UTILITY_ONLY_ALLOW;
    vi.unstubAllGlobals();
  });

  it('spento: spedisce anche un MARKETING senza chiedere nulla a Twilio', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    messagesCreate.mockResolvedValueOnce({ sid: 'SM1', status: 'queued' });
    await sendTemplate({ to: '+393331234567', contentSid: 'HX_mkt_a', variables: {} });
    expect(f).not.toHaveBeenCalled();
    expect(messagesCreate).toHaveBeenCalled();
  });

  it('acceso: blocca il MARKETING e non chiama Twilio', async () => {
    process.env.UTILITY_ONLY = '1';
    mockCategory('MARKETING');
    await expect(
      sendTemplate({ to: '+393331234567', contentSid: 'HX_mkt_b', variables: {} }),
    ).rejects.toThrow(/bloccato: categoria MARKETING/);
    expect(messagesCreate).not.toHaveBeenCalled();
  });

  it('acceso: lascia passare lo UTILITY', async () => {
    process.env.UTILITY_ONLY = '1';
    mockCategory('UTILITY');
    messagesCreate.mockResolvedValueOnce({ sid: 'SM2', status: 'queued' });
    await sendTemplate({ to: '+393331234567', contentSid: 'HX_util_a', variables: {} });
    expect(messagesCreate).toHaveBeenCalled();
  });

  it('acceso: categoria non verificabile → non si spedisce (fail-closed)', async () => {
    process.env.UTILITY_ONLY = '1';
    mockCategory(null, false);
    await expect(
      sendTemplate({ to: '+393331234567', contentSid: 'HX_boh', variables: {} }),
    ).rejects.toThrow(/non verificabile/);
    expect(messagesCreate).not.toHaveBeenCalled();
  });

  it('sblocco per SID esteso in UTILITY_ONLY_ALLOW', async () => {
    process.env.UTILITY_ONLY = '1';
    process.env.UTILITY_ONLY_ALLOW = 'HX_mkt_c, HX_altro';
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    messagesCreate.mockResolvedValueOnce({ sid: 'SM3', status: 'queued' });
    await sendTemplate({ to: '+393331234567', contentSid: 'HX_mkt_c', variables: {} });
    expect(f).not.toHaveBeenCalled();
    expect(messagesCreate).toHaveBeenCalled();
  });
});

describe('validateTwilioSignature', () => {
  it('ritorna true se TWILIO_VALIDATE_SIGNATURE=false', async () => {
    process.env.TWILIO_VALIDATE_SIGNATURE = 'false';
    const ok = await validateTwilioSignature({
      url: 'https://x', signature: '', params: {},
    });
    expect(ok).toBe(true);
  });

  // I numeri WhatsApp stanno su due account Twilio: ognuno firma i propri
  // webhook col proprio token. Validarne uno solo bocciava con 403 tutto cio'
  // che arrivava sul secondo numero — comprese le risposte dopo l'agenda, da
  // cui dipendono video e solleciti.
  describe('due account Twilio', () => {
    const url = 'https://esempio.test/api/webhooks/twilio';
    const params = { MessageSid: 'SM1', Body: 'ciao' };
    /** La firma che Twilio produrrebbe con quel token, per quella richiesta. */
    const firmaCon = (token: string) => {
      const base = url + Object.keys(params).sort()
        .map((k) => k + (params as Record<string, string>)[k]).join('');
      return createHmac('sha1', token).update(Buffer.from(base, 'utf-8')).digest('base64');
    };

    beforeEach(() => {
      process.env.TWILIO_VALIDATE_SIGNATURE = 'true';
      process.env.TWILIO_AUTH_TOKEN = 'token-account-1';
      process.env.TWILIO_AUTH_TOKEN_2 = 'token-account-2';
    });

    it('accetta la firma del primo account', async () => {
      expect(await validateTwilioSignature({ url, signature: firmaCon('token-account-1'), params })).toBe(true);
    });

    it('accetta la firma del secondo account', async () => {
      expect(await validateTwilioSignature({ url, signature: firmaCon('token-account-2'), params })).toBe(true);
    });

    it('rifiuta una firma che non viene da nessuno dei due', async () => {
      expect(await validateTwilioSignature({ url, signature: firmaCon('token-a-caso'), params })).toBe(false);
    });

    it('col secondo token assente il primo continua a funzionare', async () => {
      delete process.env.TWILIO_AUTH_TOKEN_2;
      expect(await validateTwilioSignature({ url, signature: firmaCon('token-account-1'), params })).toBe(true);
    });

    it('senza nessun token rifiuta: mai aprire per mancanza di configurazione', async () => {
      delete process.env.TWILIO_AUTH_TOKEN;
      delete process.env.TWILIO_AUTH_TOKEN_2;
      expect(await validateTwilioSignature({ url, signature: firmaCon('token-account-1'), params })).toBe(false);
    });
  });
});
