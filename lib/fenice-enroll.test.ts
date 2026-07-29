import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./messaging', () => ({
  findOrCreateLeadConversation: vi.fn(async () => ({ leadId: 7, conversationId: 42 })),
  sendTemplateAndLog: vi.fn(async () => ({ ok: true, sid: 'SM_TEST' })),
}));
vi.mock('./sequence', () => ({
  inSendWindow: vi.fn(() => true),
}));

import { enrollGdoLeadAsPostino, enrollLeadIntoMario } from './fenice-enroll';
import { findOrCreateLeadConversation, sendTemplateAndLog } from './messaging';
import { inSendWindow } from './sequence';
import { openingBody } from './persona';

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

describe('enrollLeadIntoMario — selezione apertura per-funnel A/B (NEW_OPENING_ENABLED)', () => {
  function stubOpeningSids() {
    vi.stubEnv('OPENING_SID_C1', 'HX_C1');
    vi.stubEnv('OPENING_SID_C2', 'HX_C2');
    vi.stubEnv('OPENING_SID_T1', 'HX_T1');
    vi.stubEnv('OPENING_SID_T2', 'HX_T2');
    vi.stubEnv('OPENING_SID_J1', 'HX_J1');
    vi.stubEnv('OPENING_SID_J2', 'HX_J2');
  }

  beforeEach(() => {
    vi.mocked(inSendWindow).mockReturnValue(true);
  });

  it('flag on, CORSO 10 ORE, conv pari (42) → OPENING_SID_C2, variables {1:nome}, body variante 2', async () => {
    vi.stubEnv('NEW_OPENING_ENABLED', '1');
    stubOpeningSids();
    const { supabase, calls } = makeSupabase();

    const res = await enrollLeadIntoMario(supabase, {
      phone: '+393331234567', firstName: 'Anna', crmFunnel: 'CORSO 10 ORE',
    });

    expect(res).toMatchObject({ ok: true, conversationId: 42 });
    const call = vi.mocked(sendTemplateAndLog).mock.calls[0];
    expect(call.slice(1, 6)).toEqual(
      [42, '+393331234567', 'HX_C2', 'Apertura OPENING_SID_C2', 'whatsapp:+390000000000'],
    );
    expect(call[6]).toEqual({ '1': 'Anna' });
    expect(call[7]).toBe(openingBody('corso10', 2, 'Anna'));
    expect(calls.events.some((e) => e.type === 'opening_config_error')).toBe(false);
  });

  it('flag on, conv dispari (43) → variante 1 (parità id) → OPENING_SID_C1', async () => {
    vi.stubEnv('NEW_OPENING_ENABLED', '1');
    stubOpeningSids();
    vi.mocked(findOrCreateLeadConversation).mockResolvedValueOnce({ leadId: 7, conversationId: 43 } as never);
    const { supabase } = makeSupabase();

    const res = await enrollLeadIntoMario(supabase, {
      phone: '+393331234567', firstName: 'Anna', crmFunnel: 'CORSO 10 ORE',
    });

    expect(res.conversationId).toBe(43);
    const call = vi.mocked(sendTemplateAndLog).mock.calls[0];
    expect(call[3]).toBe('HX_C1');
    expect(call[4]).toBe('Apertura OPENING_SID_C1');
    expect(call[7]).toBe(openingBody('corso10', 1, 'Anna'));
  });

  it('flag on, TELEGRAM → SID T*, JOB SIMULATOR → SID J*', async () => {
    vi.stubEnv('NEW_OPENING_ENABLED', '1');
    stubOpeningSids();
    const { supabase } = makeSupabase();

    await enrollLeadIntoMario(supabase, { phone: '+393331234567', firstName: 'Anna', crmFunnel: 'TELEGRAM' });
    await enrollLeadIntoMario(supabase, { phone: '+393331234567', firstName: 'Anna', crmFunnel: 'JOB SIMULATOR' });

    const calls = vi.mocked(sendTemplateAndLog).mock.calls;
    expect(calls[0][3]).toBe('HX_T2'); // conv 42 → variante 2
    expect(calls[0][7]).toBe(openingBody('telegram', 2, 'Anna'));
    expect(calls[1][3]).toBe('HX_J2');
    expect(calls[1][7]).toBe(openingBody('jobsim', 2, 'Anna'));
  });

  it('flag on senza nome → variables {1: a te}', async () => {
    vi.stubEnv('NEW_OPENING_ENABLED', '1');
    stubOpeningSids();
    const { supabase } = makeSupabase();

    await enrollLeadIntoMario(supabase, { phone: '+393331234567', crmFunnel: 'CORSO 10 ORE' });

    const call = vi.mocked(sendTemplateAndLog).mock.calls[0];
    expect(call[6]).toEqual({ '1': 'a te' });
    expect(call[7]).toBe(openingBody('corso10', 2, null));
  });

  it('il CRM manda nome e cognome → nel template va solo il nome', async () => {
    vi.stubEnv('NEW_OPENING_ENABLED', '1');
    stubOpeningSids();
    const { supabase } = makeSupabase();

    await enrollLeadIntoMario(supabase, {
      phone: '+393331234567', firstName: 'ANNA BIANCHI', crmFunnel: 'CORSO 10 ORE',
    });

    const call = vi.mocked(sendTemplateAndLog).mock.calls[0];
    expect(call[6]).toEqual({ '1': 'Anna' });
    expect(call[7]).toContain('Ciao Anna,');
    expect(call[7]).not.toContain('BIANCHI');
  });

  it('apertura legacy: nome e cognome → solo il nome anche nel template vecchio', async () => {
    const { supabase } = makeSupabase();

    await enrollLeadIntoMario(supabase, { phone: '+393331234567', firstName: 'mario rossi' });

    const call = vi.mocked(sendTemplateAndLog).mock.calls[0];
    expect(call[6]).toEqual({ '3': 'Mario' });
    expect(call[7]).toContain('Buongiorno Mario,');
  });

  it('flag on ma SID env mancante → fallback INTERO al legacy + event opening_config_error (una volta)', async () => {
    vi.stubEnv('NEW_OPENING_ENABLED', '1');
    // Nessuna OPENING_SID_* stubbata: la selezione non trova il SID.
    const { supabase, calls } = makeSupabase();

    const res = await enrollLeadIntoMario(supabase, {
      phone: '+393331234567', firstName: 'Anna', crmFunnel: 'CORSO 10 ORE',
    });

    expect(res).toMatchObject({ ok: true, conversationId: 42, sid: 'SM_TEST' });
    const call = vi.mocked(sendTemplateAndLog).mock.calls[0];
    // Ramo legacy identico: template Mario, label e variables legacy ({'3': nome}).
    expect(call.slice(1, 6)).toEqual(
      [42, '+393331234567', 'HX_OPENING', 'Fenice apertura', 'whatsapp:+390000000000'],
    );
    expect(call[6]).toEqual({ '3': 'Anna' });
    const cfgErrs = calls.events.filter((e) => e.type === 'opening_config_error');
    expect(cfgErrs).toHaveLength(1);
    expect(cfgErrs[0].level).toBe('error');
    expect(calls.events.some((e) => e.type === 'fenice_enroll')).toBe(true);
  });

  it('flag off → ramo legacy identico anche con le OPENING_SID_* configurate', async () => {
    // NEW_OPENING_ENABLED non impostata (o !== "1")
    stubOpeningSids();
    const { supabase, calls } = makeSupabase();

    const res = await enrollLeadIntoMario(supabase, {
      phone: '+393331234567', firstName: 'Anna', crmFunnel: 'CORSO 10 ORE',
    });

    expect(res).toMatchObject({ ok: true, conversationId: 42, sid: 'SM_TEST' });
    const call = vi.mocked(sendTemplateAndLog).mock.calls[0];
    expect(call.slice(1, 6)).toEqual(
      [42, '+393331234567', 'HX_OPENING', 'Fenice apertura', 'whatsapp:+390000000000'],
    );
    expect(call[6]).toEqual({ '3': 'Anna' });
    expect(calls.events.some((e) => e.type === 'opening_config_error')).toBe(false);
  });
});

