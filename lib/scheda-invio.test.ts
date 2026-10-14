import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('./twilio', () => ({ sendFreeText: vi.fn(async () => ({ sid: 'SM1', status: 'queued' })) }));
import { sendFreeText } from './twilio';
import { inviaScheda, testoScheda } from './scheda-invio';

function supa(claimRows: unknown[]) {
  const inserts: Array<[string, unknown]> = [];
  const updates: unknown[] = [];
  const chain = {
    update: (v: unknown) => { updates.push(v); return chain; },
    eq: () => chain, is: () => chain,
    select: async () => ({ data: claimRows, error: null }),
  };
  return {
    inserts, updates,
    from: (t: string) => (t === 'conversations' ? chain : { insert: async (v: unknown) => { inserts.push([t, v]); return { error: null }; } }),
  };
}

beforeEach(() => { process.env.NEXT_PUBLIC_APP_URL = 'https://bot.app'; vi.mocked(sendFreeText).mockClear(); });

describe('inviaScheda', () => {
  it('prima volta: manda il PDF e registra messaggio ed evento', async () => {
    const s = supa([{ id: 1 }]);
    const r = await inviaScheda(s as never, { conversationId: 1, phone: '+39333', from: 'whatsapp:+393520413199', slug: 'copywriter', momento: 'post_appuntamento' });
    expect(r).toBe('inviata');
    expect(sendFreeText).toHaveBeenCalledWith({ to: '+39333', from: 'whatsapp:+393520413199', body: testoScheda('copywriter'), mediaUrl: ['https://bot.app/schede/copywriter.pdf'] });
    expect(s.inserts.map(([t]) => t)).toEqual(['messages', 'event_log']);
  });
  it('gia\' inviata: niente invio', async () => {
    const s = supa([]);
    expect(await inviaScheda(s as never, { conversationId: 1, phone: '+39333', from: 'x', slug: 'copywriter', momento: 'post_appuntamento' })).toBe('gia_inviata');
    expect(sendFreeText).not.toHaveBeenCalled();
  });
  it('Twilio fallisce: rilascia il lucchetto e logga', async () => {
    vi.mocked(sendFreeText).mockRejectedValueOnce(new Error('boom'));
    const s = supa([{ id: 1 }]);
    expect(await inviaScheda(s as never, { conversationId: 1, phone: '+39333', from: 'x', slug: 'copywriter', momento: 'pre_appuntamento' })).toBe('fallita');
    expect(s.updates).toContainEqual({ scheda_inviata_at: null });
    expect(s.inserts.some(([t, v]) => t === 'event_log' && (v as { type: string }).type === 'scheda_invio_fallito')).toBe(true);
  });
});
