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

import { aperturaBfConAppuntamentoDiAltroLead, aperturaBfSuAppuntamento, enrollLeadIntoMario, restituisciPerChatConAppuntamento, riapreChatPerBlackFriday } from './fenice-enroll';
import { sendTemplateAndLog } from './messaging';
import { MARKER_TESTO_APERTURA_BF, EVENTO_BF_SU_APPUNTAMENTO, blackFridayContextNote } from './black-friday';

const ORA = Date.parse('2026-11-08T14:07:00Z'); // 15:07 Roma, come il push di Elvi
const H = 3600_000;
const fa = (ore: number) => new Date(ORA - ore * H).toISOString();

type Chat = {
  crmLeadId: string | null; crmFunnel?: string | null; aiStatus?: string | null; botOutcome?: string | null;
  lastInboundAt?: string | null; ultimoMessaggioAt?: string | null; ultimoOutboundAt?: string | null;
  bfPartita?: boolean; aiPausedAt?: string | null; gdoAppuntamentoAt?: string | null;
  gdoAgendaAt?: string | null; botScheduledAt?: string | null;
  /** Una richiesta `bf_apertura_su_appuntamento` gia' in event_log (ritento). */
  richiestaGia?: boolean;
  /** `bot_outcome_at`: quando il bot ha fissato l'APPUNTAMENTO che e' sulla chat. */
  botOutcomeAt?: string | null;
  /** La riga `bot_intake` piu' vecchia di questo leadId (il CRM ce lo rimanda). */
  primoIntakeAt?: string | null;
  /** La lettura del primo intake fallisce. */
  errorePrimoIntake?: boolean;
};

