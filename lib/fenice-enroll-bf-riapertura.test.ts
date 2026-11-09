import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./messaging', () => ({
  findOrCreateLeadConversation: vi.fn(async () => ({ leadId: 7, conversationId: 8727, waNumber: 'whatsapp:+393520413199' })),
  sendTemplateAndLog: vi.fn(async () => ({ ok: true, sid: 'SM_TEST' })),
}));
vi.mock('./lancio-settings', () => ({
  getLancioSettings: vi.fn(async () => ({ attivo: false })),
}));
vi.mock('./scelta-mittente', () => ({
  scegliMittenteNuovo: vi.fn(async () => ({ from: 'whatsapp:+393520158061', secondario: false, scartati: [], motivo: 'black_friday' })),
  sidAperturaMario: vi.fn(() => ['HX_OPEN']),
  chatEsistente: vi.fn(async () => true),
  registraAperturaMario: vi.fn(async () => undefined),
}));
// Il template BF e' spedibile: senza la riapertura l'intake arriverebbe fino alla
// guardia `conversazione_viva`, come il 08/11.
vi.mock('./black-friday-apertura', () => ({
  aperturaBlackFriday: vi.fn(async () => ({ scelta: 'template_bf', sid: 'HX_BF' })),
}));

import { enrollLeadIntoMario, riapreChatPerBlackFriday } from './fenice-enroll';
import { sendTemplateAndLog } from './messaging';
import { MARKER_TESTO_APERTURA_BF } from './black-friday';

const ORA = Date.parse('2026-11-08T14:07:00Z'); // 15:07 Roma, come il push di Elvi
const H = 3600_000;
const fa = (ore: number) => new Date(ORA - ore * H).toISOString();

type Chat = {
  crmLeadId: string | null; crmFunnel?: string | null; aiStatus?: string | null; botOutcome?: string | null;
  lastInboundAt?: string | null; ultimoMessaggioAt?: string | null; ultimoOutboundAt?: string | null;
  bfPartita?: boolean; aiPausedAt?: string | null; gdoAppuntamentoAt?: string | null;
};

