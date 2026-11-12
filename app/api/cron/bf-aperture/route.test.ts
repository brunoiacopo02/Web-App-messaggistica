import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/supabase/admin', () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock('@/lib/apertura-mario-invio', () => ({
  sendSequenceTemplate: vi.fn(async () => ({ ok: true, sid: 'SM_BF' })),
  inviaAperturaMario: vi.fn(async () => ({ tentato: true, ok: true })),
}));
vi.mock('@/lib/black-friday-apertura', () => ({
  templateBfApprovatoSu: vi.fn(async () => ({ ok: true, sid: 'HX_BF' })),
  leggiModoAperturaBf: vi.fn(async () => null),
}));
vi.mock('@/lib/tetti-numeri', () => ({
  getStatoQualitaNumeri: vi.fn(async () => ({})),
  eHighEFuoriPausa: vi.fn(() => true),
}));
vi.mock('@/lib/mittente', () => ({ numeroPrimario: vi.fn(() => 'whatsapp:+393520413199') }));
vi.mock('@/lib/scelta-mittente', () => ({ sceltaHighMenoCarico: vi.fn(async () => null) }));
vi.mock('@/lib/sequence', () => ({ inOpeningWindow: vi.fn(() => true) }));
vi.mock('@/lib/cron-query-error', () => ({ logCronQueryError: vi.fn(async () => undefined) }));

import { GET } from './route';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { sendSequenceTemplate } from '@/lib/apertura-mario-invio';
import { sceltaHighMenoCarico } from '@/lib/scelta-mittente';
import { EVENTO_BF_SU_APPUNTAMENTO } from '@/lib/black-friday';

const RICHIESTA_AT = '2026-11-09T12:00:00.000Z';
type Msg = { direction: string; body: string | null; twilio_sid: string | null; created_at: string };

/** Una chat 'closed' con APPUNTAMENTO del bot e una richiesta di apertura BF in event_log. */
function fake(opts: { messaggi: Msg[]; richiesta?: boolean }) {
  const calls = { updates: [] as any[], events: [] as any[] };
  const conv = {
    id: 31646, ai_started_at: '2026-11-08T00:16:05Z', wa_number: 'whatsapp:+393520413199', ai_status: 'closed',
    leads: { phone_e164: '+393339465512', first_name: 'Aurora' },
  };
  const supabase: any = {
    from(table: string) {
      if (table === 'conversations') {
        return {
          select() {
            let seconda = false;
            const c: any = {
              ilike: () => c, eq: () => c, is: () => c, not: () => c, order: () => c,
              in: () => { seconda = true; return c; },
              limit: async () => ({ data: [], error: null }), // lista principale: solo chat 'active'
              then: (r: any) => r({ data: seconda ? [conv] : [], error: null }),
            };
            return c;
          },
          update(p: any) { calls.updates.push(p); const c: any = { eq: () => c, then: (r: any) => r({}) }; return c; },
        };
      }
      if (table === 'messages') {
        return {
          select() {
            let da = '';
            const c: any = {
              eq: () => c,
              gte: (_col: string, v: string) => { da = v; return c; },
              then: (r: any) => r({ data: opts.messaggi.filter((m) => m.created_at >= da) }),
            };
            return c;
          },
        };
      }
      // event_log
      return {
        insert(p: any) { calls.events.push(p); return Promise.resolve({}); },
        select(_c: string, o?: { head?: boolean }) {
          if (o?.head) { const k: any = { eq: () => k, gte: () => k, then: (r: any) => r({ count: 0 }) }; return k; }
          const c: any = {
            eq: () => c, gte: () => c, order: () => c,
            limit: async () => ({ data: opts.richiesta === false ? [] : [{ payload: { conversationId: '31646' }, created_at: RICHIESTA_AT }] }),
          };
          return c;
        },
      };
    },
  };
  return { supabase, calls };
}

function req() {
  return new NextRequest('https://x/api/cron/bf-aperture', { headers: { authorization: 'Bearer s' } });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('CRON_SECRET', 's');
});

// La conversazione in cui ha fissato: inbound e outbound PRIMA della richiesta BF.
const STORIA: Msg[] = [
  { direction: 'out', body: 'Ciao Aurora...', twilio_sid: 'SM1', created_at: '2026-11-08T00:16:10Z' },
  { direction: 'in', body: 'si mi interessa', twilio_sid: null, created_at: '2026-11-08T17:00:00Z' },
  { direction: 'out', body: 'Perfetto, ci sentiamo domani alle 11', twilio_sid: 'SM2', created_at: '2026-11-08T17:29:00Z' },
];

