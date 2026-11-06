import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// Il mittente di /api/send-template (06/11/2026): parte dal numero della chat, mai dal
// default ex Serenamente; un `from` forzato vince ma la chat lo segue dopo l'invio.

const PRIMARIO = 'whatsapp:+393520413199';
const X = 'whatsapp:+393522070047';
const SERENAMENTE = 'whatsapp:+393520158061';

vi.mock('@/lib/supabase/admin', () => ({
  getSupabaseAdmin: () => ({ from: () => ({ insert: () => Promise.resolve({ error: null }) }) }),
}));
vi.mock('@/lib/twilio', () => ({ getTemplateBody: async () => null }));

const conv = { waNumber: X as string | null };
const findOrCreate = vi.fn();
const sendAndLog = vi.fn();
const allinea = vi.fn();
vi.mock('@/lib/messaging', () => ({
  findOrCreateLeadConversation: (...a: unknown[]) => findOrCreate(...a),
  sendTemplateAndLog: (...a: unknown[]) => sendAndLog(...a),
  allineaNumeroChat: (...a: unknown[]) => allinea(...a),
}));

import { POST } from './route';

const SID = 'HX' + '0'.repeat(32);
const chiama = (body: Record<string, unknown>) =>
  POST(new NextRequest('https://x/api/send-template', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer s' },
    body: JSON.stringify({ phone: '+393331112222', templateSid: SID, ...body }),
  }));

beforeEach(() => {
  vi.stubEnv('AGENDA_API_SECRET', 's');
  vi.stubEnv('TWILIO_WHATSAPP_NUMBER_FENICE', PRIMARIO);
  vi.stubEnv('TWILIO_WHATSAPP_NUMBER', SERENAMENTE);
  vi.stubEnv('BOT_NUMERI_SECONDARI', X);
  conv.waNumber = X;
  findOrCreate.mockReset().mockImplementation(async () => ({ leadId: 1, conversationId: 7, waNumber: conv.waNumber }));
  sendAndLog.mockReset().mockResolvedValue({ ok: true, sid: 'SM1' });
  allinea.mockReset().mockResolvedValue(null);
});

const fromUsato = () => sendAndLog.mock.calls[0][5];

describe('/api/send-template — da quale numero', () => {
  it('from assente su una chat di X: parte da X, non dal numero ex Serenamente', async () => {
    await chiama({});
    expect(fromUsato()).toBe(X);
    // nascita senza scelta esplicita = primario, mai TWILIO_WHATSAPP_NUMBER
    expect(findOrCreate.mock.calls[0][2]).toEqual({ mittente: undefined });
  });

  it("from 'fenice': il numero della chat", async () => {
    await chiama({ from: 'fenice' });
    expect(fromUsato()).toBe(X);
  });

  it('from assente su una chat senza numero: il primario', async () => {
    conv.waNumber = null;
    await chiama({});
    expect(fromUsato()).toBe(PRIMARIO);
    expect(allinea).toHaveBeenCalledWith(expect.anything(), 7, null, PRIMARIO, 'send-template');
  });

  it('from forzato su una chat di X: parte da Y e la chat passa a Y', async () => {
    await chiama({ from: '+393520413199' });
    expect(fromUsato()).toBe(PRIMARIO);
    expect(allinea).toHaveBeenCalledWith(expect.anything(), 7, X, PRIMARIO, 'send-template');
  });

  it('invio fallito: la chat non si sposta', async () => {
    sendAndLog.mockResolvedValue({ ok: false, error: 'boom' });
    await chiama({ from: '+393520413199' });
    expect(allinea).not.toHaveBeenCalled();
  });

  it('senza primario configurato e chat senza numero: 500, nessun invio dal default', async () => {
    vi.stubEnv('TWILIO_WHATSAPP_NUMBER_FENICE', '');
    conv.waNumber = null;
    const r = await chiama({});
    expect(r.status).toBe(500);
    expect(sendAndLog).not.toHaveBeenCalled();
  });
});