/** Fake Supabase: la riga della chat e le letture dei messaggi che l'arruolamento fa. */
function fake(chat: Chat) {
  const calls = { updates: [] as any[], events: [] as any[] };
  const riga = {
    ai_owner: 'mario', ai_status: chat.aiStatus ?? 'closed', crm_lead_id: chat.crmLeadId,
    crm_funnel: chat.crmFunnel ?? null, bot_outcome: chat.botOutcome ?? null,
    ai_paused_at: chat.aiPausedAt ?? null, gdo_appuntamento_at: chat.gdoAppuntamentoAt ?? null,
    lancio_slug: null, lancio_fase: null, last_inbound_at: chat.lastInboundAt ?? null,
  };
  const supabase: any = {
    from(table: string) {
      if (table === 'conversations') {
        return {
          update(payload: any) {
            calls.updates.push(payload);
            const c: any = { eq: () => c, or: () => c, then: (r: any) => r({}) };
            return c;
          },
          select() {
            return { eq() { return { single: async () => ({ data: riga, error: null }), maybeSingle: async () => ({ data: riga, error: null }) }; } };
          },
        };
      }
      if (table === 'messages') {
        return {
          select(_c: string, opz?: { head?: boolean }) {
            if (opz?.head) {
              const k: any = { eq: () => k, not: () => k, gte: () => k, then: (r: any) => r({ count: chat.ultimoOutboundAt ? 3 : 0, error: null }) };
              return k;
            }
            let soloPartiti = false, ordinata = false, conMarker = false, finestra: string | null = null;
            const c: any = {
              eq: () => c,
              not: () => { soloPartiti = true; return c; },
              order: () => { ordinata = true; return c; },
              ilike: (_col: string, v: string) => { conMarker = v.includes(MARKER_TESTO_APERTURA_BF); return c; },
              gte: (_col: string, v: string) => { finestra = v; return c; },
              limit: async () => {
                if (conMarker) return { data: chat.bfPartita ? [{ id: 1 }] : [], error: null };
                if (ordinata && soloPartiti) return { data: chat.ultimoOutboundAt ? [{ created_at: chat.ultimoOutboundAt }] : [], error: null };
                if (ordinata) return { data: chat.ultimoMessaggioAt ? [{ created_at: chat.ultimoMessaggioAt }] : [], error: null };
                // Guardia `apertura_recente`: outbound partito dopo la soglia delle 12h.
                const recente = !!chat.ultimoOutboundAt && !!finestra && chat.ultimoOutboundAt >= finestra;
                return { data: recente ? [{ id: 1 }] : [], error: null };
              },
            };
            return c;
          },
        };
      }
      return { insert(p: any) { calls.events.push(p); return Promise.resolve({}); } };
    },
  };
  return { supabase, calls };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(ORA);
  vi.clearAllMocks();
  vi.stubEnv('FENICE_OPENING_TEMPLATE_SID', 'HX_OPENING');
  vi.stubEnv('TWILIO_WHATSAPP_NUMBER_FENICE', 'whatsapp:+393520413199');
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

const ARGS = { phone: '+393466769579', firstName: 'Elvi Brogno', crmLeadId: 'LEAD-BF', crmFunnel: 'BLACK FRIDAY' };

describe('enrollLeadIntoMario — lead Black Friday su una chat che esiste gia (08/11/2026)', () => {
  it('chat vecchia chiusa (Elvi, conv 8727: ultimo inbound 94h fa) → riparte come lead BF nuovo', async () => {
    const { supabase, calls } = fake({
      crmLeadId: 'LEAD-VECCHIO', crmFunnel: 'PROFESSIONI', aiStatus: 'closed', botOutcome: 'DA_SCARTARE',
      lastInboundAt: fa(94), ultimoMessaggioAt: fa(94), ultimoOutboundAt: fa(94),
    });
    const res = await enrollLeadIntoMario(supabase, ARGS);

    // Niente "duplicate": il lead e' preso in carico, l'apertura la manda bf-aperture.
    expect(res).toMatchObject({ ok: true, conversationId: 8727, deferred: true });
    expect(res).not.toHaveProperty('duplicato');
    expect(sendTemplateAndLog).not.toHaveBeenCalled();
    const u = calls.updates.at(-1);
    expect(u).toMatchObject({
      ai_owner: 'mario', ai_status: 'active', crm_lead_id: 'LEAD-BF', crm_funnel: 'BLACK FRIDAY',
      bot_outcome: null, bot_outcome_at: null, bot_scheduled_at: null, gdo_agenda_at: null,
    });
    // Il timer della classificazione riparte da adesso: niente INTERROTTO al giro dopo.
    expect(u.ai_started_at).toBe(new Date(ORA).toISOString());
    const tipi = calls.events.map((e: any) => e.type);
    expect(tipi).toContain('fenice_enroll_bf_riapertura');
    expect(tipi).not.toContain('fenice_enroll_duplicato');
  });

  it('Ana (conv 31185: chiusa INTERROTTO, ultimo inbound 79h fa) → riparte anche lei', async () => {
    const { supabase, calls } = fake({
      crmLeadId: 'LEAD-VECCHIO', crmFunnel: 'PROFESSIONI', aiStatus: 'closed', botOutcome: 'INTERROTTO',
      lastInboundAt: fa(79), ultimoMessaggioAt: fa(79), ultimoOutboundAt: fa(79),
    });
    const res = await enrollLeadIntoMario(supabase, { ...ARGS, phone: '+50499822424' });
    expect(res).toMatchObject({ ok: true, deferred: true });
    expect(calls.updates.at(-1).ai_started_at).toBe(new Date(ORA).toISOString());
  });

  it('chat viva (il lead ha scritto 3 ore fa) → solo cambio funnel, nessuna riapertura', async () => {
    const { supabase, calls } = fake({
      crmLeadId: 'LEAD-VECCHIO', crmFunnel: 'PROFESSIONI', aiStatus: 'active',
      lastInboundAt: fa(3), ultimoMessaggioAt: fa(3), ultimoOutboundAt: fa(3),
    });
    const res = await enrollLeadIntoMario(supabase, ARGS);
    expect(res).toMatchObject({ ok: true, aperturaSaltata: true });
    expect(sendTemplateAndLog).not.toHaveBeenCalled();
    expect(calls.updates).toHaveLength(1);
    expect(calls.updates[0]).toMatchObject({ crm_lead_id: 'LEAD-BF', crm_funnel: 'BLACK FRIDAY' });
    expect(calls.updates[0]).not.toHaveProperty('ai_started_at');
    expect(calls.events.map((e: any) => e.type)).not.toContain('fenice_enroll_bf_riapertura');
  });

  it('chat chiusa ma un nostro messaggio e partito 5 ore fa → niente secondo "ciao"', async () => {
    const { supabase, calls } = fake({
      crmLeadId: 'LEAD-VECCHIO', crmFunnel: 'PROFESSIONI', aiStatus: 'closed', botOutcome: 'INTERROTTO',
      lastInboundAt: fa(50), ultimoMessaggioAt: fa(5), ultimoOutboundAt: fa(5),
    });
    const res = await enrollLeadIntoMario(supabase, ARGS);
    expect(res).toMatchObject({ duplicato: true });
    for (const u of calls.updates) expect(u).not.toHaveProperty('ai_started_at');
  });

  it('APPUNTAMENTO sulla chat → niente riapertura, esito intatto', async () => {
    const { supabase, calls } = fake({
      crmLeadId: 'LEAD-VECCHIO', crmFunnel: 'PROFESSIONI', aiStatus: 'closed', botOutcome: 'APPUNTAMENTO',
      lastInboundAt: fa(50), ultimoMessaggioAt: fa(50), ultimoOutboundAt: fa(50),
    });
    const res = await enrollLeadIntoMario(supabase, ARGS);
    expect(res).toMatchObject({ duplicato: true });
    expect(sendTemplateAndLog).not.toHaveBeenCalled();
    for (const u of calls.updates) {
      expect(u).not.toHaveProperty('bot_outcome');
      expect(u).not.toHaveProperty('ai_started_at');
    }
    expect(calls.events.map((e: any) => e.type)).not.toContain('fenice_enroll_bf_riapertura');
  });

  it('ritento dello stesso intake BF (chat gia BF, stesso leadId) → idempotente, nessuna riapertura', async () => {
    const { supabase, calls } = fake({
      crmLeadId: 'LEAD-BF', crmFunnel: 'BLACK FRIDAY', aiStatus: 'active',
      lastInboundAt: fa(50), ultimoMessaggioAt: fa(50), ultimoOutboundAt: fa(50),
    });
    await enrollLeadIntoMario(supabase, ARGS);
    expect(calls.events.map((e: any) => e.type)).not.toContain('fenice_enroll_bf_riapertura');
  });

  it('funnel diverso da BF (Professioni) su chat chiusa recente → comportamento di prima (duplicato)', async () => {
    const { supabase, calls } = fake({
      crmLeadId: 'LEAD-VECCHIO', crmFunnel: 'TELEGRAM', aiStatus: 'closed', botOutcome: 'INTERROTTO',
      lastInboundAt: fa(50), ultimoMessaggioAt: fa(50), ultimoOutboundAt: fa(50),
    });
    const res = await enrollLeadIntoMario(supabase, { ...ARGS, crmFunnel: 'PROFESSIONI' });
    expect(res).toMatchObject({ duplicato: true });
    expect(calls.events.map((e: any) => e.type)).not.toContain('fenice_enroll_bf_riapertura');
  });
});

describe('riapreChatPerBlackFriday — regole', () => {
  const base = {
    blackFriday: true, crmLeadIdPrima: 'A' as string | null | undefined, crmLeadIdNuovo: 'B' as string | null,
    crmFunnelPrima: 'PROFESSIONI' as string | null, aiStatus: 'closed' as string | null, botOutcome: 'INTERROTTO' as string | null,
    aiPausedAt: null as string | null, callGdoFutura: false, lancio: false, aperturaBfGiaPartita: false,
    ultimoInboundMs: ORA - 50 * H as number | null, ultimoOutboundMs: ORA - 50 * H as number | null, nowMs: ORA,
  };
  it('caso base → si', () => expect(riapreChatPerBlackFriday(base)).toBe(true));
  it('stesso leadId ma chat non ancora BF (cambio funnel) → si', () => {
    expect(riapreChatPerBlackFriday({ ...base, crmLeadIdPrima: 'B' })).toBe(true);
  });
  it('chat adottata senza leadId e non BF, ferma → si; gia BF → no', () => {
    expect(riapreChatPerBlackFriday({ ...base, crmLeadIdPrima: null })).toBe(true);
    expect(riapreChatPerBlackFriday({ ...base, crmLeadIdPrima: null, crmFunnelPrima: 'BLACK FRIDAY' })).toBe(false);
  });
  it('no: non BF, lettura fallita, ritento, apertura BF gia partita', () => {
    expect(riapreChatPerBlackFriday({ ...base, blackFriday: false })).toBe(false);
    expect(riapreChatPerBlackFriday({ ...base, crmLeadIdPrima: undefined })).toBe(false);
    expect(riapreChatPerBlackFriday({ ...base, crmLeadIdPrima: 'B', crmFunnelPrima: 'BLACK FRIDAY' })).toBe(false);
    expect(riapreChatPerBlackFriday({ ...base, aperturaBfGiaPartita: true })).toBe(false);
  });
  it('no: chat viva (inbound entro 24h, outbound entro 12h)', () => {
    expect(riapreChatPerBlackFriday({ ...base, ultimoInboundMs: ORA - 23 * H })).toBe(false);
    expect(riapreChatPerBlackFriday({ ...base, ultimoOutboundMs: ORA - 11 * H })).toBe(false);
    expect(riapreChatPerBlackFriday({ ...base, ultimoInboundMs: ORA - 25 * H, ultimoOutboundMs: ORA - 13 * H })).toBe(true);
  });
  it('no: APPUNTAMENTO, booked, handed_off, fermo manuale, call GDO futura, lancio', () => {
    expect(riapreChatPerBlackFriday({ ...base, botOutcome: 'APPUNTAMENTO' })).toBe(false);
    expect(riapreChatPerBlackFriday({ ...base, aiStatus: 'booked' })).toBe(false);
    expect(riapreChatPerBlackFriday({ ...base, aiStatus: 'handed_off' })).toBe(false);
    expect(riapreChatPerBlackFriday({ ...base, aiPausedAt: '2026-11-01T00:00:00Z' })).toBe(false);
    expect(riapreChatPerBlackFriday({ ...base, callGdoFutura: true })).toBe(false);
    expect(riapreChatPerBlackFriday({ ...base, lancio: true })).toBe(false);
  });
});
