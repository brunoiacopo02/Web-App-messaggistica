import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./messaging', () => ({
  findOrCreateLeadConversation: vi.fn(async () => ({ leadId: 7, conversationId: 42 })),
  sendTemplateAndLog: vi.fn(async () => ({ ok: true, sid: 'SM_TEST' })),
}));

import { enrollGdoLeadAsPostino, enrollLeadIntoMario } from './fenice-enroll';
import { findOrCreateLeadConversation, sendTemplateAndLog } from './messaging';
import { openingBody } from './persona';

/** Fake del client Supabase: traccia update su conversations ed insert su event_log. */
function makeSupabase() {
  const calls = { updates: [] as any[], events: [] as any[] };
  const supabase: any = {
    from(table: string) {
      if (table === 'conversations') {
        return {
          update(payload: any) { calls.updates.push(payload); return { eq() { return Promise.resolve({}); } }; },
          // Chat senza un leadId già registrato: la guardia anti-doppione lascia passare.
          select() { return { eq() { return { maybeSingle: async () => ({ data: null }) }; } }; },
        };
      }
      if (table === 'messages') {
        const chain: any = { eq: () => chain, gte: () => chain, limit: async () => ({ data: [] }) };
        return { select: () => chain };
      }
      return { insert(payload: any) { calls.events.push(payload); return Promise.resolve({}); } };
    },
  };
  return { supabase, calls };
}

// Niente mock sulla finestra d'invio: si muove l'orologio e si usano le funzioni
// vere. Un booleano finto non avrebbe mai potuto accorgersi che il cron di Vercel
// e' in UTC e la fascia scivola di un'ora al cambio d'ora.
const MEZZOGIORNO = Date.parse('2026-07-15T10:00:00Z'); // 12:00 Rome: dentro entrambe le fasce
const SERA = Date.parse('2026-07-15T20:00:00Z');        // 22:00 Rome: apertura si, touch no
const NOTTE_FONDA = Date.parse('2026-07-15T01:00:00Z'); // 03:00 Rome: nessuno scrive

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(MEZZOGIORNO);
  vi.clearAllMocks();
  vi.stubEnv('FENICE_OPENING_TEMPLATE_SID', 'HX_OPENING');
  vi.stubEnv('TWILIO_WHATSAPP_NUMBER_FENICE', 'whatsapp:+390000000000');
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