describe('enrollGdoLeadAsPostino — arruolamento in modalità postino', () => {
  const PAYLOAD = {
    phone: '+393331234567',
    name: 'MARIO ROSSI',
    email: 'mario@esempio.it',
    crmLeadId: 'gdo-1',
    crmFunnel: 'Nome funnel',
    variant: { lavora: true, haFamiglia: false, offertaDelMese: false },
  };

  beforeEach(() => {
    vi.stubEnv('AGENDA_GDO_TEMPLATE_SID', 'HX_AGENDA_GDO');
  });

  it('manda il template agenda dal numero Fenice, col solo nome proprio', async () => {
    const { supabase } = makeSupabase();

    const res = await enrollGdoLeadAsPostino(supabase, PAYLOAD);

    expect(res).toMatchObject({ ok: true, conversationId: 42, sid: 'SM_TEST' });
    const call = vi.mocked(sendTemplateAndLog).mock.calls[0];
    expect(call.slice(1, 6)).toEqual(
      [42, '+393331234567', 'HX_AGENDA_GDO', 'Agenda GDO', 'whatsapp:+390000000000'],
    );
    expect(call[6]).toEqual({ '1': 'Mario' });
    expect(call[7]).toContain('il mio collega');
  });

  it('fuori fascia invia comunque: il GDO è al telefono col lead', async () => {
    vi.mocked(inSendWindow).mockReturnValue(false);
    const { supabase, calls } = makeSupabase();

    const res = await enrollGdoLeadAsPostino(supabase, PAYLOAD);

    expect(res.ok).toBe(true);
    expect(sendTemplateAndLog).toHaveBeenCalledTimes(1);
    expect(calls.events.some((e) => e.type === 'fenice_enroll_deferred')).toBe(false);
  });

  it('marca la conversazione come postino: modalità, video della variante, esito iniziale', async () => {
    const { supabase, calls } = makeSupabase();

    await enrollGdoLeadAsPostino(supabase, PAYLOAD);

    expect(calls.updates).toHaveLength(1);
    expect(calls.updates[0]).toMatchObject({
      ai_owner: 'mario',
      ai_status: 'active',
      crm_lead_id: 'gdo-1',
      crm_funnel: 'Nome funnel',
      gdo_agenda_esito: 'inviato',
      gdo_video_url: 'https://corso.feniceacademy.it/conferenza-bx',
      gdo_video_sent_at: null,
    });
    expect(calls.updates[0].gdo_agenda_at).toBeTruthy();
    expect(calls.updates[0].ai_started_at).toBeTruthy();
  });

  it('offerta del mese → video Black Summer', async () => {
    const { supabase, calls } = makeSupabase();

    await enrollGdoLeadAsPostino(supabase, {
      ...PAYLOAD,
      variant: { lavora: true, haFamiglia: true, offertaDelMese: true },
    });

    expect(calls.updates[0].gdo_video_url).toBe('https://corso.feniceacademy.it/conferenza-black-summer');
  });

  it('invio fallito → ok:false, esito fallito sulla riga (il GDO può ritentare), event send_error', async () => {
    vi.mocked(sendTemplateAndLog).mockResolvedValueOnce({ ok: false, error: 'twilio 63024' });
    const { supabase, calls } = makeSupabase();

    const res = await enrollGdoLeadAsPostino(supabase, PAYLOAD);

    expect(res).toMatchObject({ ok: false, error: 'twilio 63024' });
    expect(calls.updates[0].gdo_agenda_esito).toBe('fallito');
    expect(calls.events.some((e) => e.type === 'send_error' && e.level === 'error')).toBe(true);
  });

  it('template agenda non configurato → errore esplicito, nessun invio', async () => {
    vi.stubEnv('AGENDA_GDO_TEMPLATE_SID', '');
    const { supabase } = makeSupabase();

    await expect(enrollGdoLeadAsPostino(supabase, PAYLOAD)).rejects.toThrow(/AGENDA_GDO_TEMPLATE_SID/);
    expect(sendTemplateAndLog).not.toHaveBeenCalled();
  });
});