describe('bf-aperture — chat con APPUNTAMENTO e lead BF (PO 09/11/2026)', () => {
  it('manda UNA apertura BF; la conversazione dell appuntamento non conta come "ha risposto"; esito intatto', async () => {
    const { supabase, calls } = fake({ messaggi: STORIA });
    vi.mocked(getSupabaseAdmin).mockReturnValue(supabase);
    const res = await GET(req());
    const body = await res.json();
    expect(body).toMatchObject({ inviati: 1, risposto: 0 });
    expect(sendSequenceTemplate).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendSequenceTemplate).mock.calls[0][4]).toBe('Apertura Black Friday');
    for (const u of calls.updates) {
      expect(u).not.toHaveProperty('bot_outcome');
      expect(u).not.toHaveProperty('bot_scheduled_at');
      expect(u).not.toHaveProperty('ai_status');
    }
  });

  it('apertura BF gia partita dopo la richiesta → niente secondo invio', async () => {
    const { supabase } = fake({
      messaggi: [...STORIA, { direction: 'out', body: "Grazie per la richiesta di informazioni sull'offerta Black Friday", twilio_sid: 'SM3', created_at: '2026-11-09T12:10:00Z' }],
    });
    vi.mocked(getSupabaseAdmin).mockReturnValue(supabase);
    const body = await (await GET(req())).json();
    expect(body).toMatchObject({ inviati: 0, giaFatti: 1 });
    expect(sendSequenceTemplate).not.toHaveBeenCalled();
  });

  it('il lead ha scritto dopo la richiesta → niente apertura (continua Mario)', async () => {
    const { supabase } = fake({
      messaggi: [...STORIA, { direction: 'in', body: 'ciao', twilio_sid: null, created_at: '2026-11-09T12:05:00Z' }],
    });
    vi.mocked(getSupabaseAdmin).mockReturnValue(supabase);
    const body = await (await GET(req())).json();
    expect(body).toMatchObject({ inviati: 0, risposto: 1 });
  });

  it('senza richiesta in event_log la chat con appuntamento non e candidata', async () => {
    const { supabase } = fake({ messaggi: STORIA, richiesta: false });
    vi.mocked(getSupabaseAdmin).mockReturnValue(supabase);
    const body = await (await GET(req())).json();
    expect(body).toMatchObject({ candidati: 0, inviati: 0 });
    expect(EVENTO_BF_SU_APPUNTAMENTO).toBe('bf_apertura_su_appuntamento');
  });
});

