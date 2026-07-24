import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./messaging', () => ({
  findOrCreateLeadConversation: vi.fn(async () => ({ leadId: 7, conversationId: 42 })),
  sendTemplateAndLog: vi.fn(async () => ({ ok: true, sid: 'SM_TEST' })),
}));
vi.mock('./sequence', () => ({
  inSendWindow: vi.fn(() => true),
}));

import { enrollLeadIntoMario } from './fenice-enroll';
import { sendTemplateAndLog } from './messaging';
import { inSendWindow } from './sequence';

/** Fake del client Supabase: traccia update su conversations ed insert su event_log. */
function makeSupabase() {
  const calls = { updates: [] as any[], events: [] as any[] };
  const supabase: any = {
    from(table: string) {
      if (table === 'conversations') {
        return {
          update(payload: any) { calls.updates.push(payload); return { eq() { return Promise.resolve({}); } }; },
        };
      }
      return { insert(payload: any) { calls.events.push(payload); return Promise.resolve({}); } };
    },
  };
  return { supabase, calls };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('FENICE_OPENING_TEMPLATE_SID', 'HX_OPENING');
  vi.stubEnv('TWILIO_WHATSAPP_NUMBER_FENICE', 'whatsapp:+390000000000');
});
afterEach(() => { vi.unstubAllEnvs(); });

describe('enrollLeadIntoMario — apertura differita fuori fascia', () => {
  it('in fascia (es. 10:00 Rome) → invio apertura, update conv, event fenice_enroll', async () => {
    vi.mocked(inSendWindow).mockReturnValue(true);
    const { supabase, calls } = makeSupabase();

    const res = await enrollLeadIntoMario(supabase, {
      phone: '+393331234567', firstName: 'Anna', crmLeadId: 'crm-1', crmFunnel: 'H',
    });

    expect(res).toMatchObject({ ok: true, conversationId: 42, sid: 'SM_TEST' });
    expect(res.deferred ?? false).toBe(false);
    expect(sendTemplateAndLog).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendTemplateAndLog).mock.calls[0].slice(1, 6)).toEqual(
      [42, '+393331234567', 'HX_OPENING', 'Fenice apertura', 'whatsapp:+390000000000'],
    );
    expect(calls.updates).toHaveLength(1);
    expect(calls.updates[0]).toMatchObject({
      ai_owner: 'mario', ai_status: 'active', crm_lead_id: 'crm-1', crm_funnel: 'H',
    });
    expect(calls.updates[0].ai_started_at).toBeTruthy();
    expect(calls.events.some((e) => e.type === 'fenice_enroll')).toBe(true);
    expect(calls.events.some((e) => e.type === 'fenice_enroll_deferred')).toBe(false);
  });

  it('fuori fascia (es. 23:00 Rome) → NESSUN invio, update conv comunque, event deferred, deferred:true', async () => {
    vi.mocked(inSendWindow).mockReturnValue(false);
    const { supabase, calls } = makeSupabase();

    const res = await enrollLeadIntoMario(supabase, {
      phone: '+393331234567', firstName: 'Anna', crmLeadId: 'crm-1', crmFunnel: 'H',
    });

    expect(res).toMatchObject({ ok: true, conversationId: 42, deferred: true });
    expect(sendTemplateAndLog).not.toHaveBeenCalled();
    // L'update conversazione va fatto comunque: il cron sequence-touches troverà la conv attiva senza outbound.
    expect(calls.updates).toHaveLength(1);
    expect(calls.updates[0]).toMatchObject({
      ai_owner: 'mario', ai_status: 'active', crm_lead_id: 'crm-1', crm_funnel: 'H',
    });
    expect(calls.updates[0].ai_started_at).toBeTruthy();
    const deferredEvt = calls.events.find((e) => e.type === 'fenice_enroll_deferred');
    expect(deferredEvt).toBeTruthy();
    expect(deferredEvt.level).toBe('info');
    expect(deferredEvt.message).toContain('+393331234567');
    expect(calls.events.some((e) => e.type === 'fenice_enroll')).toBe(false);
  });

  it('in fascia con invio fallito → ok:false, event send_error (nessuna regressione)', async () => {
    vi.mocked(inSendWindow).mockReturnValue(true);
    vi.mocked(sendTemplateAndLog).mockResolvedValueOnce({ ok: false, error: 'twilio boom' });
    const { supabase, calls } = makeSupabase();

    const res = await enrollLeadIntoMario(supabase, { phone: '+393331234567' });

    expect(res.ok).toBe(false);
    expect(res.error).toBe('twilio boom');
    expect(calls.events.some((e) => e.type === 'send_error' && e.level === 'error')).toBe(true);
  });
});
