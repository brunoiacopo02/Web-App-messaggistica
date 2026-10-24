import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * Il ramo GDO del cron dei promemoria (app/api/cron/precall-reminders), dal vivo con un
 * finto Supabase: "già inviato" è la colonna `gdo_reminder24_for_at`, presa PRIMA
 * dell'invio. Prima era la riga `gdo_reminder24_sent` di event_log, scritta dopo e senza
 * controllo: persa quella, il promemoria ripartiva a ogni giro del cron.
 */

let db: ReturnType<typeof makeDb>;
vi.mock('@/lib/supabase/admin', () => ({ getSupabaseAdmin: () => db.supabase }));
vi.mock('@/lib/messaging', () => ({ sendTemplateAndLog: vi.fn() }));
vi.mock('@/lib/twilio', () => ({ sendFreeText: vi.fn() }));

import { GET } from '@/app/api/cron/precall-reminders/route';
import { sendTemplateAndLog } from '@/lib/messaging';

const NOW = Date.parse('2026-10-22T13:00:00Z'); // 15:00 a Roma
const CALL = '2026-10-23T12:00:00.000Z'; // domani 14:00 a Roma: Noemi oggi pomeriggio

function makeDb(conv: Record<string, any>, opts: { eventoNonScritto?: boolean; parcheggiata?: boolean } = {}) {
  const events: any[] = [];
  const supabase: any = {
    from(table: string) {
      if (table === 'crm_lead_status') {
        // Le conversazioni parcheggiate dalle Conferme (esito da_rifissare).
        const q: any = {};
        for (const m of ['select', 'eq', 'in']) q[m] = () => q;
        q.then = (resolve: any) => resolve({
          data: opts.parcheggiata ? [{ conversation_id: conv.id }] : [], error: null,
        });
        return q;
      }
      if (table === 'conversations') {
        return {
          // La select dei candidati: torna la riga viva.
          select() {
            const q: any = {};
            for (const m of ['not', 'or', 'is', 'gte', 'lte', 'eq']) q[m] = () => q;
            q.then = (resolve: any) => resolve({ data: [conv], error: null });
            return q;
          },
          update(payload: any) {
            const filtri: Array<(r: Record<string, any>) => boolean> = [];
            const q: any = {
              eq: (col: string, val: any) => { filtri.push((r) => r[col] === val); return q; },
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
              select: () => q,
              then: (resolve: any) => {
                const ok = filtri.every((f) => f(conv));
                if (ok) Object.assign(conv, payload);
                resolve({ data: ok ? [{ id: conv.id }] : [], error: null });
              },
            };
            return q;
          },
        };
      }
      if (table === 'messages') {
        return {
          select() {
            const q: any = {};
            for (const m of ['eq', 'order', 'limit']) q[m] = () => q;
            q.maybeSingle = async () => ({ data: null, error: null });
            return q;
          },
          insert: async () => ({ error: null }),
        };
      }
      // event_log
      return {
        insert: async (r: any) => {
          if (r.type === 'gdo_reminder24_sent' && opts.eventoNonScritto) return { error: { message: 'insert rifiutato' } };
          events.push(r);
          return { error: null };
        },
        select() {
          const cerca: Record<string, string> = {};
          const q: any = {
            eq: (col: string, val: string) => { cerca[col] = val; return q; },
            limit: () => q,
            then: (resolve: any) => resolve({
              data: events.filter((e) => e.type === cerca.type
                && Object.entries(cerca).filter(([k]) => k.startsWith('payload->>'))
                  .every(([k, v]) => String(e.payload?.[k.slice('payload->>'.length)]) === v)),
              error: null,
            }),
          };
          return q;
        },
      };
    },
  };
  return { supabase, events, conv };
}

