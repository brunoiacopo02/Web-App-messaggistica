import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./messaging', () => ({
  findOrCreateLeadConversation: vi.fn(async () => ({ leadId: 7, conversationId: 42 })),
  sendTemplateAndLog: vi.fn(async () => ({ ok: true, sid: 'SM_TEST' })),
}));

vi.mock('./lancio-settings', () => ({
  getLancioSettings: vi.fn(async () => ({ attivo: true, pulsanteAttivo: false, zoomLink: null, videoLiveLink: null, offertaDelMeseLink: null, eventoAt: null, blastPerimetro: 'tutti', sender: 'principale', quotaSecondario: 0 })),
}));

import { apreSopraChatViva, enrollGdoLeadAsPostino, enrollLeadIntoMario } from './fenice-enroll';
import { findOrCreateLeadConversation, sendTemplateAndLog } from './messaging';
import { getLancioSettings } from './lancio-settings';
import { lancioBenvenutoText } from './lancio-fase';
import { decideAperturaLancio, riassumiOutboundLancio } from './lancio-aperture';
import { openingBody } from './persona';

/** Fake del client Supabase: traccia update su conversations ed insert su event_log.
 *  `benvenutiUltimaOra` è il numero che il tetto orario del lancio legge da `messages`.
 *  `guardia` alimenta le due letture di `apreSopraChatViva` dentro `enrollLeadIntoMario`
 *  (la select su conversations e il conteggio degli outbound già partiti). Default: chat
 *  nuova, così la guardia non scatta e i test che non la riguardano restano invariati. */
