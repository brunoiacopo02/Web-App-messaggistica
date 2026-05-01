import { describe, it, expect, vi, beforeEach } from 'vitest';

const messagesCreate = vi.fn();
vi.mock('twilio', () => ({
  default: () => ({ messages: { create: messagesCreate } }),
  validateRequest: vi.fn(() => true),
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

describe('validateTwilioSignature', () => {
  it('ritorna true se TWILIO_VALIDATE_SIGNATURE=false', async () => {
    process.env.TWILIO_VALIDATE_SIGNATURE = 'false';
    const ok = await validateTwilioSignature({
      url: 'https://x', signature: '', params: {},
    });
    expect(ok).toBe(true);
  });
});
