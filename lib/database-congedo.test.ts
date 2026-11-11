import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./twilio', () => ({ sendFreeText: vi.fn(async () => ({ sid: 'SMcongedo', status: 'queued' })) }));
vi.mock('./bot-outcome', () => ({ sendOutcome: vi.fn(async () => ({ sent: true, status: 200 })) }));

import { congedoDatabase } from './database-congedo';
import { sendFreeText } from './twilio';
import { sendOutcome } from './bot-outcome';
import { EVENTO_DATABASE_NON_INTERESSA, TESTO_CONGEDO_DATABASE } from './database-bot';

function supa() {
  const scritture: { table: string; op: string; arg: any }[] = [];
  const s = {
    from: (table: string) => ({
      insert: (arg: any) => { scritture.push({ table, op: 'insert', arg }); return Promise.resolve({ error: null }); },
      update: (arg: any) => ({ eq: async () => { scritture.push({ table, op: 'update', arg }); return { error: null }; } }),
    }),
  } as any;
  return { s, scritture };
}
const C = { conversationId: 50_001, phone: '+393331234567', from: 'whatsapp:+393522018718', crmLeadId: 'lead-1', variante: 'b' as const };

beforeEach(() => {
  vi.mocked(sendFreeText).mockClear();
  vi.mocked(sendOutcome).mockReset().mockResolvedValue({ sent: true, status: 200 });
});

describe('congedoDatabase — "Non mi interessa"', () => {
  it('una riga di congedo dal numero della chat, poi DA_SCARTARE "non interessato"', async () => {
    const { s, scritture } = supa();
    const r = await congedoDatabase(s, C);
    expect(r).toEqual({ chiusa: true });
    expect(sendFreeText).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendFreeText).mock.calls[0][0]).toEqual({ to: C.phone, body: TESTO_CONGEDO_DATABASE, from: C.from });
    expect(scritture.find((x) => x.table === 'messages')?.arg).toMatchObject({
      conversation_id: 50_001, direction: 'out', body: TESTO_CONGEDO_DATABASE, twilio_sid: 'SMcongedo',
    });
    expect(sendOutcome).toHaveBeenCalledTimes(1);
    const [, convId, args] = vi.mocked(sendOutcome).mock.calls[0];
    expect(convId).toBe(50_001);
    expect(args).toMatchObject({ outcome: 'DA_SCARTARE', discardReason: 'non interessato', leadWords: 'Non mi interessa' });
    expect(args.note).toContain('variante b');
    const ev = scritture.find((x) => x.table === 'event_log')?.arg;
    expect(ev).toMatchObject({ type: EVENTO_DATABASE_NON_INTERESSA, payload: { conversationId: 50_001, variante: 'b', accettato: true } });
  });

  it('il congedo non fa domande e non rilancia', () => {
    expect(TESTO_CONGEDO_DATABASE).not.toContain('?');
    expect(TESTO_CONGEDO_DATABASE.length).toBeLessThan(90);
  });

  it('403 del CRM (lead non piu\' del bot) = chiusa lo stesso', async () => {
    vi.mocked(sendOutcome).mockResolvedValue({ sent: false, status: 403 });
    expect(await congedoDatabase(supa().s, C)).toEqual({ chiusa: true });
  });

  it('CRM giu\': il congedo e\' partito, la chat resta aperta e non si rimanda niente al lead', async () => {
    vi.mocked(sendOutcome).mockResolvedValue({ sent: false, status: 500 });
    const { s, scritture } = supa();
    expect(await congedoDatabase(s, C)).toEqual({ chiusa: false });
    expect(sendFreeText).toHaveBeenCalledTimes(1);
    expect(scritture.find((x) => x.table === 'event_log')?.arg.payload).toMatchObject({ accettato: false, motivo: 'http_500' });
  });

  it('chat senza lead del CRM: solo il congedo', async () => {
    expect(await congedoDatabase(supa().s, { ...C, crmLeadId: null })).toEqual({ chiusa: true });
    expect(sendOutcome).not.toHaveBeenCalled();
  });
});
