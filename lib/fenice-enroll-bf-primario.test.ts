import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const P = 'whatsapp:+393520413199';
const N8061 = 'whatsapp:+393520158061';

vi.mock('./messaging', () => ({
  findOrCreateLeadConversation: vi.fn(async () => ({ leadId: 7, conversationId: 19348, waNumber: 'whatsapp:+393520413199' })),
  sendTemplateAndLog: vi.fn(async () => ({ ok: true, sid: 'SM_TEST' })),
}));
vi.mock('./lancio-settings', () => ({ getLancioSettings: vi.fn(async () => ({ attivo: false })) }));
vi.mock('./scelta-mittente', () => ({
  // Il numero scelto fra gli ALTRI (la regola passa `escludiPrimario`).
  scegliMittenteNuovo: vi.fn(async () => ({ from: 'whatsapp:+393520158061', secondario: true, scartati: [], motivo: 'scelto' })),
  sidAperturaMario: vi.fn(() => ['HX_OPEN']),
  chatEsistente: vi.fn(async () => true),
  registraAperturaMario: vi.fn(async () => undefined),
}));
vi.mock('./black-friday-apertura', () => ({
  aperturaBlackFriday: vi.fn(async () => ({ scelta: 'template_bf', sid: 'HX_BF' })),
}));

import { enrollLeadIntoMario } from './fenice-enroll';
import { findOrCreateLeadConversation, sendTemplateAndLog } from './messaging';
import { scegliMittenteNuovo, chatEsistente } from './scelta-mittente';
import { aperturaBlackFriday } from './black-friday-apertura';
import {
  parseRegolaBfPrimario, bfDaToglierDalPrimario, leadHaScrittoInChat, KEY_BF_PRIMARIO, EVENTO_BF_FUORI_DAL_PRIMARIO,
} from './bf-primario';

const ORA = Date.parse('2026-11-11T10:29:00Z'); // 11:29 Roma, in fascia
const H = 3600_000;
const fa = (ore: number) => new Date(ORA - ore * H).toISOString();

type Opzioni = {
  /** Messaggi del lead nella conversazione; null = il conteggio fallisce. */
  inbound: number | null;
  /** `app_settings.bf_primario_solo_chat_passata`; undefined = riga assente. */
  regola?: unknown;
  /** Un nostro messaggio partito nelle ultime 12 ore (guardia dei ritenti). */
  outboundRecente?: boolean;
};

/**
 * La chat di un lead vecchio (settembre), ferma da settimane, a cui il CRM manda un lead
 * Black Friday con un leadId nuovo: e' il caso delle 35 aperture BF uscite dal 3199
 * l'11-12/11 (`fenice_enroll_chat_ferma_ripresa` + `fenice_enroll`).
 */
