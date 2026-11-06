import { describe, it, expect } from 'vitest';
import { registraFinestraChiusa } from './finestra-63016';

function fakeSupa(rows: Record<string, unknown>) {
  const inserts: Array<{ table: string; row: Record<string, unknown> }> = [];
  const supa = {
    from(table: string) {
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.eq = () => q;
      q.maybeSingle = async () => ({ data: rows[table] ?? null });
      q.insert = async (row: Record<string, unknown>) => { inserts.push({ table, row }); return { error: null }; };
      return q;
    },
  };
  return { supa: supa as never, inserts };
}

describe('registraFinestraChiusa — il 63016 ha un evento suo (06/11/2026)', () => {
  it('63016: evento finestra_chiusa_63016 con mittente, numero della chat e ultimo inbound', async () => {
    const { supa, inserts } = fakeSupa({
      messages: { conversation_id: 42, sender: 'mario' },
      conversations: { wa_number: 'whatsapp:+393520413199', last_inbound_number: 'whatsapp:+393522070047', last_inbound_at: '2026-11-06T10:00:00Z' },
    });
    const fatto = await registraFinestraChiusa(supa, { sid: 'SM1', errorCode: '63016', from: 'whatsapp:+393520413199', to: 'whatsapp:+39333' });
    expect(fatto).toBe(true);
    const ev = inserts.find((i) => i.table === 'event_log')!.row;
    expect(ev.type).toBe('finestra_chiusa_63016');
    expect(ev.payload).toMatchObject({
      sid: 'SM1', conversationId: 42, from: 'whatsapp:+393520413199',
      numeroChat: 'whatsapp:+393520413199', lastInboundNumber: 'whatsapp:+393522070047',
    });
  });

  it('altri codici: niente', async () => {
    const { supa, inserts } = fakeSupa({});
    expect(await registraFinestraChiusa(supa, { sid: 'SM1', errorCode: '63049' })).toBe(false);
    expect(await registraFinestraChiusa(supa, { sid: 'SM1', errorCode: null })).toBe(false);
    expect(inserts).toEqual([]);
  });
});
