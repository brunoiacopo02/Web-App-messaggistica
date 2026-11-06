import { describe, it, expect, vi, beforeEach } from 'vitest';

// /api/messages e /campagne-chat (06/11/2026): l'invio parte dal numero della chat letto
// da `mittenteDiConversazione`, mai dal default ex Serenamente, e la chat segue il numero.

const PRIMARIO = 'whatsapp:+393520413199';
const SERENAMENTE = 'whatsapp:+393520158061';

const riga = { wa_number: null as string | null, last_inbound_at: new Date().toISOString() as string | null };
vi.mock('@/lib/supabase/admin', () => ({
  getSupabaseAdmin: () => ({
    from: () => {
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.eq = () => q;
      q.single = async () => ({ data: { id: 3, ...riga, lead: { phone_e164: '+393331112222' } } });
      q.insert = () => ({ select: () => ({ single: async () => ({ data: { id: 11 } }) }) });
      q.update = () => ({ eq: async () => ({ error: null }) });
      return q;
    },
  }),
}));
const sendFreeText = vi.fn();
vi.mock('@/lib/twilio', () => ({
  sendFreeText: (...a: unknown[]) => sendFreeText(...a),
  sendTemplate: vi.fn(),
  getTemplateBody: vi.fn(),
}));
const allinea = vi.fn();
vi.mock('@/lib/messaging', () => ({ allineaNumeroChat: (...a: unknown[]) => allinea(...a) }));

import { sendConversationMessage } from './conversation-send';

beforeEach(() => {
  vi.stubEnv('TWILIO_WHATSAPP_NUMBER_FENICE', PRIMARIO);
  vi.stubEnv('TWILIO_WHATSAPP_NUMBER', SERENAMENTE);
  riga.wa_number = null;
  sendFreeText.mockReset().mockResolvedValue({ sid: 'SM1', status: 'queued' });
  allinea.mockReset();
});

describe('sendConversationMessage — mittente', () => {
  it('chat senza wa_number: parte dal primario Fenice, non dal numero ex Serenamente', async () => {
    await sendConversationMessage({ conversation_id: 3, mode: 'free', body: 'ciao' } as never);
    expect(sendFreeText.mock.calls[0][0].from).toBe(PRIMARIO);
    expect(allinea).toHaveBeenCalledWith(expect.anything(), 3, null, PRIMARIO, 'operatore-testo');
  });

  it('chat su un numero che non e\' del bot (ex Serenamente): si risponde dal primario', async () => {
    riga.wa_number = SERENAMENTE;
    await sendConversationMessage({ conversation_id: 3, mode: 'free', body: 'ciao' } as never);
    expect(sendFreeText.mock.calls[0][0].from).toBe(PRIMARIO);
  });
});
