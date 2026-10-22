import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const sendFreeTextMock = vi.fn();
vi.mock('./twilio', () => ({ sendFreeText: (...a: unknown[]) => sendFreeTextMock(...a) }));

import { claimRecap, inviaRecapDopoData } from './gdo-recap-send';

/**
 * Finto client: una riga di `conversations` in memoria. L'update applica davvero i
 * filtri `.eq('id')`, `.is(col, null)` e l'`.or()` del claim, e torna le righe toccate
 * con `.select('id')`. Il confronto sulla data è fra stringhe, come quello che
 * PostgREST riceve nell'URL: per questo `claimRecap` deve normalizzare in ISO UTC.
 */
function makeSupabase(riga: Record<string, any>) {
  const updates: any[] = [];
  const supabase: any = {
    from(table: string) {
      if (table !== 'conversations') throw new Error(`tabella inattesa: ${table}`);
      return {
        update(payload: any) {
          const filtri: Array<(r: Record<string, any>) => boolean> = [];
          const applica = () => {
            const ok = filtri.every((f) => f(riga));
            if (ok) { Object.assign(riga, payload); updates.push(payload); }
            return { data: ok ? [{ id: riga.id }] : [], error: null };
          };
          const q: any = {
            eq: (col: string, val: any) => { filtri.push((r) => r[col] === val); return q; },
            is: (col: string, val: null) => { filtri.push((r) => r[col] === val); return q; },
            or: (expr: string) => {
              const clausole = expr.split(',').map((c) => {
                const [col, op, ...resto] = c.split('.');
                const val = resto.join('.');
                if (op === 'is' && val === 'null') return (r: Record<string, any>) => r[col] == null;
                if (op === 'neq') return (r: Record<string, any>) => r[col] !== val;
                throw new Error(`clausola inattesa: ${c}`);
              });
              filtri.push((r) => clausole.some((f) => f(r)));
              return q;
            },
            select: () => q,
            then: (resolve: any) => resolve(applica()),
          };
          return q;
        },
      };
    },
  };
  return { supabase, riga, updates };
}

describe('claimRecap', () => {
  it('la prima volta prende il recap, la seconda no anche con la stessa data in un altro fuso', async () => {
    const { supabase, riga } = makeSupabase({ id: 7, gdo_recap_for_at: null, gdo_noemi_reminded_at: null });

    expect(await claimRecap(supabase, 7, '2026-10-23T17:00:00+02:00', false)).toBe(true);
    expect(riga.gdo_recap_for_at).toBe('2026-10-23T15:00:00.000Z');
    expect(riga.gdo_recap_sent_at).toBeTruthy();

    expect(await claimRecap(supabase, 7, '2026-10-23T15:00:00Z', false)).toBe(false);
  });

  it('una call spostata a un altro orario si riassume di nuovo', async () => {
    const { supabase } = makeSupabase({ id: 7, gdo_recap_for_at: '2026-10-23T15:00:00.000Z' });
    expect(await claimRecap(supabase, 7, '2026-10-24T15:00:00Z', false)).toBe(true);
  });

  it('con Noemi segna anche il promemoria, ma solo se non era già segnato', async () => {
    const fresca = makeSupabase({ id: 7, gdo_recap_for_at: null, gdo_noemi_reminded_at: null });
    expect(await claimRecap(fresca.supabase, 7, '2026-10-23T15:00:00Z', true)).toBe(true);
    expect(fresca.riga.gdo_noemi_reminded_at).toBeTruthy();

    const PRIMA = '2026-10-20T10:00:00.000Z';
    const gia = makeSupabase({ id: 7, gdo_recap_for_at: null, gdo_noemi_reminded_at: PRIMA });
    expect(await claimRecap(gia.supabase, 7, '2026-10-23T15:00:00Z', true)).toBe(true);
    expect(gia.riga.gdo_noemi_reminded_at).toBe(PRIMA);
  });

  it('senza Noemi il promemoria non si tocca', async () => {
    const { supabase, riga } = makeSupabase({ id: 7, gdo_recap_for_at: null, gdo_noemi_reminded_at: null });
    await claimRecap(supabase, 7, '2026-10-23T15:00:00Z', false);
    expect(riga.gdo_noemi_reminded_at).toBeNull();
  });
});

/**
 * Finto client a più tabelle per `inviaRecapDopoData`: `conversations` è una riga in
 * memoria (select/single, update con .eq/.is/.or), `messages` ed `event_log` raccolgono
 * gli insert.
 */
function makeDb(conv: Record<string, any>) {
  const inseriti: Record<string, any[]> = { messages: [], event_log: [] };
  const supabase: any = {
    from(table: string) {
      if (table !== 'conversations') {
        return { insert: (r: any) => { inseriti[table].push(r); return Promise.resolve({ error: null }); } };
      }
      const nuovoQ = (payload: any | null) => {
        const filtri: Array<(r: Record<string, any>) => boolean> = [];
        const q: any = {
          select: () => q,
          eq: (col: string, val: any) => { filtri.push((r) => r[col] === val); return q; },
          is: (col: string, val: null) => { filtri.push((r) => r[col] === val); return q; },
          or: (expr: string) => {
            const clausole = expr.split(',').map((c) => {
              const [col, op, ...resto] = c.split('.');
              const val = resto.join('.');
              if (op === 'is') return (r: Record<string, any>) => r[col] == null;
              return (r: Record<string, any>) => r[col] !== val;
            });
            filtri.push((r) => clausole.some((f) => f(r)));
            return q;
          },
          single: () => Promise.resolve({ data: conv, error: null }),
          then: (resolve: any) => {
            const ok = filtri.every((f) => f(conv));
            if (payload && ok) Object.assign(conv, payload);
            resolve({ data: ok ? [{ id: conv.id }] : [], error: null });
          },
        };
        return q;
      };
      return { select: () => nuovoQ(null), update: (p: any) => nuovoQ(p) };
    },
  };
  return { supabase, inseriti };
}