/** Fake Supabase: la riga della chat e le letture dei messaggi che l'arruolamento fa. */
function fake(chat: Chat) {
  const calls = { updates: [] as any[], events: [] as any[] };
  const riga = {
    ai_owner: 'mario', ai_status: chat.aiStatus ?? 'closed', crm_lead_id: chat.crmLeadId,
    crm_funnel: chat.crmFunnel ?? null, bot_outcome: chat.botOutcome ?? null,
    ai_paused_at: chat.aiPausedAt ?? null, gdo_appuntamento_at: chat.gdoAppuntamentoAt ?? null,
    lancio_slug: null, lancio_fase: null, last_inbound_at: chat.lastInboundAt ?? null,
    gdo_agenda_at: chat.gdoAgendaAt ?? null, bot_scheduled_at: chat.botScheduledAt ?? null,
    bot_outcome_at: chat.botOutcomeAt ?? null,
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
      return {
        insert(p: any) { calls.events.push(p); return Promise.resolve({}); },
        select() {
          let tipo: string | null = null;
          const c: any = {
            eq: (col: string, v: string) => { if (col === 'type') tipo = v; return c; },
            order: () => c,
            limit: async () => {
              if (tipo === 'bot_intake') {
                if (chat.errorePrimoIntake) return { data: null, error: { message: 'boom' } };
                return { data: chat.primoIntakeAt ? [{ created_at: chat.primoIntakeAt }] : [], error: null };
              }
              return { data: chat.richiestaGia ? [{ id: 1 }] : [], error: null };
            },
          };
          return c;
        },
      };
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

  // PO 10/11/2026: APPUNTAMENTO del bot su un ALTRO lead → il lead nuovo non si prende,
  // torna subito ai GDO (accettato:false, chat_con_appuntamento). La chat non si tocca.
  it('APPUNTAMENTO di un altro lead, chat ferma (Sara conv 11221) → rifiuto, chat intatta', async () => {
    const { supabase, calls } = fake({
      crmLeadId: 'LEAD-APP', crmFunnel: 'CORSO 10 ORE', aiStatus: 'closed', botOutcome: 'APPUNTAMENTO',
      botScheduledAt: '2026-09-12T14:00:00Z',
      lastInboundAt: fa(30), ultimoMessaggioAt: fa(30), ultimoOutboundAt: fa(30),
    });
    const res = await enrollLeadIntoMario(supabase, ARGS);
    expect(res).toEqual({
      ok: true, conversationId: 8727,
      rifiuto: { motivo: 'chat_con_appuntamento', leadIdAppuntamento: 'LEAD-APP', appuntamento: '2026-09-12T14:00:00Z' },
    });
    expect(sendTemplateAndLog).not.toHaveBeenCalled();
    expect(calls.updates).toEqual([]);
    const tipi = calls.events.map((e: any) => e.type);
    expect(tipi).toEqual(['fenice_enroll_rifiuto_chat_con_appuntamento']);
  });

  it('APPUNTAMENTO di un altro lead, ritento dello stesso intake → stesso rifiuto, nessuna scrittura', async () => {
    const { supabase, calls } = fake({
      crmLeadId: 'LEAD-APP', crmFunnel: 'BLACK FRIDAY', aiStatus: 'closed', botOutcome: 'APPUNTAMENTO',
      lastInboundAt: fa(30), ultimoMessaggioAt: fa(30), ultimoOutboundAt: fa(30), richiestaGia: true,
    });
    const res = await enrollLeadIntoMario(supabase, ARGS);
    expect(res.rifiuto?.motivo).toBe('chat_con_appuntamento');
    expect(calls.updates).toEqual([]);
    expect(sendTemplateAndLog).not.toHaveBeenCalled();
  });

  it('APPUNTAMENTO di un altro lead con un nostro messaggio di 2 ore fa (Enrico conv 31724) → rifiuto, crm_lead_id NON passa', async () => {
    const { supabase, calls } = fake({
      crmLeadId: 'LEAD-APP', crmFunnel: 'BLACK FRIDAY', aiStatus: 'booked', botOutcome: 'APPUNTAMENTO',
      lastInboundAt: fa(3), ultimoMessaggioAt: fa(2), ultimoOutboundAt: fa(2),
    });
    const res = await enrollLeadIntoMario(supabase, ARGS);
    expect(res.rifiuto).toMatchObject({ motivo: 'chat_con_appuntamento', leadIdAppuntamento: 'LEAD-APP' });
    expect(calls.updates).toEqual([]);
    expect(calls.events.map((e: any) => e.type)).not.toContain('fenice_enroll_duplicato');
  });

  it('APPUNTAMENTO di un altro lead anche su un funnel che non e BF → stesso rifiuto', async () => {
    const { supabase, calls } = fake({
      crmLeadId: 'LEAD-APP', crmFunnel: 'TELEGRAM', aiStatus: 'closed', botOutcome: 'APPUNTAMENTO',
      lastInboundAt: fa(300), ultimoMessaggioAt: fa(300), ultimoOutboundAt: fa(300),
    });
    const res = await enrollLeadIntoMario(supabase, { ...ARGS, crmFunnel: 'CORSO 10 ORE' });
    expect(res.rifiuto?.motivo).toBe('chat_con_appuntamento');
    expect(calls.updates).toEqual([]);
    expect(sendTemplateAndLog).not.toHaveBeenCalled();
  });

  // PO 12/11/2026: "Va fatta l'apertura se l'appuntamento e' stato preso prima che il lead
  // arrivasse al bot, se no no." Il lead resta rifiutato (torna ai GDO), l'appuntamento intatto.
  const SARA: Chat = {
    crmLeadId: 'LEAD-APP', crmFunnel: 'CORSO 10 ORE', aiStatus: 'closed', botOutcome: 'APPUNTAMENTO',
    botScheduledAt: '2026-09-12T14:00:00+00:00', botOutcomeAt: '2026-09-10T09:30:00+00:00',
    lastInboundAt: fa(30), ultimoMessaggioAt: fa(30), ultimoOutboundAt: fa(30),
  };

  it('altro lead, appuntamento fissato PRIMA dell arrivo, chat ferma → rifiuto + apertura BF richiesta, appuntamento intatto', async () => {
    const { supabase, calls } = fake(SARA);
    const res = await enrollLeadIntoMario(supabase, ARGS);
    expect(res).toEqual({
      ok: true, conversationId: 8727,
      rifiuto: { motivo: 'chat_con_appuntamento', leadIdAppuntamento: 'LEAD-APP', appuntamento: '2026-09-12T14:00:00+00:00', aperturaBf: 'richiesta' },
    });
    // L'apertura la manda bf-aperture, non l'intake. Un solo update: il funnel.
    expect(sendTemplateAndLog).not.toHaveBeenCalled();
    expect(calls.updates).toEqual([{ crm_funnel: 'BLACK FRIDAY' }]);
    expect(calls.events.map((e: any) => e.type)).toEqual([EVENTO_BF_SU_APPUNTAMENTO, 'fenice_enroll_rifiuto_chat_con_appuntamento']);
    const ev = calls.events[0];
    // `crmLeadIdAppuntamento` resta il lead che ha la call: la chat non cambia padrone.
    expect(ev.payload).toMatchObject({
      conversationId: '8727', crmLeadIdBf: 'LEAD-BF', crmLeadIdAppuntamento: 'LEAD-APP', altroLead: true,
      appuntamentoFissatoIl: '2026-09-10T09:30:00+00:00', arrivoAlBot: new Date(ORA).toISOString(),
    });
    expect(calls.events[1].payload).toMatchObject({ aperturaBf: 'richiesta', regolaDate: 'appuntamento_prima_dell_arrivo' });
  });

  it('altro lead, call ancora da fare ma fissata prima dell arrivo → apertura BF richiesta lo stesso, data della call intatta', async () => {
    const { supabase, calls } = fake({ ...SARA, botScheduledAt: new Date(ORA + 20 * H).toISOString(), botOutcomeAt: fa(40) });
    const res = await enrollLeadIntoMario(supabase, ARGS);
    expect(res.rifiuto).toMatchObject({ motivo: 'chat_con_appuntamento', aperturaBf: 'richiesta' });
    expect(calls.updates).toEqual([{ crm_funnel: 'BLACK FRIDAY' }]);
  });

  it('altro lead, il CRM rimanda un lead arrivato 48h fa e l appuntamento e di 24h fa (preso DOPO l arrivo) → rifiuto semplice, chat intatta', async () => {
    const { supabase, calls } = fake({ ...SARA, botOutcomeAt: fa(24), primoIntakeAt: fa(48), lastInboundAt: fa(24), ultimoMessaggioAt: fa(24), ultimoOutboundAt: fa(24) });
    const res = await enrollLeadIntoMario(supabase, ARGS);
    expect(res.rifiuto).toEqual({ motivo: 'chat_con_appuntamento', leadIdAppuntamento: 'LEAD-APP', appuntamento: '2026-09-12T14:00:00+00:00' });
    expect(calls.updates).toEqual([]);
    expect(calls.events.map((e: any) => e.type)).toEqual(['fenice_enroll_rifiuto_chat_con_appuntamento']);
    expect(calls.events[0].payload).toMatchObject({ aperturaBf: 'no', regolaDate: 'appuntamento_dopo_l_arrivo', arrivoAlBot: fa(48) });
  });

  it('altro lead, il CRM rimanda un lead arrivato 48h fa ma l appuntamento era di prima → apertura BF richiesta', async () => {
    const { supabase } = fake({ ...SARA, primoIntakeAt: fa(48) });
    const res = await enrollLeadIntoMario(supabase, ARGS);
    expect(res.rifiuto?.aperturaBf).toBe('richiesta');
  });

  it('altro lead, date che non si sanno (bot_outcome_at vuoto, o lettura del primo intake fallita) → rifiuto semplice', async () => {
    for (const chat of [{ ...SARA, botOutcomeAt: null }, { ...SARA, errorePrimoIntake: true }]) {
      const { supabase, calls } = fake(chat);
      const res = await enrollLeadIntoMario(supabase, ARGS);
      expect(res.rifiuto).not.toHaveProperty('aperturaBf');
      expect(calls.updates).toEqual([]);
      expect(calls.events.map((e: any) => e.type)).toEqual(['fenice_enroll_rifiuto_chat_con_appuntamento']);
      expect(calls.events[0].payload).toMatchObject({ aperturaBf: 'no', regolaDate: 'dati_mancanti' });
    }
  });

  it('altro lead, appuntamento di prima ma le guardie dell apertura dicono no (BF gia partita, chat viva, ritento, handed_off, fermo, postino GDO) → rifiuto semplice', async () => {
    const casi: Chat[] = [
      { ...SARA, bfPartita: true },
      { ...SARA, lastInboundAt: fa(3), ultimoMessaggioAt: fa(3), ultimoOutboundAt: fa(3) },
      { ...SARA, ultimoOutboundAt: fa(2) },
      { ...SARA, richiestaGia: true },
      { ...SARA, aiStatus: 'handed_off' },
      { ...SARA, aiPausedAt: fa(100) },
      { ...SARA, gdoAgendaAt: fa(100) },
    ];
    for (const chat of casi) {
      const { supabase, calls } = fake(chat);
      const res = await enrollLeadIntoMario(supabase, ARGS);
      expect(res.rifiuto?.motivo).toBe('chat_con_appuntamento');
      expect(res.rifiuto).not.toHaveProperty('aperturaBf');
      expect(calls.updates).toEqual([]);
      expect(calls.events.map((e: any) => e.type)).not.toContain(EVENTO_BF_SU_APPUNTAMENTO);
    }
    expect(sendTemplateAndLog).not.toHaveBeenCalled();
  });

  it('altro lead su un funnel che non e BF, appuntamento di prima → nessuna apertura', async () => {
    const { supabase, calls } = fake(SARA);
    const res = await enrollLeadIntoMario(supabase, { ...ARGS, crmFunnel: 'CORSO 10 ORE' });
    expect(res.rifiuto).toEqual({ motivo: 'chat_con_appuntamento', leadIdAppuntamento: 'LEAD-APP', appuntamento: '2026-09-12T14:00:00+00:00' });
    expect(calls.updates).toEqual([]);
    expect(calls.events[0].payload).not.toHaveProperty('aperturaBf');
  });

  it('APPUNTAMENTO dello STESSO lead, chat non ancora BF (PO 09/11) → apertura BF richiesta, nessun rifiuto', async () => {
    const { supabase, calls } = fake({
      crmLeadId: 'LEAD-BF', crmFunnel: 'CORSO 10 ORE', aiStatus: 'closed', botOutcome: 'APPUNTAMENTO',
      botScheduledAt: '2026-11-10T10:00:00Z',
      lastInboundAt: fa(30), ultimoMessaggioAt: fa(30), ultimoOutboundAt: fa(30),
    });
    const res = await enrollLeadIntoMario(supabase, ARGS);
    expect(res).toMatchObject({ ok: true, conversationId: 8727, duplicato: true });
    expect(res).not.toHaveProperty('rifiuto');
    expect(calls.updates).toEqual([{ crm_funnel: 'BLACK FRIDAY' }]);
    const ev = calls.events.find((e: any) => e.type === EVENTO_BF_SU_APPUNTAMENTO);
    expect(ev?.payload).toMatchObject({ conversationId: '8727', crmLeadIdBf: 'LEAD-BF', crmLeadIdAppuntamento: 'LEAD-BF' });
  });

  it('chat adottata senza leadId con APPUNTAMENTO (il lead stesso che il CRM conosce adesso) → nessun rifiuto', async () => {
    const { supabase } = fake({
      crmLeadId: null, crmFunnel: 'BLACK FRIDAY', aiStatus: 'booked', botOutcome: 'APPUNTAMENTO',
      lastInboundAt: fa(1), ultimoMessaggioAt: fa(1), ultimoOutboundAt: fa(1),
    });
    const res = await enrollLeadIntoMario(supabase, ARGS);
    expect(res).not.toHaveProperty('rifiuto');
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

describe('restituisciPerChatConAppuntamento — regole (PO 10/11/2026)', () => {
  it('APPUNTAMENTO di un altro lead → si', () => {
    expect(restituisciPerChatConAppuntamento({ crmLeadIdPrima: 'A', crmLeadIdNuovo: 'B', botOutcome: 'APPUNTAMENTO' })).toBe(true);
  });
  it('no: stesso lead, chat adottata, lettura fallita, intake senza leadId, esito diverso', () => {
    expect(restituisciPerChatConAppuntamento({ crmLeadIdPrima: 'B', crmLeadIdNuovo: 'B', botOutcome: 'APPUNTAMENTO' })).toBe(false);
    expect(restituisciPerChatConAppuntamento({ crmLeadIdPrima: null, crmLeadIdNuovo: 'B', botOutcome: 'APPUNTAMENTO' })).toBe(false);
    expect(restituisciPerChatConAppuntamento({ crmLeadIdPrima: undefined, crmLeadIdNuovo: 'B', botOutcome: 'APPUNTAMENTO' })).toBe(false);
    expect(restituisciPerChatConAppuntamento({ crmLeadIdPrima: 'A', crmLeadIdNuovo: null, botOutcome: 'APPUNTAMENTO' })).toBe(false);
    expect(restituisciPerChatConAppuntamento({ crmLeadIdPrima: 'A', crmLeadIdNuovo: 'B', botOutcome: 'INTERROTTO' })).toBe(false);
    expect(restituisciPerChatConAppuntamento({ crmLeadIdPrima: 'A', crmLeadIdNuovo: 'B', botOutcome: null })).toBe(false);
  });
});

describe('aperturaBfConAppuntamentoDiAltroLead — prima o dopo l arrivo al bot (PO 12/11/2026)', () => {
  const NOW = Date.parse('2026-11-12T10:00:00Z');
  // Senza il secondo argomento = primo intake (null); `undefined` esplicito = lettura fallita.
  const d = (appuntamentoFissatoIl: string | null | undefined, ...resto: [primoIntakeIl?: string | null, nowMs?: number]) =>
    aperturaBfConAppuntamentoDiAltroLead({
      appuntamentoFissatoIl, primoIntakeIl: resto.length > 0 ? resto[0] : null, nowMs: resto[1] ?? NOW,
    });

  it('fissato settimane prima, primo intake adesso → apri', () => {
    expect(d('2026-10-08T07:09:36.287+00:00')).toEqual({ apri: true, motivo: 'appuntamento_prima_dell_arrivo', arrivoAlBot: '2026-11-12T10:00:00.000Z' });
  });
  it('fissato un millisecondo prima dell arrivo → apri', () => {
    expect(d('2026-11-12T09:59:59.999Z').apri).toBe(true);
  });
  it('stesso istante → no ("prima" e stretto)', () => {
    expect(d('2026-11-12T10:00:00.000Z')).toMatchObject({ apri: false, motivo: 'stesso_istante' });
    expect(d('2026-11-11T08:00:00Z', '2026-11-11T08:00:00.000+00:00')).toMatchObject({ apri: false, motivo: 'stesso_istante' });
    // Lo stesso istante scritto in due fusi.
    expect(d('2026-11-11T09:00:00+01:00', '2026-11-11T08:00:00Z')).toMatchObject({ apri: false, motivo: 'stesso_istante' });
  });
  it('lead gia arrivato ieri e appuntamento fissato dopo quell arrivo → no', () => {
    expect(d('2026-11-11T15:00:00Z', '2026-11-11T08:00:00Z')).toEqual({ apri: false, motivo: 'appuntamento_dopo_l_arrivo', arrivoAlBot: '2026-11-11T08:00:00.000Z' });
  });
  it('lead gia arrivato ieri ma appuntamento precedente → apri, e l arrivo e il primo intake, non adesso', () => {
    expect(d('2026-11-10T15:00:00Z', '2026-11-11T08:00:00Z')).toEqual({ apri: true, motivo: 'appuntamento_prima_dell_arrivo', arrivoAlBot: '2026-11-11T08:00:00.000Z' });
  });
  it('fusi orari: conta l istante, non la stringa', () => {
    // 10:30 di Roma = 09:30Z, prima delle 09:45Z (come stringa "10:30" verrebbe dopo "09:45").
    expect(d('2026-11-11T10:30:00+01:00', '2026-11-11T09:45:00Z').apri).toBe(true);
    // 09:30Z, dopo le 10:15 di Roma = 09:15Z (come stringa verrebbe prima).
    expect(d('2026-11-11T09:30:00Z', '2026-11-11T10:15:00+01:00')).toMatchObject({ apri: false, motivo: 'appuntamento_dopo_l_arrivo' });
    // A cavallo della mezzanotte: 00:30 di Roma del 12 = 23:30Z dell'11, prima delle 23:45Z.
    expect(d('2026-11-12T00:30:00+01:00', '2026-11-11T23:45:00Z').apri).toBe(true);
    // Cambio dell'ora (25/10/2026): 02:30+02:00 = 00:30Z, prima di 02:10+01:00 = 01:10Z.
    expect(d('2026-10-25T02:30:00+02:00', '2026-10-25T02:10:00+01:00').apri).toBe(true);
  });
  it('i formati di Postgres (spazio, fuso di sole ore, microsecondi) si leggono', () => {
    expect(d('2026-11-10 06:55:43.786+00', '2026-11-11 09:54:10.198695+00')).toEqual({ apri: true, motivo: 'appuntamento_prima_dell_arrivo', arrivoAlBot: '2026-11-11T09:54:10.198Z' });
    expect(d('2026-11-10T06:55:43+0100').apri).toBe(true);
  });
  it('date senza fuso → dati mancanti, niente apertura', () => {
    expect(d('2026-10-08T07:09:36')).toMatchObject({ apri: false, motivo: 'dati_mancanti' });
    expect(d('2026-10-08')).toMatchObject({ apri: false, motivo: 'dati_mancanti' });
    expect(d('2026-10-08T07:09:36Z', '2026-11-11 08:00:00')).toEqual({ apri: false, motivo: 'dati_mancanti', arrivoAlBot: null });
  });
  it('date mancanti o illeggibili, lettura fallita → niente apertura', () => {
    expect(d(null)).toMatchObject({ apri: false, motivo: 'dati_mancanti' });
    expect(d(undefined)).toMatchObject({ apri: false, motivo: 'dati_mancanti' });
    expect(d('')).toMatchObject({ apri: false, motivo: 'dati_mancanti' });
    expect(d('ieri')).toMatchObject({ apri: false, motivo: 'dati_mancanti' });
    expect(d('2026-13-45T99:00:00Z')).toMatchObject({ apri: false, motivo: 'dati_mancanti' });
    expect(d('2026-10-08T07:09:36Z', undefined)).toEqual({ apri: false, motivo: 'dati_mancanti', arrivoAlBot: null });
    expect(d('2026-10-08T07:09:36Z', 'boh')).toEqual({ apri: false, motivo: 'dati_mancanti', arrivoAlBot: null });
    expect(d('2026-10-08T07:09:36Z', null, NaN)).toEqual({ apri: false, motivo: 'dati_mancanti', arrivoAlBot: null });
  });
  it('primo intake con l orologio avanti rispetto a noi → l arrivo e adesso', () => {
    expect(d('2026-11-12T09:00:00Z', '2026-11-12T10:05:00Z')).toEqual({ apri: true, motivo: 'appuntamento_prima_dell_arrivo', arrivoAlBot: '2026-11-12T10:00:00.000Z' });
  });
  it('appuntamento "fissato nel futuro" (dato impossibile) → no', () => {
    expect(d('2026-11-13T09:00:00Z')).toMatchObject({ apri: false, motivo: 'appuntamento_dopo_l_arrivo' });
  });
});

describe('aperturaBfSuAppuntamento — regole', () => {
  const base = {
    blackFriday: true, crmLeadIdPrima: 'A' as string | null | undefined, crmLeadIdNuovo: 'B' as string | null,
    crmFunnelPrima: 'CORSO 10 ORE' as string | null, aiStatus: 'closed' as string | null, botOutcome: 'APPUNTAMENTO' as string | null,
    aiPausedAt: null as string | null, gdoAgendaAt: null as string | null, lancio: false, giaRichiesta: false, aperturaBfGiaPartita: false,
    ultimoInboundMs: ORA - 30 * H as number | null, ultimoOutboundMs: ORA - 30 * H as number | null, nowMs: ORA,
  };
  it('caso base → si', () => expect(aperturaBfSuAppuntamento(base)).toBe(true));
  it('solo con APPUNTAMENTO', () => {
    expect(aperturaBfSuAppuntamento({ ...base, botOutcome: 'INTERROTTO' })).toBe(false);
    expect(aperturaBfSuAppuntamento({ ...base, botOutcome: null })).toBe(false);
  });
  it('no: ritento, apertura BF gia partita, chat gia BF con lo stesso lead', () => {
    expect(aperturaBfSuAppuntamento({ ...base, giaRichiesta: true })).toBe(false);
    expect(aperturaBfSuAppuntamento({ ...base, aperturaBfGiaPartita: true })).toBe(false);
    expect(aperturaBfSuAppuntamento({ ...base, crmLeadIdPrima: 'B', crmFunnelPrima: 'BLACK FRIDAY' })).toBe(false);
  });
  it('no: chat viva, persona in carico, postino GDO, lancio, lettura fallita, non BF', () => {
    expect(aperturaBfSuAppuntamento({ ...base, ultimoInboundMs: ORA - 2 * H })).toBe(false);
    expect(aperturaBfSuAppuntamento({ ...base, ultimoOutboundMs: ORA - 2 * H })).toBe(false);
    expect(aperturaBfSuAppuntamento({ ...base, aiStatus: 'handed_off' })).toBe(false);
    expect(aperturaBfSuAppuntamento({ ...base, aiPausedAt: '2026-11-01T00:00:00Z' })).toBe(false);
    expect(aperturaBfSuAppuntamento({ ...base, gdoAgendaAt: '2026-11-01T00:00:00Z' })).toBe(false);
    expect(aperturaBfSuAppuntamento({ ...base, lancio: true })).toBe(false);
    expect(aperturaBfSuAppuntamento({ ...base, crmLeadIdPrima: undefined })).toBe(false);
    expect(aperturaBfSuAppuntamento({ ...base, blackFriday: false })).toBe(false);
  });
});

describe('blackFridayContextNote — call gia fissata (PO 09/11)', () => {
  const NOTA = { vslLink: 'https://lp.example/vsl', scadenza: null, posti: 30, nowMs: ORA, ingresso: 'inserzione' as const };
  it('call futura: data e ora, niente nuova call, niente form, niente qualifica', () => {
    const t = blackFridayContextNote({ ...NOTA, callGiaFissata: { atIso: '2026-11-10T10:00:00Z' } });
    expect(t).toContain("CALL GIA' FISSATA");
    expect(t).toContain('alle 11:00');
    expect(t).toContain("NON fissare un'altra videocall");
    expect(t).not.toContain('FLUSSO:');
    expect(t).not.toContain("SE LA CALL E' GIA' PASSATA");
  });
  it('call passata: non ne fissa un altra, la segnala nella nota', () => {
    const t = blackFridayContextNote({ ...NOTA, callGiaFissata: { atIso: '2026-11-08T10:00:00Z' } });
    expect(t).toContain("(gia' passata)");
    expect(t).toContain("SE LA CALL E' GIA' PASSATA");
  });
  it('senza call: la nota di sempre', () => {
    const t = blackFridayContextNote(NOTA);
    expect(t).not.toContain("CALL GIA' FISSATA");
    expect(t).toContain('FLUSSO:');
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