const conv = (over: Record<string, any> = {}) => ({
  id: 5, gdo_agenda_at: '2026-10-21T15:00:00Z', gdo_appuntamento_at: CALL,
  gdo_video_sent_at: '2026-10-21T16:00:00Z', gdo_recap_sent_at: null, gdo_reminder24_for_at: null,
  bot_outcome: null, ai_paused_at: null, cancel_requested_at: null, wa_number: null,
  leads: { phone_e164: '+393331112233', first_name: 'Anna' },
  ...over,
});

const giro = () => GET(new NextRequest('http://localhost/api/cron/precall-reminders', {
  headers: { authorization: 'Bearer s' },
}));

describe('promemoria GDO del giorno prima: la presa sta sulla colonna, prima dell\'invio', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    vi.stubEnv('CRON_SECRET', 's');
    vi.stubEnv('GDO_PRECALL_24H_ENABLED', '1');
    vi.stubEnv('GDO_REMINDER_24H_TEMPLATE_SID', 'HXgdo');
    vi.stubEnv('TWILIO_WHATSAPP_NUMBER_FENICE', 'whatsapp:+390000000000');
    vi.mocked(sendTemplateAndLog).mockReset();
    vi.mocked(sendTemplateAndLog).mockResolvedValue({ ok: true, sid: 'SM1' });
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

  it('la riga di event_log non si scrive: il giro dell\'ora dopo NON rimanda il promemoria', async () => {
    db = makeDb(conv(), { eventoNonScritto: true });
    await giro();
    vi.setSystemTime(NOW + 3600_000);
    await giro();
    expect(sendTemplateAndLog).toHaveBeenCalledTimes(1);
    expect(db.conv.gdo_reminder24_for_at).toBe(CALL);
  });

  it('due giri sovrapposti: un solo promemoria', async () => {
    db = makeDb(conv());
    await Promise.all([giro(), giro()]);
    expect(sendTemplateAndLog).toHaveBeenCalledTimes(1);
  });

  it('invio non partito: la colonna torna com\'era e il giro dopo riprova', async () => {
    db = makeDb(conv());
    vi.mocked(sendTemplateAndLog).mockResolvedValueOnce({ ok: false, error: 'twilio giù' });
    await giro();
    expect(db.conv.gdo_reminder24_for_at).toBeNull();
    expect(db.events.some((e) => e.type === 'gdo_reminder24_sent')).toBe(false);
    await giro();
    expect(sendTemplateAndLog).toHaveBeenCalledTimes(2);
    expect(db.conv.gdo_reminder24_for_at).toBe(CALL);
    expect(db.events.filter((e) => e.type === 'gdo_reminder24_sent')).toHaveLength(1);
  });

  it('invio che lancia: la colonna torna al valore di prima', async () => {
    const PRIMA = '2026-10-21T12:00:00.000Z';
    db = makeDb(conv({ gdo_reminder24_for_at: PRIMA }));
    vi.mocked(sendTemplateAndLog).mockRejectedValueOnce(new Error('rete giù'));
    await giro();
    expect(db.conv.gdo_reminder24_for_at).toBe(PRIMA);
  });

  it('la call spostata riapre il promemoria', async () => {
    db = makeDb(conv({ gdo_reminder24_for_at: '2026-10-22T12:00:00.000Z' }));
    await giro();
    expect(sendTemplateAndLog).toHaveBeenCalledTimes(1);
    expect(db.conv.gdo_reminder24_for_at).toBe(CALL);
  });

  it('lead parcheggiato dalle Conferme (da_rifissare): niente promemoria, nessuna presa', async () => {
    db = makeDb(conv(), { parcheggiata: true });
    await giro();
    expect(sendTemplateAndLog).not.toHaveBeenCalled();
    expect(db.conv.gdo_reminder24_for_at).toBeNull();
  });

  it('la stessa call già presa (scritta in un altro fuso) non riparte', async () => {
    db = makeDb(conv({ gdo_appuntamento_at: '2026-10-23T14:00:00+02:00', gdo_reminder24_for_at: CALL }));
    await giro();
    expect(sendTemplateAndLog).not.toHaveBeenCalled();
  });
});