describe('inviaRecapDopoData', () => {
  const NOW = Date.parse('2026-10-22T10:00:00Z');
  const CALL = '2026-10-23T15:00:00.000Z';
  const baseConv = () => ({
    id: 7, bot_outcome: null, gdo_agenda_at: '2026-10-22T08:00:00Z', gdo_appuntamento_at: CALL,
    gdo_video_url: 'https://v', gdo_video_sent_at: '2026-10-22T08:05:00Z',
    gdo_recap_for_at: null as string | null, gdo_recap_sent_at: null as string | null, gdo_noemi_reminded_at: null as string | null,
    ai_paused_at: null, cancel_requested_at: null, last_inbound_at: '2026-10-22T09:00:00Z',
    wa_number: null, leads: { phone_e164: '+393331112233', first_name: 'Anna' },
  });

  beforeEach(() => {
    sendFreeTextMock.mockReset();
    sendFreeTextMock.mockResolvedValue({ sid: 'SM1', status: 'queued' });
    vi.stubEnv('GDO_RECAP_ENABLED', '1');
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('registrato con video già mandato e finestra aperta → un invio "qui sopra", torna senza-video', async () => {
    const { supabase, inseriti } = makeDb(baseConv());
    expect(await inviaRecapDopoData(supabase, 7, 'registrato', NOW)).toBe('senza-video');
    expect(sendFreeTextMock).toHaveBeenCalledTimes(1);
    expect(sendFreeTextMock.mock.calls[0][0].body).toContain('qui sopra');
    expect(sendFreeTextMock.mock.calls[0][0].to).toBe('+393331112233');
    expect(inseriti.messages).toHaveLength(1);
    expect(inseriti.event_log.map((e) => e.type)).toEqual(['gdo_recap_sent']);
  });

  it('spostato con recap precedente → testo di spostamento, promemoria Noemi non toccato', async () => {
    const conv = { ...baseConv(), gdo_recap_for_at: '2026-10-22T15:00:00.000Z' };
    const { supabase } = makeDb(conv);
    expect(await inviaRecapDopoData(supabase, 7, 'spostato', NOW)).toBe('spostamento');
    expect(sendFreeTextMock.mock.calls[0][0].body).toContain('ora è');
    expect(conv.gdo_noemi_reminded_at).toBeNull();
    expect(conv.gdo_recap_for_at).toBe(CALL);
  });

  it('interruttore spento → nessun invio, null', async () => {
    vi.stubEnv('GDO_RECAP_ENABLED', '0');
    const { supabase, inseriti } = makeDb(baseConv());
    expect(await inviaRecapDopoData(supabase, 7, 'registrato', NOW)).toBeNull();
    expect(sendFreeTextMock).not.toHaveBeenCalled();
    expect(inseriti.messages).toHaveLength(0);
  });

  it('sendFreeText che lancia → nessuna eccezione, gdo_recap_errore, presa rilasciata, niente gdo_recap_sent', async () => {
    sendFreeTextMock.mockRejectedValue(new Error('twilio giù'));
    const conv = baseConv();
    const { supabase, inseriti } = makeDb(conv);
    expect(await inviaRecapDopoData(supabase, 7, 'registrato', NOW)).toBeNull();
    expect(inseriti.event_log.map((e) => e.type)).toEqual(['gdo_recap_errore']);
    expect(inseriti.messages).toHaveLength(0);
    expect(conv.gdo_recap_for_at).toBeNull();
    expect(conv.gdo_recap_sent_at).toBeNull();
    expect(conv.gdo_noemi_reminded_at).toBeNull();
  });

  it('invio fallito su uno spostamento: i valori precedenti tornano, il promemoria già segnato resta', async () => {
    sendFreeTextMock.mockRejectedValue(new Error('twilio giù'));
    const PRIMA = '2026-10-20T10:00:00.000Z';
    const conv = { ...baseConv(), gdo_noemi_reminded_at: PRIMA, gdo_recap_for_at: '2026-10-22T15:00:00.000Z', gdo_recap_sent_at: '2026-10-22T09:30:00.000Z' };
    const { supabase } = makeDb(conv);
    expect(await inviaRecapDopoData(supabase, 7, 'spostato', NOW)).toBeNull();
    expect(conv.gdo_noemi_reminded_at).toBe(PRIMA);
    expect(conv.gdo_recap_for_at).toBe('2026-10-22T15:00:00.000Z');
    expect(conv.gdo_recap_sent_at).toBe('2026-10-22T09:30:00.000Z');
  });
});