describe('enrollLeadIntoMario — apertura differita fuori fascia', () => {
  it('in fascia (12:00 Rome) → invio apertura, update conv, event fenice_enroll', async () => {
    vi.setSystemTime(MEZZOGIORNO);
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

  it('nel cuore della notte (03:00 Rome) → NESSUN invio, update conv comunque, event deferred, deferred:true', async () => {
    vi.setSystemTime(NOTTE_FONDA);
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

  // 11/09/2026. Chi lascia il numero alle 22 e' sveglio col telefono in mano e una
  // risposta la aspetta: era la coda peggiore di tutte, 13 ore di attesa mediana.
  it('alle 22:00 di Roma l apertura parte subito, non si differisce al mattino', async () => {
    vi.setSystemTime(SERA);
    const { supabase, calls } = makeSupabase();

    const res = await enrollLeadIntoMario(supabase, {
      phone: '+393331234567', firstName: 'Anna', crmLeadId: 'crm-1', crmFunnel: 'H',
    });

    expect(res).toMatchObject({ ok: true, conversationId: 42 });
    expect(res).not.toHaveProperty('deferred', true);
    expect(sendTemplateAndLog).toHaveBeenCalledTimes(1);
    expect(calls.events.some((e) => e.type === 'fenice_enroll_deferred')).toBe(false);
  });

  it('in fascia con invio fallito → ok:false, event send_error (nessuna regressione)', async () => {
    vi.setSystemTime(MEZZOGIORNO);
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
    vi.stubEnv('OPENING_SID_C3', 'HX_C3');
    vi.stubEnv('OPENING_SID_C4', 'HX_C4');
    vi.stubEnv('OPENING_SID_T1', 'HX_T1');
    vi.stubEnv('OPENING_SID_T2', 'HX_T2');
    vi.stubEnv('OPENING_SID_T3', 'HX_T3');
    vi.stubEnv('OPENING_SID_T4', 'HX_T4');
    vi.stubEnv('OPENING_SID_J1', 'HX_J1');
    vi.stubEnv('OPENING_SID_J2', 'HX_J2');
    vi.stubEnv('OPENING_SID_J3', 'HX_J3');
    vi.stubEnv('OPENING_SID_J4', 'HX_J4');
  }

  beforeEach(() => {
    vi.setSystemTime(MEZZOGIORNO);
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

  it('flag on, conv id 43 (43 mod 4 = 3) → variante 3 → OPENING_SID_C3', async () => {
    vi.stubEnv('NEW_OPENING_ENABLED', '1');
    stubOpeningSids();
    vi.mocked(findOrCreateLeadConversation).mockResolvedValueOnce({ leadId: 7, conversationId: 43 } as never);
    const { supabase } = makeSupabase();

    const res = await enrollLeadIntoMario(supabase, {
      phone: '+393331234567', firstName: 'Anna', crmFunnel: 'CORSO 10 ORE',
    });

    expect(res.conversationId).toBe(43);
    const call = vi.mocked(sendTemplateAndLog).mock.calls[0];
    expect(call[3]).toBe('HX_C3');
    expect(call[4]).toBe('Apertura OPENING_SID_C3');
    expect(call[7]).toBe(openingBody('corso10', 3, 'Anna'));
  });

  it('senza i SID dichiarati l A/B resta a due vie: conv 43 prende C1 (Marta), non il legacy', async () => {
    // Lo stato reale della produzione al 07/08: solo le varianti 1 e 2 hanno un template.
    vi.stubEnv('NEW_OPENING_ENABLED', '1');
    vi.stubEnv('OPENING_SID_C1', 'HX_C1');
    vi.stubEnv('OPENING_SID_C2', 'HX_C2');
    vi.stubEnv('OPENING_SID_C3', '');
    vi.stubEnv('OPENING_SID_C4', '');
    vi.mocked(findOrCreateLeadConversation).mockResolvedValueOnce({ leadId: 7, conversationId: 43 } as never);
    const { supabase, calls } = makeSupabase();

    await enrollLeadIntoMario(supabase, {
      phone: '+393331234567', firstName: 'Anna', crmFunnel: 'CORSO 10 ORE',
    });

    const call = vi.mocked(sendTemplateAndLog).mock.calls[0];
    expect(call[3]).toBe('HX_C1'); // 43 dispari → variante 1, la regola storica
    expect(call[4]).toBe('Apertura OPENING_SID_C1');
    expect(call[7]).toBe(openingBody('corso10', 1, 'Anna'));
    expect(calls.events.some((e) => e.type === 'opening_config_error')).toBe(false);
  });

  it('senza i SID dichiarati nessun lead cade sull apertura legacy di Mario', async () => {
    vi.stubEnv('NEW_OPENING_ENABLED', '1');
    vi.stubEnv('OPENING_SID_C1', 'HX_C1');
    vi.stubEnv('OPENING_SID_C2', 'HX_C2');
    vi.stubEnv('OPENING_SID_C3', '');
    vi.stubEnv('OPENING_SID_C4', '');

    for (const id of [40, 41, 42, 43]) {
      vi.mocked(sendTemplateAndLog).mockClear();
      vi.mocked(findOrCreateLeadConversation).mockResolvedValueOnce({ leadId: 7, conversationId: id } as never);
      const { supabase } = makeSupabase();
      await enrollLeadIntoMario(supabase, {
        phone: '+393331234567', firstName: 'Anna', crmFunnel: 'CORSO 10 ORE',
      });
      const call = vi.mocked(sendTemplateAndLog).mock.calls[0];
      expect(['HX_C1', 'HX_C2']).toContain(call[3]);
    }
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
    vi.setSystemTime(NOTTE_FONDA);
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

  it('ri-arruolamento: video, contatore dei solleciti e conferma ripartono; Noemi no', async () => {
    // Il GDO sposta l'appuntamento e ri-arruola. Senza l'azzeramento, un lead già
    // passato dal flusso resterebbe a followups 2 con la conferma del video vecchia:
    // decideGdoVideoFollowup direbbe 'none' per sempre e non riceverebbe più nulla.
    const { supabase, calls } = makeSupabase();

    await enrollGdoLeadAsPostino(supabase, PAYLOAD);

    expect(calls.updates[0]).toMatchObject({
      gdo_video_sent_at: null,
      gdo_video_followups_sent: 0,
      gdo_video_watched_at: null,
    });
    // Chi è Noemi si spiega una volta per lead, non a ogni appuntamento.
    expect('gdo_noemi_reminded_at' in calls.updates[0]).toBe(false);
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

/**
 * Fake Supabase che sa anche leggere: serve alla guardia anti-doppione, che prima di
 * inviare guarda il crm_lead_id della conv e se un outbound è già partito di recente.
 */
function makeSupabaseLeggibile(opts: { crmLeadId?: string | null; outboundRecenti?: number; lastInboundAt?: string | null }) {
  const calls = { updates: [] as any[], events: [] as any[] };
  const supabase: any = {
    from(table: string) {
      if (table === 'conversations') {
        return {
          update(payload: any) { calls.updates.push(payload); return { eq() { return Promise.resolve({}); } }; },
          select() {
            return { eq() { return { maybeSingle: async () => ({ data: { crm_lead_id: opts.crmLeadId ?? null, last_inbound_at: opts.lastInboundAt ?? null } }) }; } };
          },
        };
      }
      if (table === 'messages') {
        const rows = Array.from({ length: opts.outboundRecenti ?? 0 }, (_, i) => ({ id: i }));
        const chain: any = { eq: () => chain, gte: () => chain, limit: async () => ({ data: rows }) };
        return { select: () => chain };
      }
      return { insert(payload: any) { calls.events.push(payload); return Promise.resolve({}); } };
    },
  };
  return { supabase, calls };
}

describe('enrollLeadIntoMario — guardia anti-doppione sui ritenti del CRM', () => {
  it('stesso crmLeadId con apertura già partita → non reinvia, dice duplicato', async () => {
    vi.setSystemTime(MEZZOGIORNO);
    const { supabase } = makeSupabaseLeggibile({ crmLeadId: 'LEAD-1', outboundRecenti: 1 });
    const res = await enrollLeadIntoMario(supabase, { phone: '+393330000001', crmLeadId: 'LEAD-1' });
    expect(res).toMatchObject({ ok: true, conversationId: 42, duplicato: true });
    expect(sendTemplateAndLog).not.toHaveBeenCalled();
  });

  it('due leadId diversi della stessa persona a poche ore → una sola apertura', async () => {
    // Il CRM tiene più lead per lo stesso numero (1.708 gruppi con presenze diverse) e
    // noi deduplichiamo la chat per numero: in un blast i due leadId cadono nella stessa
    // conversazione. La guardia guarda la CHAT, non il leadId, o quella persona sente
    // due "ciao" di fila.
    vi.setSystemTime(MEZZOGIORNO);
    const { supabase } = makeSupabaseLeggibile({ crmLeadId: 'LEAD-VECCHIO', outboundRecenti: 1 });
    const res = await enrollLeadIntoMario(supabase, { phone: '+393330000002', crmLeadId: 'LEAD-NUOVO' });
    expect(res).toMatchObject({ ok: true, duplicato: true });
    expect(sendTemplateAndLog).not.toHaveBeenCalled();
  });

  it('persona ricorrente con ultimo contatto vecchio → l apertura parte', async () => {
    vi.setSystemTime(MEZZOGIORNO);
    const { supabase } = makeSupabaseLeggibile({ crmLeadId: 'LEAD-VECCHIO', outboundRecenti: 0 });
    const res = await enrollLeadIntoMario(supabase, { phone: '+393330000002', crmLeadId: 'LEAD-NUOVO' });
    expect(res).toMatchObject({ ok: true });
    expect(res).not.toHaveProperty('duplicato');
    expect(sendTemplateAndLog).toHaveBeenCalledTimes(1);
  });

  it('stesso crmLeadId ma nessun outbound recente → l apertura parte', async () => {
    vi.setSystemTime(MEZZOGIORNO);
    const { supabase } = makeSupabaseLeggibile({ crmLeadId: 'LEAD-1', outboundRecenti: 0 });
    const res = await enrollLeadIntoMario(supabase, { phone: '+393330000003', crmLeadId: 'LEAD-1' });
    expect(res).toMatchObject({ ok: true });
    expect(sendTemplateAndLog).toHaveBeenCalledTimes(1);
  });

  it('chat viva: il lead ha risposto 3 giorni fa → nessuna apertura da capo', async () => {
    // 25 delle 46 conversazioni ripushate il 09/09 erano così: gente che stava parlando
    // col bot e si è sentita ridire "ciao". L'ultimo outbound era vecchio, quindi il solo
    // controllo sugli invii non bastava.
    vi.setSystemTime(MEZZOGIORNO);
    const treGiorniFa = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const { supabase } = makeSupabaseLeggibile({ crmLeadId: 'LEAD-1', outboundRecenti: 0, lastInboundAt: treGiorniFa });
    const res = await enrollLeadIntoMario(supabase, { phone: '+393330000005', crmLeadId: 'LEAD-2' });
    expect(res).toMatchObject({ ok: true, duplicato: true });
    expect(sendTemplateAndLog).not.toHaveBeenCalled();
  });

  it('lead muto da mesi → l apertura parte', async () => {
    vi.setSystemTime(MEZZOGIORNO);
    const dueMesiFa = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    const { supabase } = makeSupabaseLeggibile({ crmLeadId: 'LEAD-1', outboundRecenti: 0, lastInboundAt: dueMesiFa });
    const res = await enrollLeadIntoMario(supabase, { phone: '+393330000006', crmLeadId: 'LEAD-2' });
    expect(res).not.toHaveProperty('duplicato');
    expect(sendTemplateAndLog).toHaveBeenCalledTimes(1);
  });

  it('senza crmLeadId (arruolamento non CRM) la guardia non si attiva', async () => {
    vi.setSystemTime(MEZZOGIORNO);
    const { supabase } = makeSupabaseLeggibile({ crmLeadId: null, outboundRecenti: 1 });
    await enrollLeadIntoMario(supabase, { phone: '+393330000004' });
    expect(sendTemplateAndLog).toHaveBeenCalledTimes(1);
  });
});