function fake(o: Opzioni) {
  const calls = { updates: [] as Record<string, unknown>[], events: [] as { type: string; payload: Record<string, unknown> }[] };
  const riga = {
    ai_owner: 'mario', ai_status: 'closed', crm_lead_id: 'LEAD-VECCHIO', crm_funnel: 'CORSO 10 ORE',
    bot_outcome: 'NON_RISPOSTO', bot_scheduled_at: null, ai_paused_at: null, gdo_appuntamento_at: null,
    gdo_agenda_at: null, lancio_slug: null, lancio_fase: null,
    last_inbound_at: o.inbound ? fa(24 * 40) : null,
  };
  const ultimo = o.outboundRecente ? fa(2) : fa(24 * 45);
  const supabase: any = {
    from(table: string) {
      if (table === 'app_settings') {
        return { select: () => ({ eq: (_c: string, k: string) => ({
          maybeSingle: async () => ({ data: k === KEY_BF_PRIMARIO && o.regola !== undefined ? { value: o.regola } : null, error: null }),
        }) }) };
      }
      if (table === 'conversations') {
        return {
          update(payload: Record<string, unknown>) {
            calls.updates.push(payload);
            const c: any = { eq: () => c, or: () => c, then: (r: any) => r({}) };
            return c;
          },
          select: () => ({ eq: () => ({ single: async () => ({ data: riga, error: null }) }) }),
        };
      }
      if (table === 'messages') {
        return {
          select(_c: string, opz?: { head?: boolean }) {
            if (opz?.head) {
              let direzione = '';
              const k: any = {
                eq: (col: string, v: string) => { if (col === 'direction') direzione = v; return k; },
                not: () => k,
                then: (r: any) => r(direzione === 'in'
                  ? (o.inbound === null ? { count: null, error: { message: 'giu' } } : { count: o.inbound, error: null })
                  : { count: 1, error: null }),
              };
              return k;
            }
            let finestra: string | null = null;
            const c: any = {
              eq: () => c, not: () => c, order: () => c, ilike: () => c,
              gte: (_col: string, v: string) => { finestra = v; return c; },
              limit: async () => {
                // Con una soglia e' la guardia dei ritenti (outbound nelle ultime 12h);
                // senza e' l'ultimo messaggio della chat.
                if (finestra) return { data: ultimo >= finestra ? [{ id: 1 }] : [], error: null };
                return { data: [{ created_at: ultimo }], error: null };
              },
            };
            return c;
          },
        };
      }
      return {
        insert(p: { type: string; payload: Record<string, unknown> }) { calls.events.push(p); return Promise.resolve({}); },
        select() { const c: any = { eq: () => c, limit: async () => ({ data: [], error: null }) }; return c; },
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
  vi.stubEnv('TWILIO_WHATSAPP_NUMBER_FENICE', P);
  vi.stubEnv('BOT_NUMERI_SECONDARI', N8061);
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

const ARGS = { phone: '+393331234567', firstName: 'Giulia Rossi', crmLeadId: 'LEAD-BF', crmFunnel: 'BLACK FRIDAY' };
const mittenteInvio = () => vi.mocked(sendTemplateAndLog).mock.calls[0][5];
const tipi = (calls: { events: { type: string }[] }) => calls.events.map((e) => e.type);

describe('enrollLeadIntoMario — Black Friday e il 3199 (PO 12/11/2026)', () => {
  it('chat passata sul 3199 (il lead ci ha scritto) → l apertura BF resta sul 3199', async () => {
    const { supabase, calls } = fake({ inbound: 4 });
    const res = await enrollLeadIntoMario(supabase, ARGS);
    expect(res).toMatchObject({ ok: true, conversationId: 19348 });
    expect(sendTemplateAndLog).toHaveBeenCalledOnce();
    expect(vi.mocked(sendTemplateAndLog).mock.calls[0][4]).toBe('Apertura Black Friday');
    expect(mittenteInvio()).toBe(P);
    expect(vi.mocked(aperturaBlackFriday).mock.calls[0][1]).toBe(P);
    expect(calls.updates.some((u) => 'wa_number' in u)).toBe(false);
    expect(tipi(calls)).not.toContain(EVENTO_BF_FUORI_DAL_PRIMARIO);
  });

  it('chat sul 3199 con la sola vecchia apertura mai risposta → parte da un altro numero e la chat lo segue', async () => {
    const { supabase, calls } = fake({ inbound: 0 });
    const res = await enrollLeadIntoMario(supabase, ARGS);
    expect(res).toMatchObject({ ok: true, conversationId: 19348 });
    expect(sendTemplateAndLog).toHaveBeenCalledOnce();
    expect(mittenteInvio()).toBe(N8061);
    // L'approvazione del template BF si verifica sul numero da cui parte davvero.
    expect(vi.mocked(aperturaBlackFriday).mock.calls[0][1]).toBe(N8061);
    expect(calls.updates).toContainEqual({ wa_number: N8061 });
    const ev = calls.events.find((e) => e.type === EVENTO_BF_FUORI_DAL_PRIMARIO);
    expect(ev?.payload).toMatchObject({ conversationId: 19348, da: P, a: N8061, punto: 'arruolamento' });
  });

  it('la scelta del numero per un lead BF esclude il 3199: una chat NUOVA non nasce li', async () => {
    vi.mocked(chatEsistente).mockResolvedValueOnce(false);
    vi.mocked(findOrCreateLeadConversation).mockResolvedValueOnce({ leadId: 9, conversationId: 40001, waNumber: N8061 });
    const { supabase } = fake({ inbound: 0 });
    await enrollLeadIntoMario(supabase, ARGS);
    expect(vi.mocked(scegliMittenteNuovo).mock.calls[0][1]).toMatchObject({ senzaTettiSoloHigh: true, escludiPrimario: true });
    expect(vi.mocked(findOrCreateLeadConversation).mock.calls[0][2]).toEqual({ mittente: N8061 });
    expect(mittenteInvio()).toBe(N8061);
  });

  it('nessun altro numero utilizzabile (la scelta ripiega sul 3199) → resta sul 3199, niente spostamento', async () => {
    vi.mocked(scegliMittenteNuovo).mockResolvedValueOnce({ from: P, secondario: false, scartati: [], motivo: 'nessun_candidato' });
    const { supabase, calls } = fake({ inbound: 0 });
    await enrollLeadIntoMario(supabase, ARGS);
    expect(mittenteInvio()).toBe(P);
    expect(calls.updates.some((u) => 'wa_number' in u)).toBe(false);
  });

  it('conteggio dei messaggi fallito → nel dubbio la chat non si sposta', async () => {
    const { supabase, calls } = fake({ inbound: null });
    await enrollLeadIntoMario(supabase, ARGS);
    expect(mittenteInvio()).toBe(P);
    expect(calls.updates.some((u) => 'wa_number' in u)).toBe(false);
  });

  it('regola spenta da impostazione ("off") → tutto come prima: dal 3199, e la scelta non lo esclude', async () => {
    const { supabase, calls } = fake({ inbound: 0, regola: 'off' });
    await enrollLeadIntoMario(supabase, ARGS);
    expect(vi.mocked(scegliMittenteNuovo).mock.calls[0][1]).toMatchObject({ escludiPrimario: false });
    expect(mittenteInvio()).toBe(P);
    expect(calls.updates.some((u) => 'wa_number' in u)).toBe(false);
    expect(tipi(calls)).not.toContain(EVENTO_BF_FUORI_DAL_PRIMARIO);
  });

  it('apertura fermata dalla guardia dei ritenti → la chat NON cambia numero', async () => {
    // Stesso lead gia' sulla chat (niente "chat ferma") e un nostro messaggio 2 ore fa.
    const { supabase, calls } = fake({ inbound: 0, outboundRecente: true });
    const res = await enrollLeadIntoMario(supabase, { ...ARGS, crmLeadId: 'LEAD-VECCHIO' });
    expect(sendTemplateAndLog).not.toHaveBeenCalled();
    expect(res.ok).toBe(true);
    expect(calls.updates.some((u) => 'wa_number' in u)).toBe(false);
    expect(tipi(calls)).not.toContain(EVENTO_BF_FUORI_DAL_PRIMARIO);
  });

  it('un lead NON Black Friday sulla stessa chat del 3199 non e toccato dalla regola', async () => {
    const { supabase, calls } = fake({ inbound: 0 });
    await enrollLeadIntoMario(supabase, { ...ARGS, crmFunnel: 'CORSO 10 ORE' });
    expect(vi.mocked(scegliMittenteNuovo).mock.calls[0][1]).toMatchObject({ escludiPrimario: false });
    expect(mittenteInvio()).toBe(P);
    expect(calls.updates.some((u) => 'wa_number' in u)).toBe(false);
  });
});

describe('bf-primario — impostazione e letture', () => {
  it('assente o qualunque altra cosa = accesa; solo off/false la spengono', () => {
    for (const v of [undefined, null, 'on', true, {}, { attivo: true }, 'boh']) expect(parseRegolaBfPrimario(v)).toBe(true);
    for (const v of ['off', 'OFF', false, 0, 'no', { attivo: false }, { attivo: 'off' }]) expect(parseRegolaBfPrimario(v)).toBe(false);
  });

  it('leadHaScrittoInChat: true / false / null se la lettura fallisce', async () => {
    expect(await leadHaScrittoInChat(fake({ inbound: 2 }).supabase, 1)).toBe(true);
    expect(await leadHaScrittoInChat(fake({ inbound: 0 }).supabase, 1)).toBe(false);
    expect(await leadHaScrittoInChat(fake({ inbound: null }).supabase, 1)).toBeNull();
  });

  it('bfDaToglierDalPrimario: solo chat sul primario, regola accesa, lead che non ha mai scritto', async () => {
    const base = { attiva: true, conversationId: 1, numeroChat: P, primario: '+393520413199' };
    expect(await bfDaToglierDalPrimario(fake({ inbound: 0 }).supabase, base)).toBe(true);
    expect(await bfDaToglierDalPrimario(fake({ inbound: 3 }).supabase, base)).toBe(false);
    expect(await bfDaToglierDalPrimario(fake({ inbound: null }).supabase, base)).toBe(false);
    expect(await bfDaToglierDalPrimario(fake({ inbound: 0 }).supabase, { ...base, attiva: false })).toBe(false);
    expect(await bfDaToglierDalPrimario(fake({ inbound: 0 }).supabase, { ...base, numeroChat: N8061 })).toBe(false);
    expect(await bfDaToglierDalPrimario(fake({ inbound: 0 }).supabase, { ...base, primario: undefined })).toBe(false);
  });
});