function makeSupabase(
  benvenutiUltimaOra = 0,
  erroreConteggio = false,
  guardia: {
    convRow?: { ai_owner: string | null; ai_status: string | null; crm_lead_id?: string | null };
    outboundCount?: number;
    /** La select su `conversations` va in errore: "non lo so", non "e' nullo". */
    convErrore?: boolean;
    /** Quante chat sono gia' nate oggi sul numero nuovo (tetto `puoAprireSuBot2`). */
    aperturaOggiSulSecondo?: number;
    /** Lo stato del lancio gia' scritto sulla riga, come lo rilegge `enrollLancio`.
     *  Assente = chat mai entrata in nessun lancio. */
    lancioRow?: { lancio_slug: string | null; lancio_fase: string | null; lancio_benvenuto_at?: string | null };
    /** La rilettura dello stato del lancio va in errore: "non lo so", non "non c'e'". */
    lancioErrore?: boolean;
  } = {},
) {
  const calls = { updates: [] as any[], events: [] as any[], conteggi: 0 };
  const convRow = guardia.convRow ?? { ai_owner: null, ai_status: null, crm_lead_id: null };
  const outboundCount = guardia.outboundCount ?? 0;
  const convErrore = guardia.convErrore === true;
  const aperturaOggiSulSecondo = guardia.aperturaOggiSulSecondo ?? 0;
  const supabase: any = {
    from(table: string) {
      if (table === 'conversations') {
        return {
          update(payload: any) {
            calls.updates.push(payload);
            // Catena thenable: il ramo lancio fa anche `.update(...).eq(...).or(...)`.
            const chain: any = { eq: () => chain, or: () => chain, then: (r: any) => r({}) };
            return chain;
          },
          // Due letture sulla stessa select: `single()` è quella della guardia
          // `apreSopraChatViva`, `maybeSingle()` quella della guardia anti-doppione
          // (chat senza un leadId già registrato: lascia passare).
          // Tre letture sulla stessa select: `single()` e' quella della guardia
          // `apreSopraChatViva`, `maybeSingle()` quella della guardia anti-doppione, e
          // con `head: true` e' il conteggio del tetto giornaliero del numero nuovo
          // (`puoAprireSuBot2`), che chiude su `.eq(...).gte(...)`.
          // Le `maybeSingle()` sulla stessa select sono due e si distinguono dalle
          // colonne chieste: `lancio_slug...` e' la rilettura dello stato del lancio
          // (ri-arruolamento), il resto e' la guardia anti-doppione.
          select(colonne?: string, opzioni?: { head?: boolean }) {
            if (opzioni?.head) {
              return { eq: () => ({ gte: async () => ({ count: aperturaOggiSulSecondo, error: null }) }) };
            }
            const chiedeIlLancio = (colonne ?? '').includes('lancio_slug');
            return {
              eq() {
                return {
                  single: async () => (convErrore
                    ? { data: null, error: { message: 'connessione persa' } }
                    : { data: convRow }),
                  maybeSingle: async () => {
                    if (!chiedeIlLancio) return { data: null };
                    if (guardia.lancioErrore) return { data: null, error: { message: 'connessione persa' } };
                    return { data: guardia.lancioRow ?? null };
                  },
                };
              },
            };
          },
        };
      }
      if (table === 'messages') {
        // Tre letture diverse sulla stessa tabella: la guardia anti-doppione (righe di
        // questa chat), il conteggio del tetto orario (`head: true` CON finestra `gte`,
        // nessuna riga, un numero su tutte le conversazioni) e il conteggio degli
        // outbound già partiti della guardia `apreSopraChatViva` (`head: true`, senza
        // finestra). Le ultime due si distinguono proprio dal `gte`.
        const chain: any = { eq: () => chain, gte: () => chain, not: () => chain, limit: async () => ({ data: [] }) };
        return {
          select: (_colonne: string, opzioni?: { head?: boolean }) => {
            if (!opzioni?.head) return chain;
            let conFinestra = false;
            const conteggio: any = {
              eq: () => conteggio,
              gte: () => { conFinestra = true; return conteggio; },
              not: () => conteggio,
              then: (r: any) => {
                if (!conFinestra) return r({ count: outboundCount, error: null });
                calls.conteggi++;
                return r({
                  count: erroreConteggio ? null : benvenutiUltimaOra,
                  error: erroreConteggio ? { message: 'timeout' } : null,
                });
              },
            };
            return conteggio;
          },
        };
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

  // Il video dell'offerta del mese è un'impostazione (`offerta_del_mese_link`), non più
  // il Black Summer: chi chiama risolve il link e lo passa qui. Senza link non parte
  // nessun video — meglio niente che un video vecchio spacciato per l'offerta del mese.
  it('offerta del mese senza link risolto dal chiamante → nessun video, mai il Black Summer', async () => {
    const { supabase, calls } = makeSupabase();

    await enrollGdoLeadAsPostino(supabase, {
      ...PAYLOAD,
      variant: { lavora: true, haFamiglia: true, offertaDelMese: true },
    });

    expect(calls.updates[0].gdo_video_url).toBeNull();
  });

  it('il video passato dal chiamante vince sul calcolo dalla variante', async () => {
    const { supabase, calls } = makeSupabase();

    await enrollGdoLeadAsPostino(supabase, {
      ...PAYLOAD,
      variant: { lavora: true, haFamiglia: true, offertaDelMese: true },
      gdoVideoUrl: 'https://corso.feniceacademy.it/webdev-offerta',
    });

    expect(calls.updates[0].gdo_video_url).toBe('https://corso.feniceacademy.it/webdev-offerta');
  });

  it('senza `gdoVideoUrl` le quattro varianti classiche restano quelle di sempre', async () => {
    const { supabase, calls } = makeSupabase();

    await enrollGdoLeadAsPostino(supabase, {
      ...PAYLOAD,
      variant: { lavora: true, haFamiglia: true, offertaDelMese: false },
    });

    expect(calls.updates[0].gdo_video_url).toBe('https://corso.feniceacademy.it/conferenza-dx');
  });

  it('invio fallito → ok:false, esito fallito sulla riga (il GDO può ritentare), event send_error', async () => {
    vi.mocked(sendTemplateAndLog).mockResolvedValueOnce({ ok: false, error: 'twilio 63024' });
    const { supabase, calls } = makeSupabase();

    const res = await enrollGdoLeadAsPostino(supabase, PAYLOAD);

    expect(res).toMatchObject({ ok: false, error: 'twilio 63024' });
    expect(calls.updates[0].gdo_agenda_esito).toBe('fallito');
    expect(calls.events.some((e) => e.type === 'send_error' && e.level === 'error')).toBe(true);
  });

  // 24/09/2026: l'agenda partiva dal numero storico ma la chat restava sul numero
  // nuovo. Il lead rispondeva al numero storico, il video usciva dal nuovo e Twilio lo
  // respingeva (63016, finestra chiusa su quella coppia): 16 lead senza video in 3
  // giorni. La chat segue l'agenda: da qui in poi il video, le risposte e i solleciti
  // partono dal numero da cui il lead ha appena ricevuto il link.
  it('una chat nata sul numero nuovo passa al numero storico, e lo scrive nel registro', async () => {
    vi.mocked(findOrCreateLeadConversation).mockResolvedValueOnce({
      leadId: 7, conversationId: 42, waNumber: 'whatsapp:+391111111111',
    });
    const { supabase, calls } = makeSupabase();

    await enrollGdoLeadAsPostino(supabase, PAYLOAD);

    expect(vi.mocked(sendTemplateAndLog).mock.calls[0][5]).toBe('whatsapp:+390000000000');
    expect(calls.updates[0].wa_number).toBe('whatsapp:+390000000000');
    const evento = calls.events.find((e) => e.type === 'gdo_agenda_chat_su_numero_storico');
    expect(evento?.payload).toMatchObject({ conversationId: 42, da: 'whatsapp:+391111111111', a: 'whatsapp:+390000000000' });
  });

  it('una chat gia sul numero storico non genera nessun evento di spostamento', async () => {
    vi.mocked(findOrCreateLeadConversation).mockResolvedValueOnce({
      leadId: 7, conversationId: 42, waNumber: 'whatsapp:+390000000000',
    });
    const { supabase, calls } = makeSupabase();

    await enrollGdoLeadAsPostino(supabase, PAYLOAD);

    expect(calls.updates[0].wa_number).toBe('whatsapp:+390000000000');
    expect(calls.events.some((e) => e.type === 'gdo_agenda_chat_su_numero_storico')).toBe(false);
  });

  it('una chat che nasce adesso nasce gia sul numero storico, senza sorteggio', async () => {
    const { supabase } = makeSupabase();

    await enrollGdoLeadAsPostino(supabase, PAYLOAD);

    expect(vi.mocked(findOrCreateLeadConversation).mock.calls[0][2]).toEqual({ mittente: 'whatsapp:+390000000000' });
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
function makeSupabaseLeggibile(opts: { crmLeadId?: string | null; outboundRecenti?: number; /** Righe in uscita recenti FALLITE (senza `twilio_sid`): il `.not('twilio_sid','is',null)` della guardia le scarta. */ outboundFalliti?: number; lastInboundAt?: string | null; benvenutiUltimaOra?: number; /** Lo stato del lancio gia' scritto sulla riga (ri-arruolamento). */ lancioRow?: { lancio_slug: string | null; lancio_fase: string | null; lancio_benvenuto_at?: string | null } }) {
  const calls = { updates: [] as any[], events: [] as any[] };
  const supabase: any = {
    from(table: string) {
      if (table === 'conversations') {
        return {
          update(payload: any) {
            calls.updates.push(payload);
            const chain: any = { eq: () => chain, or: () => chain, then: (r: any) => r({}) };
            return chain;
          },
          select(colonne?: string) {
            const riga = { ai_owner: null, ai_status: null, crm_lead_id: opts.crmLeadId ?? null, last_inbound_at: opts.lastInboundAt ?? null };
            // `single()` è la lettura della guardia `apreSopraChatViva`: qui la chat non
            // è di Mario, quindi quella guardia non scatta e resta in scena l'anti-doppione.
            // La `maybeSingle()` che chiede `lancio_slug` è invece la rilettura dello
            // stato del lancio dentro `enrollLancio`.
            const lancio = (colonne ?? '').includes('lancio_slug');
            return { eq() { return { single: async () => ({ data: riga }), maybeSingle: async () => ({ data: lancio ? (opts.lancioRow ?? null) : riga }) }; } };
          },
        };
      }
      if (table === 'messages') {
        const partiti = Array.from({ length: opts.outboundRecenti ?? 0 }, (_, i) => ({ id: i, twilio_sid: `SM${i}` }));
        const falliti = Array.from({ length: opts.outboundFalliti ?? 0 }, (_, i) => ({ id: 100 + i, twilio_sid: null }));
        let soloPartiti = false;
        const chain: any = {
          eq: () => chain, gte: () => chain,
          not: (col: string, op: string, val: unknown) => { if (col === 'twilio_sid' && op === 'is' && val === null) soloPartiti = true; return chain; },
          limit: async () => ({ data: soloPartiti ? partiti : [...partiti, ...falliti] }),
        };
        const conteggio: any = {
          eq: () => conteggio, gte: () => conteggio, not: () => conteggio,
          then: (r: any) => r({ count: opts.benvenutiUltimaOra ?? 0, error: null }),
        };
        return { select: (_c: string, opzioni?: { head?: boolean }) => (opzioni?.head ? conteggio : chain) };
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

  it('riga in uscita recente ma FALLITA (senza SID) → l apertura parte: il lead non ha ricevuto niente', async () => {
    // 17/09/2026: 53 chat sul numero nuovo con la sola riga `failed` del presidio
    // UTILITY_ONLY. La guardia le contava come "apertura recente" e riapri-mute
    // dichiarava 53 aperture partite a ogni giro senza mandarne una.
    vi.setSystemTime(MEZZOGIORNO);
    const { supabase } = makeSupabaseLeggibile({ crmLeadId: 'LEAD-1', outboundRecenti: 0, outboundFalliti: 1 });
    const res = await enrollLeadIntoMario(supabase, { phone: '+393330000007', crmLeadId: 'LEAD-1' });
    expect(res).not.toHaveProperty('duplicato');
    expect(res).toMatchObject({ ok: true, sid: 'SM_TEST' });
    expect(sendTemplateAndLog).toHaveBeenCalledTimes(1);
  });

  it('riga fallita E riga partita nelle ultime 12 ore → resta duplicato', async () => {
    vi.setSystemTime(MEZZOGIORNO);
    const { supabase } = makeSupabaseLeggibile({ crmLeadId: 'LEAD-1', outboundRecenti: 1, outboundFalliti: 1 });
    const res = await enrollLeadIntoMario(supabase, { phone: '+393330000008', crmLeadId: 'LEAD-1' });
    expect(res).toMatchObject({ ok: true, duplicato: true });
    expect(sendTemplateAndLog).not.toHaveBeenCalled();
  });

  it('senza crmLeadId (arruolamento non CRM) la guardia non si attiva', async () => {
    vi.setSystemTime(MEZZOGIORNO);
    const { supabase } = makeSupabaseLeggibile({ crmLeadId: null, outboundRecenti: 1 });
    await enrollLeadIntoMario(supabase, { phone: '+393330000004' });
    expect(sendTemplateAndLog).toHaveBeenCalledTimes(1);
  });
});

describe('enrollLeadIntoMario — ramo lancio (B1)', () => {
  const LANCIO = { slug: 'webdev-2026-10', ingresso: 'lista' as const };
  const ARGS = { phone: '+393331234567', firstName: 'ANNA BIANCHI', crmLeadId: 'crm-L1', crmFunnel: 'Lancio Web Dev AI', lancio: LANCIO };

  beforeEach(() => {
    vi.setSystemTime(MEZZOGIORNO);
    vi.stubEnv('LANCIO_WELCOME_TEMPLATE_SID', 'HX_LANCIO_WELCOME');
    vi.stubEnv('NEW_OPENING_ENABLED', '1'); // anche col flag A/B acceso il lancio non passa dalle aperture C/T/J
    vi.mocked(getLancioSettings).mockResolvedValue({ attivo: true, pulsanteAttivo: false, zoomLink: null, videoLiveLink: null, offertaDelMeseLink: null, eventoAt: null, blastPerimetro: 'tutti', sender: 'principale', quotaSecondario: 0 });
  });

  it("manda il template di benvenuto del lancio, non un'apertura di Mario/Marta", async () => {
    const { supabase, calls } = makeSupabase();
    const res = await enrollLeadIntoMario(supabase, ARGS);
    expect(res).toMatchObject({ ok: true, conversationId: 42, sid: 'SM_TEST' });
    const call = vi.mocked(sendTemplateAndLog).mock.calls[0];
    expect(call.slice(1, 6)).toEqual([42, '+393331234567', 'HX_LANCIO_WELCOME', 'Lancio benvenuto', 'whatsapp:+390000000000']);
    expect(call[6]).toEqual({ '1': 'Anna' });
    expect(call[7]).toBe(lancioBenvenutoText('ANNA BIANCHI'));
    expect(calls.events.some((e) => e.type === 'opening_config_error')).toBe(false);
  });

  it("scrive lancio_slug, lancio_fase=attesa, lancio_ingresso e l'evento lancio_intake", async () => {
    const { supabase, calls } = makeSupabase();
    await enrollLeadIntoMario(supabase, ARGS);
    expect(calls.updates[0]).toMatchObject({
      ai_owner: 'mario', ai_status: 'active', crm_lead_id: 'crm-L1', crm_funnel: 'Lancio Web Dev AI',
      lancio_slug: 'webdev-2026-10', lancio_fase: 'attesa', lancio_ingresso: 'lista',
    });
    const evt = calls.events.find((e) => e.type === 'lancio_intake');
    expect(evt).toBeTruthy();
    expect(evt.payload).toMatchObject({ crmLeadId: 'crm-L1', conversationId: 42, slug: 'webdev-2026-10', ingresso: 'lista', ok: true });
  });

  // Una chat gia' adottata dal webhook porta il suo `crm_funnel` (il TELEGRAM dedotto
  // dal primo messaggio del lead). L'intake del lancio che non manda il funnel non deve
  // cancellarlo: stessa regola del ramo normale di `enrollLeadIntoMario`.
  it('un intake del lancio senza funnel non cancella il TELEGRAM dedotto dal webhook', async () => {
    const { supabase, calls } = makeSupabase();
    const { crmFunnel: _ignorato, ...senzaFunnel } = ARGS;

    await enrollLeadIntoMario(supabase, senzaFunnel);

    // `crm_funnel` non compare in NESSUNA delle patch: il valore sulla riga resta quello.
    expect(calls.updates.length).toBeGreaterThan(0);
    for (const u of calls.updates) expect('crm_funnel' in u).toBe(false);
    expect(calls.updates[0]).toMatchObject({ lancio_slug: 'webdev-2026-10' });
  });

  it('benvenuto partito: timbra lancio_benvenuto_at, il lucchetto letto dal cron', async () => {
    const { supabase, calls } = makeSupabase();
    await enrollLeadIntoMario(supabase, ARGS);
    expect(calls.updates[0].lancio_benvenuto_at).toEqual(expect.any(String));
  });

  it('benvenuto NON partito: nessun timbro, o il cron non ci riproverebbe mai', async () => {
    vi.mocked(sendTemplateAndLog).mockResolvedValueOnce({ ok: false, error: 'twilio boom' });
    const { supabase, calls } = makeSupabase();
    await enrollLeadIntoMario(supabase, ARGS);
    expect(calls.updates[0].lancio_benvenuto_at).toBeNull(); // null, non assente: all'ingresso il timbro del giro precedente si azzera
  });

  it('differito (lancio spento): nessun timbro, il cron lo prende in carico', async () => {
    vi.mocked(getLancioSettings).mockResolvedValueOnce({ attivo: false } as never);
    const { supabase, calls } = makeSupabase();
    await enrollLeadIntoMario(supabase, ARGS);
    expect(calls.updates[0].lancio_benvenuto_at).toBeNull(); // null, non assente: all'ingresso il timbro del giro precedente si azzera
  });

  it('con lancio_attivo spento prende in carico ma NON manda: differita, la riprende il cron lancio', async () => {
    vi.mocked(getLancioSettings).mockResolvedValueOnce({ attivo: false, pulsanteAttivo: false, zoomLink: null, videoLiveLink: null, offertaDelMeseLink: null, eventoAt: null, blastPerimetro: 'tutti', sender: 'principale', quotaSecondario: 0 });
    const { supabase, calls } = makeSupabase();
    const res = await enrollLeadIntoMario(supabase, ARGS);
    expect(res).toMatchObject({ ok: true, conversationId: 42, deferred: true });
    expect(sendTemplateAndLog).not.toHaveBeenCalled();
    expect(calls.updates[0]).toMatchObject({ lancio_slug: 'webdev-2026-10', lancio_fase: 'attesa' });
    expect(calls.events.find((e) => e.type === 'lancio_intake').payload.differita).toBe('lancio_spento');
    expect(calls.events.some((e) => e.type === 'fenice_enroll_deferred')).toBe(false);
  });

  it("nel cuore della notte e' differita per fascia, come le aperture", async () => {
    vi.setSystemTime(NOTTE_FONDA);
    const { supabase, calls } = makeSupabase();
    const res = await enrollLeadIntoMario(supabase, ARGS);
    expect(res.deferred).toBe(true);
    expect(sendTemplateAndLog).not.toHaveBeenCalled();
    expect(calls.events.find((e) => e.type === 'lancio_intake').payload.differita).toBe('fuori_fascia');
  });

  it('conversazione viva (ha scritto 3 giorni fa): niente secondo benvenuto, ma lancio_* valorizzati e duplicato:true', async () => {
    const treGiorniFa = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const { supabase, calls } = makeSupabaseLeggibile({ crmLeadId: 'crm-VECCHIO', outboundRecenti: 0, lastInboundAt: treGiorniFa });
    const res = await enrollLeadIntoMario(supabase, ARGS);
    expect(res).toMatchObject({ ok: true, conversationId: 42, duplicato: true });
    expect(sendTemplateAndLog).not.toHaveBeenCalled();
    expect(calls.updates[0]).toMatchObject({
      lancio_slug: 'webdev-2026-10', lancio_fase: 'attesa', lancio_ingresso: 'lista', crm_lead_id: 'crm-L1', ai_owner: 'mario',
    });
    expect('ai_started_at' in calls.updates[0]).toBe(false); // la cronologia della chat viva non si azzera
    expect(calls.events.find((e) => e.type === 'lancio_intake').payload).toMatchObject({ duplicato: true, motivo: 'conversazione_viva' });
  });

  // Ruling del controller (ritrovamento B5 #2): su una chat riusata l'esito del giro
  // precedente resta scritto sulla riga. Senza azzerarlo, la restituzione di fine lancio
  // (NON_RISPOSTO) verrebbe declassata a NOTA sul lead sbagliato da resolveOutcomeAction.
  it("azzera l'esito del giro precedente sulla chat riusata (ramo normale e ramo duplicato)", async () => {
    const { supabase, calls } = makeSupabase();
    await enrollLeadIntoMario(supabase, ARGS);
    expect(calls.updates[0]).toMatchObject({ bot_outcome: null, bot_outcome_at: null, bot_scheduled_at: null });

    const treGiorniFa = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const viva = makeSupabaseLeggibile({ crmLeadId: 'crm-VECCHIO', outboundRecenti: 0, lastInboundAt: treGiorniFa });
    await enrollLeadIntoMario(viva.supabase, ARGS);
    expect(viva.calls.updates[0]).toMatchObject({ bot_outcome: null, bot_outcome_at: null, bot_scheduled_at: null });
  });

  // Bug visto dal vivo il 19/09/2026. `lancioFields` portava `lancio_fase: 'attesa'` e
  // `bot_outcome: null` e veniva scritto anche su una chat che nel lancio c'era gia': la
  // conv 3292 era in `link_inviato` (link Zoom della prova generale del 17/09) e un
  // intake delle 12:49 l'ha riportata ad 'attesa', senza lasciare un evento. Lo stesso
  // colpo su un `posto_bloccato` la sera della live la farebbe restituire al pool il 7
  // ottobre come "non ha mai risposto", su uno che aveva gia' detto di si'.
  describe("ri-arruolamento di una chat gia' nel lancio", () => {
    const GIA_DENTRO = {
      lancio_slug: 'webdev-2026-10',
      lancio_fase: 'posto_bloccato',
      lancio_benvenuto_at: '2026-09-17T14:52:45.356Z',
    };

    it("chat mai entrata in un lancio: si inizializza come sempre (fase attesa, esito azzerato)", async () => {
      const { supabase, calls } = makeSupabase();
      await enrollLeadIntoMario(supabase, ARGS);
      expect(calls.updates[0]).toMatchObject({
        lancio_slug: 'webdev-2026-10', lancio_fase: 'attesa', lancio_ingresso: 'lista',
        bot_outcome: null, bot_outcome_at: null, bot_scheduled_at: null,
      });
      expect(calls.events.some((e) => e.type === 'lancio_riarruolamento_ignorato')).toBe(false);
    });

    it("gia' in questo lancio: nessuna update tocca fase, ingresso o esito", async () => {
      const { supabase, calls } = makeSupabase(0, false, { lancioRow: GIA_DENTRO });
      await enrollLeadIntoMario(supabase, ARGS);
      expect(calls.updates.length).toBeGreaterThan(0);
      // Il campo non deve comparire affatto: scriverci sopra il valore di partenza
      // sarebbe comunque una riscrittura alla cieca di quello che la chat ha gia' fatto.
      const scritti = calls.updates.flatMap((u) => Object.keys(u));
      expect(scritti.filter((k) => ['lancio_fase', 'lancio_ingresso', 'bot_outcome', 'bot_outcome_at', 'bot_scheduled_at'].includes(k))).toEqual([]);
    });

    it("gia' in questo lancio: resta l'evento lancio_riarruolamento_ignorato con la fase preservata", async () => {
      const { supabase, calls } = makeSupabase(0, false, { lancioRow: GIA_DENTRO });
      await enrollLeadIntoMario(supabase, ARGS);
      const evt = calls.events.find((e) => e.type === 'lancio_riarruolamento_ignorato');
      expect(evt).toBeTruthy();
      expect(evt.level).toBe('info');
      expect(evt.payload).toMatchObject({
        conversationId: 42, crmLeadId: 'crm-L1', slug: 'webdev-2026-10', ingresso: 'lista',
        fasePreservata: 'posto_bloccato',
      });
    });

    // Cautela: la condizione e' sull'UGUAGLIANZA dello slug. Una chat del lancio vecchio
    // che entra in un lancio nuovo deve ripartire da capo, o si porterebbe dietro la
    // fase e l'esito di un lancio che non c'entra piu' niente.
    it('chat di un lancio DIVERSO: si reinizializza da capo', async () => {
      const { supabase, calls } = makeSupabase(0, false, {
        lancioRow: { lancio_slug: 'webdev-2026-04', lancio_fase: 'scelta_fatta', lancio_benvenuto_at: '2026-04-02T09:00:00.000Z' },
      });
      await enrollLeadIntoMario(supabase, ARGS);
      expect(calls.updates[0]).toMatchObject({
        lancio_slug: 'webdev-2026-10', lancio_fase: 'attesa', lancio_ingresso: 'lista', bot_outcome: null,
      });
      expect(calls.events.some((e) => e.type === 'lancio_riarruolamento_ignorato')).toBe(false);
    });

    it("gia' in questo lancio: l'anagrafica e il lead del CRM si aggiornano comunque", async () => {
      const { supabase, calls } = makeSupabase(0, false, { lancioRow: GIA_DENTRO });
      await enrollLeadIntoMario(supabase, ARGS);
      expect(calls.updates[0]).toMatchObject({
        ai_owner: 'mario', ai_status: 'active', crm_lead_id: 'crm-L1', crm_funnel: 'Lancio Web Dev AI',
        lancio_slug: 'webdev-2026-10',
      });
      expect(vi.mocked(findOrCreateLeadConversation).mock.calls[0][1]).toMatchObject({ phone: '+393331234567', firstName: 'ANNA BIANCHI' });
    });

    it("gia' in questo lancio e gia' timbrata: il benvenuto del 17/09 resta l'ancora", async () => {
      const { supabase, calls } = makeSupabase(0, false, { lancioRow: GIA_DENTRO });
      await enrollLeadIntoMario(supabase, ARGS);
      for (const u of calls.updates) expect('lancio_benvenuto_at' in u).toBe(false);
    });

    it("gia' in questo lancio ma senza timbro: il benvenuto partito si timbra", async () => {
      const { supabase, calls } = makeSupabase(0, false, {
        lancioRow: { lancio_slug: 'webdev-2026-10', lancio_fase: 'attesa', lancio_benvenuto_at: null },
      });
      await enrollLeadIntoMario(supabase, ARGS);
      expect(calls.updates[0].lancio_benvenuto_at).toEqual(expect.any(String));
    });

    // Il caso della conv 3292: chat viva, quindi ramo duplicato. Prima di questa
    // correzione era proprio qui che la fase tornava ad 'attesa'.
    it('chat viva e gia nel lancio: duplicato, nessun benvenuto e fase intatta', async () => {
      const treGiorniFa = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
      const { supabase, calls } = makeSupabaseLeggibile({
        crmLeadId: 'crm-VECCHIO', outboundRecenti: 0, lastInboundAt: treGiorniFa,
        lancioRow: { lancio_slug: 'webdev-2026-10', lancio_fase: 'link_inviato', lancio_benvenuto_at: '2026-09-17T14:52:45.356Z' },
      });
      const res = await enrollLeadIntoMario(supabase, ARGS);
      expect(res).toMatchObject({ ok: true, duplicato: true });
      expect(sendTemplateAndLog).not.toHaveBeenCalled();
      expect(calls.updates[0]).toMatchObject({ lancio_slug: 'webdev-2026-10', crm_lead_id: 'crm-L1' });
      expect('lancio_fase' in calls.updates[0]).toBe(false);
      expect('bot_outcome' in calls.updates[0]).toBe(false);
      expect(calls.events.find((e) => e.type === 'lancio_riarruolamento_ignorato').payload.fasePreservata).toBe('link_inviato');
    });

    // Decisione del PO (19/09): "se uno dice no e poi si registra per il lancio deve
    // ripartire". Iscriversi di nuovo e' un atto nuovo di interesse — e' tornato sulla
    // pagina e ha rilasciato il numero — e vale piu' del no di prima.
    describe('fase terminale: riparte da capo', () => {
      const CHIUSO = { lancio_slug: 'webdev-2026-10', lancio_fase: 'chiuso', lancio_benvenuto_at: '2026-09-15T08:00:00.000Z' };
      const RESTITUITO = { lancio_slug: 'webdev-2026-10', lancio_fase: 'restituito', lancio_benvenuto_at: '2026-09-15T08:00:00.000Z' };

      it("chat 'chiuso': torna ad attesa, con ingresso ed esito riscritti", async () => {
        const { supabase, calls } = makeSupabase(0, false, { lancioRow: CHIUSO });
        await enrollLeadIntoMario(supabase, ARGS);
        expect(calls.updates[0]).toMatchObject({
          lancio_slug: 'webdev-2026-10', lancio_fase: 'attesa', lancio_ingresso: 'lista',
          bot_outcome: null, bot_outcome_at: null, bot_scheduled_at: null,
        });
        expect(calls.events.some((e) => e.type === 'lancio_riarruolamento_ignorato')).toBe(false);
      });

      it("chat 'restituito': riparte anche lei, il lead e' tornato da noi", async () => {
        const { supabase, calls } = makeSupabase(0, false, { lancioRow: RESTITUITO });
        await enrollLeadIntoMario(supabase, ARGS);
        expect(calls.updates[0]).toMatchObject({ lancio_fase: 'attesa', lancio_ingresso: 'lista' });
      });

      it("evento lancio_riarruolamento_ripartito con la fase da cui e' ripartito", async () => {
        const { supabase, calls } = makeSupabase(0, false, { lancioRow: CHIUSO });
        await enrollLeadIntoMario(supabase, ARGS);
        const evt = calls.events.find((e) => e.type === 'lancio_riarruolamento_ripartito');
        expect(evt).toBeTruthy();
        expect(evt.level).toBe('info');
        expect(evt.payload).toMatchObject({
          conversationId: 42, crmLeadId: 'crm-L1', slug: 'webdev-2026-10', ingresso: 'lista',
          fasePrecedente: 'chiuso', benvenutoAtPrecedente: '2026-09-15T08:00:00.000Z',
        });
        // Le due storie restano distinte nel log: protetto a meta' strada ≠ ripartito.
        expect(calls.events.some((e) => e.type === 'lancio_riarruolamento_ignorato')).toBe(false);
      });

      // Senza questo azzeramento la ripartenza e' finta: `lancio-aperture` pesca
      // `lancio_fase='attesa' AND lancio_benvenuto_at IS NULL`, e col timbro vecchio la
      // chat tornerebbe in 'attesa' ma muta.
      it('il benvenuto differito riparte: il timbro del giro precedente si azzera', async () => {
        vi.mocked(getLancioSettings).mockResolvedValueOnce({ attivo: false } as never);
        const { supabase, calls } = makeSupabase(0, false, { lancioRow: CHIUSO });
        const res = await enrollLeadIntoMario(supabase, ARGS);
        expect(res.deferred).toBe(true);
        expect(calls.updates[0]).toMatchObject({ lancio_fase: 'attesa', lancio_benvenuto_at: null });
      });

      it('se invece il benvenuto parte subito, il timbro e di adesso', async () => {
        const { supabase, calls } = makeSupabase(0, false, { lancioRow: CHIUSO });
        await enrollLeadIntoMario(supabase, ARGS);
        expect(sendTemplateAndLog).toHaveBeenCalledTimes(1);
        expect(calls.updates[0].lancio_benvenuto_at).toEqual(expect.any(String));
      });

      // Il giro completo, con la decisione VERA del cron: chat chiusa → ri-arruolata e
      // differita → la riga che ne esce e' candidata per `lancio-aperture` (fase attesa,
      // timbro nullo, ai_status active) e il cron la manda.
      it("giro completo: dopo la ripartenza il cron delle aperture la manda", async () => {
        vi.mocked(getLancioSettings).mockResolvedValueOnce({ attivo: false } as never);
        const { supabase, calls } = makeSupabase(0, false, { lancioRow: CHIUSO });
        await enrollLeadIntoMario(supabase, ARGS);
        const riga = calls.updates[0];
        // I filtri della query dei candidati, uno per uno.
        expect(riga.lancio_slug).toBe('webdev-2026-10');
        expect(riga.lancio_fase).toBe('attesa');
        expect(riga.lancio_benvenuto_at).toBeNull();
        expect(riga.ai_status).toBe('active');
        // E la decisione del cron sulla riga cosi' com'e'.
        expect(decideAperturaLancio({
          nowMs: Date.now(),
          attivo: true,
          fase: riga.lancio_fase,
          benvenutoAt: riga.lancio_benvenuto_at,
          benvenutiRiusciti: 0, benvenutiFalliti: 0,
          ultimoOutboundMs: null, ultimoInboundMs: null,
        })).toBe('invia');
      });

      // Il pezzo che rendeva finta la ripartenza differita: `decideAperturaLancio` conta
      // i benvenuti riusciti, e chi riparte da `chiuso` quel benvenuto l'aveva avuto.
      // Adesso il conteggio parte dall'ingresso nel giro corrente (`lancio_intake` piu'
      // recente, che questo stesso arruolamento ha appena riscritto), quindi il benvenuto
      // della vita precedente non blocca piu' niente. Qui si monta il giro vero: le
      // righe in uscita della chat + l'ancora, e la decisione del cron.
      it('il benvenuto della vita precedente non blocca la ripartenza differita', async () => {
        vi.mocked(getLancioSettings).mockResolvedValueOnce({ attivo: false } as never);
        const { supabase, calls } = makeSupabase(0, false, { lancioRow: CHIUSO });
        await enrollLeadIntoMario(supabase, ARGS);
        const riga = calls.updates[0];
        const ingressoMs = Date.now(); // l'evento lancio_intake di questo arruolamento
        const riassunto = riassumiOutboundLancio(
          // Il benvenuto della vita precedente, due settimane prima di questo intake.
          [{ template_sid: 'HX_LANCIO_WELCOME', twilio_status: 'delivered', twilio_error_code: null, created_at: new Date(ingressoMs - 14 * 24 * 3600_000).toISOString() }],
          'HX_LANCIO_WELCOME',
          ingressoMs,
        );
        expect(riassunto.benvenutiRiusciti).toBe(0);
        expect(decideAperturaLancio({
          nowMs: ingressoMs + 24 * 3600_000, // il giorno dopo, stessa ora: in fascia e fuori dalle 12h
          attivo: true,
          fase: riga.lancio_fase,
          benvenutoAt: riga.lancio_benvenuto_at,
          ...riassunto,
          ultimoInboundMs: null,
        })).toBe('invia');
      });

      // E la rete non si e' allentata: su una chat normale il benvenuto viene DOPO
      // l'ingresso, quindi conta e il cron continua a saltarla.
      it('su una chat normale il benvenuto gia\\u2019 partito continua a fermare il cron', () => {
        const ingressoMs = Date.parse('2026-09-19T12:00:00Z');
        const riassunto = riassumiOutboundLancio(
          [{ template_sid: 'HX_LANCIO_WELCOME', twilio_status: 'delivered', twilio_error_code: null, created_at: '2026-09-19T12:01:00Z' }],
          'HX_LANCIO_WELCOME',
          ingressoMs,
        );
        expect(riassunto.benvenutiRiusciti).toBe(1);
        expect(decideAperturaLancio({
          nowMs: ingressoMs + 13 * 3600_000,
          attivo: true, fase: 'attesa', benvenutoAt: null,
          ...riassunto, ultimoInboundMs: null,
        })).toBe('salta');
      });
    });

    // "Non lo so" non e' "non c'e'": con la rilettura fallita si ricade sul
    // comportamento di sempre, ma la riga warn dice che il reset e' ancora possibile.
    it('stato del lancio illeggibile: si inizializza come sempre, con un warn', async () => {
      const { supabase, calls } = makeSupabase(0, false, { lancioErrore: true });
      await enrollLeadIntoMario(supabase, ARGS);
      expect(calls.updates[0]).toMatchObject({ lancio_fase: 'attesa' });
      const evt = calls.events.find((e) => e.type === 'lancio_stato_non_letto');
      expect(evt).toBeTruthy();
      expect(evt.level).toBe('warn');
    });
  });

  it('template non configurato → errore esplicito, nessun invio', async () => {
    vi.stubEnv('LANCIO_WELCOME_TEMPLATE_SID', '');
    const { supabase } = makeSupabase();
    await expect(enrollLeadIntoMario(supabase, ARGS)).rejects.toThrow(/LANCIO_WELCOME_TEMPLATE_SID/);
    expect(sendTemplateAndLog).not.toHaveBeenCalled();
  });

  it("invio fallito → ok:false, event send_error e lancio_intake con l'errore", async () => {
    vi.mocked(sendTemplateAndLog).mockResolvedValueOnce({ ok: false, error: 'template bloccato: categoria MARKETING con UTILITY_ONLY attivo' });
    const { supabase, calls } = makeSupabase();
    const res = await enrollLeadIntoMario(supabase, ARGS);
    expect(res.ok).toBe(false);
    expect(calls.events.some((e) => e.type === 'send_error' && e.level === 'error')).toBe(true);
    expect(calls.events.find((e) => e.type === 'lancio_intake').payload.ok).toBe(false);
  });

  // Il benvenuto approvato UTILITY il 20/09 (`fenice_lancio_benvenuto_v2`) ha DUE
  // variabili: nome e link della live. Quante ne vuole lo dice il template, non questo
  // codice — così la env si scambia (e si torna indietro) senza toccare niente.
  describe('benvenuto a due variabili (il link della live)', () => {
    /** Il SID vero del v2: senza credenziali Twilio il conteggio arriva dalla rete di
     *  sicurezza di `lancio-benvenuto.ts`, che è esattamente il caso da coprire. */
    const V2 = 'HXcf2f16a2afbdafda977f188507599566';
    const ZOOM = 'https://us06web.zoom.us/j/89845223337';
    const impostazioni = (zoomLink: string | null) => {
      vi.mocked(getLancioSettings).mockResolvedValue({
        attivo: true, pulsanteAttivo: false, zoomLink, videoLiveLink: null, offertaDelMeseLink: null,
        eventoAt: null, blastPerimetro: 'tutti', sender: 'principale', quotaSecondario: 0,
      });
    };

    it('col link configurato manda nome E link, e la riga messages porta il testo del v2', async () => {
      vi.stubEnv('LANCIO_WELCOME_TEMPLATE_SID', V2);
      impostazioni(ZOOM);
      const { supabase } = makeSupabase();
      const res = await enrollLeadIntoMario(supabase, ARGS);

      expect(res).toMatchObject({ ok: true, sid: 'SM_TEST' });
      const call = vi.mocked(sendTemplateAndLog).mock.calls[0];
      expect(call[3]).toBe(V2);
      expect(call[6]).toEqual({ '1': 'Anna', '2': ZOOM });
      // Il corpo è quello del template approvato, coi segnaposto risolti: i pannelli
      // devono mostrare quello che il lead ha ricevuto davvero, non il testo del v1.
      expect(call[7]).toMatch(/^Ciao Anna, confermo la tua iscrizione alla live Web Developer AI/);
      expect(call[7]).toContain(ZOOM);
      expect(call[7]).not.toContain('{{');
    });

    // Il caso che non deve succedere: 342 persone con un buco al posto del link.
    it('senza link NON manda: evento error, lead preso in carico, nessun timbro', async () => {
      vi.stubEnv('LANCIO_WELCOME_TEMPLATE_SID', V2);
      impostazioni(null);
      const { supabase, calls } = makeSupabase();
      const res = await enrollLeadIntoMario(supabase, ARGS);

      expect(res).toMatchObject({ ok: true, conversationId: 42, deferred: true });
      expect(sendTemplateAndLog).not.toHaveBeenCalled();
      const evt = calls.events.find((e) => e.type === 'lancio_benvenuto_senza_link');
      expect(evt.level).toBe('error');
      expect(evt.payload).toMatchObject({ conversationId: 42, motivo: 'link_mancante', templateSid: V2, variabili: 2 });
      // Senza timbro il cron `lancio-aperture` lo riprende appena il link c'è.
      expect(calls.updates[0].lancio_benvenuto_at).toBeNull();
      expect(calls.events.find((e) => e.type === 'lancio_intake').payload)
        .toMatchObject({ differita: 'benvenuto_non_componibile', motivo: 'link_mancante' });
    });

    // Il ritorno indietro: rimessa la env vecchia, il comportamento è quello di sempre.
    it('template a una variabile: il link non entra, nemmeno se configurato', async () => {
      impostazioni(ZOOM); // il SID resta 'HX_LANCIO_WELCOME' del beforeEach
      const { supabase } = makeSupabase();
      const res = await enrollLeadIntoMario(supabase, ARGS);

      expect(res).toMatchObject({ ok: true, sid: 'SM_TEST' });
      const call = vi.mocked(sendTemplateAndLog).mock.calls[0];
      expect(call[6]).toEqual({ '1': 'Anna' });
      expect(call[7]).toBe(lancioBenvenutoText('ANNA BIANCHI'));
    });
  });

  // Spec §11.3. Il 15/09 il numero ha incassato 7.882 intake in un giorno ed è uscito a
  // qualità LOW: il benvenuto realtime, senza tetto, rifarebbe lo stesso picco.
  describe('tetto orario dei benvenuti (LANCIO_WELCOME_MAX_PER_HOUR)', () => {
    it('sotto il tetto il benvenuto parte come sempre', async () => {
      vi.stubEnv('LANCIO_WELCOME_MAX_PER_HOUR', '200');
      const { supabase, calls } = makeSupabase(199);
      const res = await enrollLeadIntoMario(supabase, ARGS);
      expect(res).toMatchObject({ ok: true, sid: 'SM_TEST' });
      expect(res.deferred ?? false).toBe(false);
      expect(sendTemplateAndLog).toHaveBeenCalledTimes(1);
      expect(calls.conteggi).toBe(1); // una sola query di conteggio per intake
    });

    it('al tetto NON manda: presa in carico, differita tetto_orario, nessun timbro', async () => {
      vi.stubEnv('LANCIO_WELCOME_MAX_PER_HOUR', '200');
      const { supabase, calls } = makeSupabase(200);
      const res = await enrollLeadIntoMario(supabase, ARGS);

      expect(res).toMatchObject({ ok: true, conversationId: 42, deferred: true });
      expect(sendTemplateAndLog).not.toHaveBeenCalled();
      // Stessi campi del caso `lancio_attivo=0`: il lead entra nel flusso lancio e il
      // cron `lancio-aperture` lo trova come candidato.
      expect(calls.updates).toHaveLength(1);
      expect(calls.updates[0]).toMatchObject({
        ai_owner: 'mario', ai_status: 'active', crm_lead_id: 'crm-L1',
        lancio_slug: 'webdev-2026-10', lancio_fase: 'attesa', lancio_ingresso: 'lista',
      });
      expect(calls.updates[0].lancio_benvenuto_at).toBeNull(); // null, non assente: all'ingresso il timbro del giro precedente si azzera
      const evt = calls.events.find((e) => e.type === 'lancio_intake');
      expect(evt.payload).toMatchObject({ differita: 'tetto_orario', inviatiUltimaOra: 200, cap: 200 });
      expect(calls.events.some((e) => e.type === 'send_error')).toBe(false);
    });

    it('env spazzatura → tetto di default 200: a 199 parte, a 200 si differisce', async () => {
      vi.stubEnv('LANCIO_WELCOME_MAX_PER_HOUR', 'duecento');
      const sotto = makeSupabase(199);
      await enrollLeadIntoMario(sotto.supabase, ARGS);
      expect(sendTemplateAndLog).toHaveBeenCalledTimes(1);

      const sopra = makeSupabase(200);
      const res = await enrollLeadIntoMario(sopra.supabase, ARGS);
      expect(res.deferred).toBe(true);
      expect(sendTemplateAndLog).toHaveBeenCalledTimes(1);
      expect(sopra.calls.events.find((e) => e.type === 'lancio_intake').payload)
        .toMatchObject({ differita: 'tetto_orario', cap: 200 });
    });

    // Fail CLOSED (ruling della review T13): un conteggio che non si legge NON è una
    // licenza di mandare. Il cron ripassa ogni 15 minuti, quindi il prezzo di differire
    // è un ritardo; quello di mandare alla cieca mentre il DB è in affanno è il picco.
    it('conteggio illeggibile: si differisce lo stesso, con il motivo scritto', async () => {
      const { supabase, calls } = makeSupabase(0, true);
      const res = await enrollLeadIntoMario(supabase, ARGS);

      expect(res).toMatchObject({ ok: true, conversationId: 42, deferred: true });
      expect(sendTemplateAndLog).not.toHaveBeenCalled();
      expect(calls.updates[0].lancio_benvenuto_at).toBeNull(); // null, non assente: all'ingresso il timbro del giro precedente si azzera
      expect(calls.updates[0]).toMatchObject({ lancio_slug: 'webdev-2026-10', lancio_fase: 'attesa' });
      expect(calls.events.find((e) => e.type === 'lancio_intake').payload)
        .toMatchObject({ differita: 'tetto_orario', motivo: 'conteggio_fallito', cap: 200 });
      expect(calls.events.some((e) => e.type === 'lancio_tetto_non_letto')).toBe(true);
    });

    it('col lancio spento il tetto non si conta nemmeno: quella query non serve', async () => {
      vi.mocked(getLancioSettings).mockResolvedValueOnce({ attivo: false } as never);
      const { supabase, calls } = makeSupabase(500);
      const res = await enrollLeadIntoMario(supabase, ARGS);
      expect(res.deferred).toBe(true);
      expect(calls.conteggi).toBe(0);
      expect(calls.events.find((e) => e.type === 'lancio_intake').payload.differita).toBe('lancio_spento');
    });

    it('il tetto non tocca le aperture di Mario: quelle non passano da qui', async () => {
      vi.stubEnv('LANCIO_WELCOME_MAX_PER_HOUR', '1');
      const { supabase, calls } = makeSupabase(999);
      await enrollLeadIntoMario(supabase, { phone: '+393331234567', firstName: 'Anna', crmFunnel: 'CORSO 10 ORE' });
      expect(sendTemplateAndLog).toHaveBeenCalledTimes(1);
      expect(calls.conteggi).toBe(0);
    });
  });

  // ── Quota di riscaldamento del numero nuovo (delibera PO 19/09) ───────────────────
  // Vale SOLO sui benvenuti del lancio, e SOLO sulla prima apertura: il numero si sceglie
  // qui e vive in `conversations.wa_number`.
  describe('mittente del benvenuto: la quota verso il numero nuovo', () => {
    const SECONDO = 'whatsapp:+393522070047';
    const impostazioni = (quotaSecondario: number, sender: 'principale' | 'secondario' = 'principale') =>
      vi.mocked(getLancioSettings).mockResolvedValue({
        attivo: true, pulsanteAttivo: false, zoomLink: null, videoLiveLink: null,
        offertaDelMeseLink: null, eventoAt: null, blastPerimetro: 'tutti', sender, quotaSecondario,
      });
    /** Il numero passato a `sendTemplateAndLog`. */
    const mittenteUsato = () => vi.mocked(sendTemplateAndLog).mock.calls[0][5];
    /** Il numero scritto in `conversations.wa_number` alla nascita della chat. */
    const mittenteAllaNascita = () =>
      (vi.mocked(findOrCreateLeadConversation).mock.calls[0][2] as { mittente?: string | null })?.mittente;

    beforeEach(() => {
      vi.stubEnv('TWILIO_WHATSAPP_NUMBER_FENICE_2', SECONDO);
      // Come la funzione vera: il numero scelto alla nascita finisce in `wa_number`, ed
      // e' da li' che ogni invio successivo lo rilegge.
      vi.mocked(findOrCreateLeadConversation).mockImplementation(
        async (_s: unknown, _i: unknown, nascita?: { mittente?: string | null }) =>
          ({ leadId: 7, conversationId: 42, waNumber: nascita?.mittente ?? null }) as never,
      );
    });

    it('quota 0: tutti dal numero storico, come prima', async () => {
      impostazioni(0);
      const { supabase } = makeSupabase();
      await enrollLeadIntoMario(supabase, ARGS);
      expect(mittenteAllaNascita()).toBe('whatsapp:+390000000000');
      expect(mittenteUsato()).toBe('whatsapp:+390000000000');
    });

    it('quota 100: la chat nasce sul numero nuovo e il benvenuto parte di li', async () => {
      impostazioni(100);
      const { supabase } = makeSupabase();
      await enrollLeadIntoMario(supabase, ARGS);
      expect(mittenteAllaNascita()).toBe(SECONDO);
      expect(mittenteUsato()).toBe(SECONDO);
    });

    it('quota 100 ma tetto giornaliero del numero nuovo esaurito: numero storico + avviso', async () => {
      impostazioni(100);
      const { supabase, calls } = makeSupabase(0, false, { aperturaOggiSulSecondo: 150 });
      await enrollLeadIntoMario(supabase, ARGS);
      expect(mittenteUsato()).toBe('whatsapp:+390000000000');
      expect(calls.events.some((e) => e.type === 'lancio_mittente_ripiego')).toBe(true);
    });

    it('lancio_sender=secondario manda tutto dal numero nuovo, quota o non quota', async () => {
      impostazioni(0, 'secondario');
      const { supabase } = makeSupabase();
      await enrollLeadIntoMario(supabase, ARGS);
      expect(mittenteUsato()).toBe(SECONDO);
    });

    // La regola che non si tocca: il numero di una chat si sceglie alla nascita e non
    // cambia piu'. Qui la conversazione esiste gia' ed e' nata sul numero storico.
    it('chat che esiste gia: resta sul suo numero anche con la quota al 100%', async () => {
      impostazioni(100);
      vi.mocked(findOrCreateLeadConversation).mockResolvedValueOnce(
        { leadId: 7, conversationId: 42, waNumber: 'whatsapp:+390000000000' } as never,
      );
      const { supabase } = makeSupabase();
      await enrollLeadIntoMario(supabase, ARGS);
      expect(mittenteUsato()).toBe('whatsapp:+390000000000');
    });

    it('chat nata sul numero nuovo: ci resta anche con la quota a zero', async () => {
      impostazioni(0);
      vi.mocked(findOrCreateLeadConversation).mockResolvedValueOnce(
        { leadId: 7, conversationId: 42, waNumber: SECONDO } as never,
      );
      const { supabase } = makeSupabase();
      await enrollLeadIntoMario(supabase, ARGS);
      expect(mittenteUsato()).toBe(SECONDO);
    });
  });

  it('senza campo lancio il flusso di sempre non cambia (nessuna lettura delle impostazioni)', async () => {
    const { supabase } = makeSupabase();
    await enrollLeadIntoMario(supabase, { phone: '+393331234567', firstName: 'Anna', crmFunnel: 'CORSO 10 ORE' });
    expect(getLancioSettings).not.toHaveBeenCalled();
    expect(vi.mocked(sendTemplateAndLog).mock.calls[0][3]).not.toBe('HX_LANCIO_WELCOME');
  });
});


// --- B2 "lead che scrivono per primi": la guardia che non ricopre una chat gia' avviata.
// I test del branch usavano un mock su `./sequence`; qui si muove l'orologio come fa
// tutto il resto del file (`inOpeningWindow` vero, scelta di main).
describe("enrollLeadIntoMario — guardia chat gia' avviata (apreSopraChatViva)", () => {
  it('chat viva (mario/active, outbound partito) → nessun invio, aperturaSaltata:true, patch solo campi valorizzati', async () => {
    vi.setSystemTime(MEZZOGIORNO);
    const { supabase, calls } = makeSupabase(0, false, {
      convRow: { ai_owner: 'mario', ai_status: 'active', crm_lead_id: 'crm-1' }, outboundCount: 1,
    });

    const res = await enrollLeadIntoMario(supabase, {
      phone: '+393331234567', firstName: 'Anna', crmLeadId: 'crm-1', crmFunnel: 'H',
    });

    expect(res).toMatchObject({ ok: true, conversationId: 42, aperturaSaltata: true });
    expect(sendTemplateAndLog).not.toHaveBeenCalled();
    expect(calls.updates).toHaveLength(1);
    // Solo i campi valorizzati: niente crm_lead_id/crm_funnel a null, niente ai_owner/ai_status/ai_started_at.
    expect(calls.updates[0]).toEqual({ crm_lead_id: 'crm-1', crm_funnel: 'H' });
    expect(calls.events.some((e) => e.type === 'apertura_saltata_chat_in_corso')).toBe(true);
  });

  it('chat viva fuori fascia → vince la guardia, non il ramo differito: aperturaSaltata:true, niente deferred', async () => {
    vi.setSystemTime(NOTTE_FONDA);
    const { supabase, calls } = makeSupabase(0, false, {
      convRow: { ai_owner: 'mario', ai_status: 'active', crm_lead_id: 'crm-1' }, outboundCount: 1,
    });

    const res = await enrollLeadIntoMario(supabase, {
      phone: '+393331234567', firstName: 'Anna', crmLeadId: 'crm-1', crmFunnel: 'H',
    });

    expect(res).toMatchObject({ ok: true, conversationId: 42, aperturaSaltata: true });
    expect(res.deferred).toBeUndefined();
    expect(sendTemplateAndLog).not.toHaveBeenCalled();
    expect(calls.events.some((e) => e.type === 'fenice_enroll_deferred')).toBe(false);
  });

  // Il caso vero: il bot adotta e fissa la call, il CRM legge la lista giorni dopo,
  // crea il lead e manda l'intake. Senza la guardia l'apertura "le tue 10 ore
  // gratuite" arrivava a chi ha gia' la call in agenda, e l'update la riportava ad
  // 'active' facendole perdere il lucchetto sull'appuntamento.
  it("adottato con l'appuntamento gia' preso (booked) → l'apertura non parte", async () => {
    vi.setSystemTime(MEZZOGIORNO);
    const { supabase, calls } = makeSupabase(0, false, {
      convRow: { ai_owner: 'mario', ai_status: 'booked', crm_lead_id: null }, outboundCount: 1,
    });

    const res = await enrollLeadIntoMario(supabase, {
      phone: '+393331234567', crmLeadId: 'crm-9', crmFunnel: 'TELEGRAM',
    });

    expect(res).toMatchObject({ ok: true, aperturaSaltata: true });
    expect(sendTemplateAndLog).not.toHaveBeenCalled();
    // Nessun ai_status/ai_started_at riscritto: l'appuntamento tiene il suo lucchetto.
    expect(calls.updates[0]).toEqual({ crm_lead_id: 'crm-9', crm_funnel: 'TELEGRAM' });
  });

  // Se la riga della conversazione non si riesce a leggere, `crm_lead_id` arriverebbe
  // come nullo e la guardia scatterebbe su un lead del CRM che col bot non ha mai
  // parlato: preso in carico sulla carta e muto nei fatti. Nel dubbio si apre.
  it("select su conversations fallita: l'apertura parte lo stesso", async () => {
    vi.setSystemTime(MEZZOGIORNO);
    const { supabase, calls } = makeSupabase(0, false, { convErrore: true, outboundCount: 3 });

    const res = await enrollLeadIntoMario(supabase, {
      phone: '+393331234567', firstName: 'Anna', crmLeadId: 'crm-1', crmFunnel: 'H',
    });

    expect(res.aperturaSaltata).toBeUndefined();
    expect(sendTemplateAndLog).toHaveBeenCalledTimes(1);
    expect(calls.updates[0]).toMatchObject({ ai_owner: 'mario', ai_status: 'active' });
    expect(calls.events.some((e) => e.type === 'apertura_saltata_chat_in_corso')).toBe(false);
  });

  it('un intake senza funnel non cancella il TELEGRAM dedotto dal webhook', async () => {
    vi.setSystemTime(MEZZOGIORNO);
    const { supabase, calls } = makeSupabase();

    await enrollLeadIntoMario(supabase, { phone: '+393331234567', crmLeadId: 'crm-9' });

    // Ramo normale, non guardia: `crm_funnel` non compare affatto nella patch.
    expect('crm_funnel' in calls.updates[0]).toBe(false);
    expect(calls.updates[0]).toMatchObject({ crm_lead_id: 'crm-9' });
  });
});

describe('apreSopraChatViva', () => {
  const viva = { aiOwner: 'mario', aiStatus: 'active', crmLeadId: 'crm-1', haOutboundPartito: true };
  it('vero: Mario sta già parlando con questa persona', () => {
    expect(apreSopraChatViva(viva)).toBe(true);
  });
  // 'replying' è il lock del drain, non uno stato a parte: una chat che sta
  // rispondendo è viva quanto una 'active' (vedi shouldAutoReply).
  it("vero anche su 'replying': il drain sta rispondendo in questo momento", () => {
    expect(apreSopraChatViva({ ...viva, aiStatus: 'replying' })).toBe(true);
  });
  it('falso su una chat nuova', () => {
    expect(apreSopraChatViva({ aiOwner: null, aiStatus: null, crmLeadId: null, haOutboundPartito: false })).toBe(false);
  });
  // Il caso di riapri-mute: abbiamo PROVATO a mandare l'apertura e non è mai partita.
  // Se la guardia scattasse qui, quelle conversazioni resterebbero mute per sempre.
  it('falso se un invio è stato tentato ma non è mai partito', () => {
    expect(apreSopraChatViva({ ...viva, haOutboundPartito: false })).toBe(false);
  });
  // Un lead del CRM chiuso e ri-arruolato: e' il caso legittimo, l'apertura parte.
  it('falso su una chat del CRM chiusa o passata a una persona', () => {
    expect(apreSopraChatViva({ ...viva, aiStatus: 'closed' })).toBe(false);
    expect(apreSopraChatViva({ ...viva, aiStatus: 'handed_off' })).toBe(false);
  });
  it('falso se la chat non è di Mario', () => {
    expect(apreSopraChatViva({ ...viva, aiOwner: null })).toBe(false);
  });

  // Adottato = nessun leadId del CRM e un nostro messaggio gia' partito. La lista di
  // /api/bot/lead-entranti li manda al CRM anche da booked/closed/handed_off, e
  // l'intake arriva giorni dopo: l'apertura non deve partire in nessuno di quegli stati.
  const adottato = { aiOwner: 'mario', aiStatus: 'active', crmLeadId: null, haOutboundPartito: true };
  it("vero su un adottato che ha gia' l'appuntamento in agenda (booked)", () => {
    expect(apreSopraChatViva({ ...adottato, aiStatus: 'booked' })).toBe(true);
  });
  it('vero su un adottato passato a una persona (handed_off)', () => {
    expect(apreSopraChatViva({ ...adottato, aiStatus: 'handed_off' })).toBe(true);
  });
  it('vero su un adottato chiuso con un esito (closed)', () => {
    expect(apreSopraChatViva({ ...adottato, aiStatus: 'closed' })).toBe(true);
  });
  // La regola vale solo per chi ha gia' visto un nostro messaggio: senza outbound
  // partito resta il caso di riapri-mute, dove l'apertura non e' mai uscita.
  it("falso su un adottato a cui non e' mai partito niente", () => {
    expect(apreSopraChatViva({ ...adottato, haOutboundPartito: false })).toBe(false);
  });
});