// PO 12/11/2026 (lib/bf-primario.ts): dal 3199 l'apertura BF parte solo per chi ha gia'
// una chat con lui; gli altri vanno sul numero HIGH meno carico fra gli altri.
describe('bf-aperture — il 3199 apre solo chi ha gia una chat con lui (PO 12/11/2026)', () => {
  const P = 'whatsapp:+393520413199';
  const N0047 = 'whatsapp:+393522070047';

  /** Una chat BF 'active' sul 3199, riaperta adesso (nessun messaggio dopo `ai_started_at`). */
  function fakeAttiva(opts: { inboundPassati: number | null; regola?: unknown }) {
    const calls = { updates: [] as any[], events: [] as any[] };
    const conv = {
      id: 19348, ai_started_at: '2026-11-11T10:29:00Z', wa_number: P,
      leads: { phone_e164: '+393331234567', first_name: 'Giulia' },
    };
    const supabase: any = {
      from(table: string) {
        if (table === 'app_settings') {
          return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: opts.regola === undefined ? null : { value: opts.regola }, error: null }) }) }) };
        }
        if (table === 'conversations') {
          return {
            select() {
              const c: any = { ilike: () => c, eq: () => c, is: () => c, not: () => c, order: () => c, limit: async () => ({ data: [conv], error: null }) };
              return c;
            },
            update(p: any) { calls.updates.push(p); const c: any = { eq: () => c, then: (r: any) => r({}) }; return c; },
          };
        }
        if (table === 'messages') {
          return {
            select(_c: string, o?: { head?: boolean }) {
              if (o?.head) {
                const k: any = {
                  eq: () => k,
                  then: (r: any) => r(opts.inboundPassati === null ? { count: null, error: { message: 'giu' } } : { count: opts.inboundPassati, error: null }),
                };
                return k;
              }
              // Dopo la riapertura non c'e' ancora nessun messaggio.
              const c: any = { eq: () => c, gte: () => c, then: (r: any) => r({ data: [] }) };
              return c;
            },
          };
        }
        return {
          insert(p: any) { calls.events.push(p); return Promise.resolve({}); },
          select(_c: string, o?: { head?: boolean }) {
            if (o?.head) { const k: any = { eq: () => k, gte: () => k, then: (r: any) => r({ count: 0 }) }; return k; }
            const c: any = { eq: () => c, gte: () => c, order: () => c, limit: async () => ({ data: [] }) };
            return c;
          },
        };
      },
    };
    return { supabase, calls };
  }

  beforeEach(() => {
    vi.stubEnv('BF_OPENING_TEMPLATE_SID', 'HX_BF');
    vi.mocked(sceltaHighMenoCarico).mockResolvedValue({ numero: N0047, oggi: 3 });
  });

  it('chat passata sul 3199 (il lead ci ha scritto) → l apertura parte dal 3199', async () => {
    const { supabase, calls } = fakeAttiva({ inboundPassati: 6 });
    vi.mocked(getSupabaseAdmin).mockReturnValue(supabase);
    const body = await (await GET(req())).json();
    expect(body).toMatchObject({ inviati: 1 });
    expect(vi.mocked(sendSequenceTemplate).mock.calls[0][5]).toBe(P);
    expect(sceltaHighMenoCarico).not.toHaveBeenCalled();
    expect(calls.updates).toEqual([]);
    expect(calls.events.map((e: any) => e.type)).not.toContain('bf_apertura_fuori_dal_primario');
  });

  it('nessuna chat passata sul 3199 → altro numero (HIGH meno carico, 3199 escluso), la chat lo segue', async () => {
    const { supabase, calls } = fakeAttiva({ inboundPassati: 0 });
    vi.mocked(getSupabaseAdmin).mockReturnValue(supabase);
    const body = await (await GET(req())).json();
    expect(body).toMatchObject({ inviati: 1 });
    expect(vi.mocked(sendSequenceTemplate).mock.calls[0][5]).toBe(N0047);
    expect(vi.mocked(sceltaHighMenoCarico).mock.calls[0][1]).toMatchObject({ escludiPrimario: true });
    expect(calls.updates).toEqual([{ wa_number: N0047 }]);
    const ev = calls.events.find((e: any) => e.type === 'bf_apertura_fuori_dal_primario');
    expect(ev.payload).toMatchObject({ conversationId: 19348, da: P, a: N0047, punto: 'bf-aperture' });
  });

  it('nessuna chat passata e nessun altro numero utilizzabile → non parte dal 3199, si riprova al giro dopo', async () => {
    vi.mocked(sceltaHighMenoCarico).mockResolvedValue(null);
    const { supabase, calls } = fakeAttiva({ inboundPassati: 0 });
    vi.mocked(getSupabaseAdmin).mockReturnValue(supabase);
    const body = await (await GET(req())).json();
    expect(body).toMatchObject({ inviati: 0, senzaNumero: 1 });
    expect(sendSequenceTemplate).not.toHaveBeenCalled();
    expect(calls.events.map((e: any) => e.type)).not.toContain('bf_apertura_fuori_dal_primario');
  });

  it('regola spenta da impostazione → dal 3199 come prima', async () => {
    const { supabase, calls } = fakeAttiva({ inboundPassati: 0, regola: 'off' });
    vi.mocked(getSupabaseAdmin).mockReturnValue(supabase);
    const body = await (await GET(req())).json();
    expect(body).toMatchObject({ inviati: 1 });
    expect(vi.mocked(sendSequenceTemplate).mock.calls[0][5]).toBe(P);
    expect(calls.updates).toEqual([]);
  });

  it('conteggio fallito → nel dubbio la chat resta sul 3199', async () => {
    const { supabase } = fakeAttiva({ inboundPassati: null });
    vi.mocked(getSupabaseAdmin).mockReturnValue(supabase);
    await GET(req());
    expect(vi.mocked(sendSequenceTemplate).mock.calls[0][5]).toBe(P);
  });
});
