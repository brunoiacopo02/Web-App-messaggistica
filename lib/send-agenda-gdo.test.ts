import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./fenice-enroll', () => ({
  enrollGdoLeadAsPostino: vi.fn(async () => ({ ok: true, conversationId: 42, sid: 'SM_AGENDA' })),
}));

import { runSendAgenda, handleGdoDeliveryUpdate, DEFAULT_CRM_AGENDA_DELIVERED_URL } from './send-agenda-gdo';
import { enrollGdoLeadAsPostino } from './fenice-enroll';

const PAYLOAD = {
  leadId: 'gdo-1',
  name: 'Mario Rossi',
  phone: '333 123 4567',
  email: 'mario@esempio.it',
  funnel: 'Nome funnel',
  companyId: 'fenice',
  variant: { lavora: true, haFamiglia: false, offertaDelMese: false },
};

/**
 * Fake Supabase: la riga precedente del lead (per la deduplica) e lo stato Twilio del
 * messaggio appena inviato, che cambia nel tempo come farebbero le status callback.
 */
function makeSupabase(opts: { convPrecedente?: any; statusSequence?: (string | null)[] } = {}) {
  const statusSequence = opts.statusSequence ?? [null];
  let letture = 0;
  const calls = { updates: [] as any[], events: [] as any[] };

  const supabase: any = {
    from(table: string) {
      if (table === 'conversations') {
        return {
          select() {
            const stub: any = {
              eq() { return stub; },
              order() { return stub; },
              limit() { return Promise.resolve({ data: opts.convPrecedente ? [opts.convPrecedente] : [] }); },
            };
            return stub;
          },
          update(payload: any) { calls.updates.push(payload); return { eq() { return Promise.resolve({}); } }; },
        };
      }
      if (table === 'messages') {
        return {
          select() {
            const stub: any = {
              eq() { return stub; },
              maybeSingle() {
                const s = statusSequence[Math.min(letture++, statusSequence.length - 1)];
                return Promise.resolve({ data: { twilio_status: s } });
              },
            };
            return stub;
          },
        };
      }
      return { insert(payload: any) { calls.events.push(payload); return Promise.resolve({}); } };
    },
  };
  return { supabase, calls };
}

/** Attesa istantanea: il tempo lo fa avanzare `sleep`, i test non aspettano davvero. */
function fakeDeps() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => { t += ms; } };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(enrollGdoLeadAsPostino).mockResolvedValue({ ok: true, conversationId: 42, sid: 'SM_AGENDA' });
});
afterEach(() => { vi.unstubAllEnvs(); });

describe('runSendAgenda — i tre stati che vede il GDO', () => {
  it('consegna confermata entro l\'attesa → consegnato', async () => {
    const { supabase, calls } = makeSupabase({ statusSequence: ['queued', 'delivered'] });

    const res = await runSendAgenda(supabase, PAYLOAD, fakeDeps());

    expect(res).toMatchObject({ ok: true, esito: 'consegnato', conversationId: 42 });
    expect(enrollGdoLeadAsPostino).toHaveBeenCalledTimes(1);
    // L'esito definitivo resta sulla riga: è quello che la deduplica ripeterà.
    expect(calls.updates.at(-1)).toMatchObject({ gdo_agenda_esito: 'consegnato' });
    expect(calls.events.some((e) => e.type === 'gdo_agenda_esito')).toBe(true);
  });

  it('telefono spento: nessun delivered entro l\'attesa → inviato, non fallito', async () => {
    const { supabase, calls } = makeSupabase({ statusSequence: ['sent'] });

    const res = await runSendAgenda(supabase, PAYLOAD, fakeDeps());

    expect(res).toMatchObject({ ok: true, esito: 'inviato' });
    expect(calls.updates.at(-1)).toMatchObject({ gdo_agenda_esito: 'inviato' });
  });

  it('Twilio rifiuta l\'invio → fallito, senza aspettare nessuna consegna', async () => {
    vi.mocked(enrollGdoLeadAsPostino).mockResolvedValue({ ok: false, conversationId: 42, error: 'twilio 63024' });
    const { supabase } = makeSupabase({ statusSequence: ['delivered'] });

    const res = await runSendAgenda(supabase, PAYLOAD, fakeDeps());

    expect(res).toMatchObject({ ok: false, esito: 'fallito', error: 'twilio 63024' });
  });

  it('numero non normalizzabile → fallito subito, nessun invio', async () => {
    const { supabase, calls } = makeSupabase();

    const res = await runSendAgenda(supabase, { ...PAYLOAD, phone: 'non un numero' }, fakeDeps());

    expect(res).toMatchObject({ ok: false, esito: 'fallito', error: 'invalid_phone' });
    expect(enrollGdoLeadAsPostino).not.toHaveBeenCalled();
    expect(calls.events.some((e) => e.type === 'gdo_agenda_skipped' && e.level === 'warn')).toBe(true);
  });

  it('il telefono grezzo del CRM viene normalizzato in E.164 prima dell\'invio', async () => {
    const { supabase } = makeSupabase({ statusSequence: ['delivered'] });

    await runSendAgenda(supabase, PAYLOAD, fakeDeps());

    expect(vi.mocked(enrollGdoLeadAsPostino).mock.calls[0][1]).toMatchObject({
      phone: '+393331234567',
      crmLeadId: 'gdo-1',
      variant: PAYLOAD.variant,
    });
  });
});

describe('runSendAgenda — deduplica a 15 minuti', () => {
  const ORA = Date.parse('2026-07-29T10:00:00Z');
  const minutiFa = (m: number) => new Date(ORA - m * 60_000).toISOString();
  const conOrologio = () => {
    let t = ORA;
    return { now: () => t, sleep: async (ms: number) => { t += ms; } };
  };

  it('secondo click sullo stesso lead entro 15 minuti → niente re-invio, stesso esito di prima', async () => {
    const { supabase, calls } = makeSupabase({
      convPrecedente: { id: 42, gdo_agenda_at: minutiFa(3), gdo_agenda_esito: 'consegnato' },
    });

    const res = await runSendAgenda(supabase, PAYLOAD, conOrologio());

    expect(res).toMatchObject({ ok: true, esito: 'consegnato', deduplicato: true, conversationId: 42 });
    expect(enrollGdoLeadAsPostino).not.toHaveBeenCalled();
    expect(calls.events.some((e) => e.type === 'gdo_agenda_dedup')).toBe(true);
  });

  it('dopo un fallimento vero il GDO può ritentare subito', async () => {
    const { supabase } = makeSupabase({
      convPrecedente: { id: 42, gdo_agenda_at: minutiFa(3), gdo_agenda_esito: 'fallito' },
      statusSequence: ['delivered'],
    });

    const res = await runSendAgenda(supabase, PAYLOAD, conOrologio());

    expect(res).toMatchObject({ ok: true, esito: 'consegnato' });
    expect(enrollGdoLeadAsPostino).toHaveBeenCalledTimes(1);
  });

  it('oltre i 15 minuti l\'agenda si rimanda', async () => {
    const { supabase } = makeSupabase({
      convPrecedente: { id: 42, gdo_agenda_at: minutiFa(16), gdo_agenda_esito: 'consegnato' },
      statusSequence: ['delivered'],
    });

    const res = await runSendAgenda(supabase, PAYLOAD, conOrologio());

    expect(res.deduplicato ?? false).toBe(false);
    expect(enrollGdoLeadAsPostino).toHaveBeenCalledTimes(1);
  });

  it('lead mai visto → nessuna deduplica', async () => {
    const { supabase } = makeSupabase({ statusSequence: ['delivered'] });

    const res = await runSendAgenda(supabase, PAYLOAD, conOrologio());

    expect(res.deduplicato ?? false).toBe(false);
    expect(enrollGdoLeadAsPostino).toHaveBeenCalledTimes(1);
  });
});

describe('runSendAgenda — il CRM aspetta al massimo 10 secondi', () => {
  it('l\'attesa della consegna non supera gli 8 secondi dall\'inizio della richiesta', async () => {
    let t = 0;
    const deps = { now: () => t, sleep: async (ms: number) => { t += ms; } };
    // L'invio a Twilio consuma già 2 secondi prima che si inizi ad attendere.
    vi.mocked(enrollGdoLeadAsPostino).mockImplementation(async () => {
      t += 2_000;
      return { ok: true, conversationId: 42, sid: 'SM_AGENDA' };
    });
    const { supabase } = makeSupabase({ statusSequence: ['sent'] });

    const res = await runSendAgenda(supabase, PAYLOAD, deps);

    expect(res.esito).toBe('inviato');
    expect(t).toBeLessThanOrEqual(8_000);
  });
});

describe('runSendAgenda — correzione della variante entro la finestra di deduplica', () => {
  const ORA = Date.parse('2026-07-29T10:00:00Z');
  const conOrologio = () => {
    let t = ORA;
    return { now: () => t, sleep: async (ms: number) => { t += ms; } };
  };
  const treMinutiFa = new Date(ORA - 3 * 60_000).toISOString();
  const BX = 'https://corso.feniceacademy.it/conferenza-bx';
  const DX = 'https://corso.feniceacademy.it/conferenza-dx';

  it('stessa variante → deduplica secca, niente da correggere', async () => {
    const { supabase, calls } = makeSupabase({
      convPrecedente: { id: 42, gdo_agenda_at: treMinutiFa, gdo_agenda_esito: 'consegnato', gdo_video_url: BX, gdo_video_sent_at: null },
    });

    const res = await runSendAgenda(supabase, PAYLOAD, conOrologio());

    expect(res).toMatchObject({ deduplicato: true, varianteAggiornata: false });
    expect(calls.updates).toHaveLength(0);
  });

  // Il GDO sbaglia lavora/famiglia e corregge subito: l'agenda NON si rimanda (il lead
  // riceverebbe due volte lo stesso testo) ma il video che partirà dev'essere quello giusto.
  it('variante corretta prima che il video parta → si aggiorna il video, non si rimanda l\'agenda', async () => {
    const { supabase, calls } = makeSupabase({
      convPrecedente: { id: 42, gdo_agenda_at: treMinutiFa, gdo_agenda_esito: 'consegnato', gdo_video_url: BX, gdo_video_sent_at: null },
    });

    const res = await runSendAgenda(
      supabase,
      { ...PAYLOAD, variant: { lavora: true, haFamiglia: true, offertaDelMese: false } },
      conOrologio(),
    );

    expect(res).toMatchObject({ ok: true, deduplicato: true, varianteAggiornata: true, esito: 'consegnato' });
    expect(enrollGdoLeadAsPostino).not.toHaveBeenCalled();
    expect(calls.updates.at(-1)).toMatchObject({ gdo_video_url: DX });
    expect(calls.events.some((e) => e.type === 'gdo_variante_corretta')).toBe(true);
  });

  it('variante corretta troppo tardi, video già partito → lo dice al GDO invece di fingere', async () => {
    const { supabase, calls } = makeSupabase({
      convPrecedente: { id: 42, gdo_agenda_at: treMinutiFa, gdo_agenda_esito: 'consegnato', gdo_video_url: BX, gdo_video_sent_at: new Date(ORA - 60_000).toISOString() },
    });

    const res = await runSendAgenda(
      supabase,
      { ...PAYLOAD, variant: { lavora: true, haFamiglia: true, offertaDelMese: false } },
      conOrologio(),
    );

    expect(res).toMatchObject({ deduplicato: true, varianteAggiornata: false, videoGiaInviato: true });
    // Il video sbagliato è già dal lead: non si riscrive la colonna come se nulla fosse.
    expect(calls.updates).toHaveLength(0);
    expect(calls.events.some((e) => e.type === 'gdo_variante_tardiva' && e.level === 'warn')).toBe(true);
  });
});

describe('handleGdoDeliveryUpdate — l\'inviato che poi arriva davvero', () => {
  const AGENDA_SID = 'HX_AGENDA_GDO';

  /** Fake Supabase per il percorso delle status callback di Twilio. */
  function makeDeliverySupabase(opts: { msg?: any; conv?: any } = {}) {
    const calls = { updates: [] as any[], events: [] as any[] };
    const supabase: any = {
      from(table: string) {
        if (table === 'messages') {
          return {
            select() {
              const stub: any = { eq() { return stub; }, maybeSingle: () => Promise.resolve({ data: opts.msg ?? null }) };
              return stub;
            },
          };
        }
        if (table === 'conversations') {
          return {
            select() {
              const stub: any = { eq() { return stub; }, maybeSingle: () => Promise.resolve({ data: opts.conv ?? null }) };
              return stub;
            },
            update(payload: any) { calls.updates.push(payload); return { eq() { return Promise.resolve({}); } }; },
          };
        }
        return { insert(payload: any) { calls.events.push(payload); return Promise.resolve({}); } };
      },
    };
    return { supabase, calls };
  }

  const MSG = { conversation_id: 42, template_sid: AGENDA_SID };
  const CONV = { id: 42, crm_lead_id: 'gdo-1', gdo_agenda_esito: 'inviato' };

  beforeEach(() => {
    vi.stubEnv('AGENDA_GDO_TEMPLATE_SID', AGENDA_SID);
    vi.stubEnv('BOT_WEBHOOK_SECRET', 'test-secret');
    vi.stubEnv('CRM_AGENDA_DELIVERED_URL', 'https://crm.example/api/bot/agenda-delivered');
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, text: async () => '' })));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('agenda finita in inviato che arriva → esito a consegnato e avviso firmato al CRM', async () => {
    const { supabase, calls } = makeDeliverySupabase({ msg: MSG, conv: CONV });

    const res = await handleGdoDeliveryUpdate(supabase, { sid: 'SM1', status: 'delivered' });

    expect(res).toMatchObject({ updated: true, notified: true });
    expect(calls.updates).toEqual([{ gdo_agenda_esito: 'consegnato' }]);
    const [url, init] = (globalThis.fetch as any).mock.calls[0];
    expect(url).toBe('https://crm.example/api/bot/agenda-delivered');
    expect(init.headers['x-bot-signature']).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(JSON.parse(init.body)).toMatchObject({ leadId: 'gdo-1', esito: 'consegnato', sid: 'SM1' });
    expect(calls.events.some((e) => e.type === 'gdo_agenda_consegna_tardiva')).toBe(true);
  });

  it('anche la lettura vale come consegna', async () => {
    const { supabase } = makeDeliverySupabase({ msg: MSG, conv: CONV });
    expect(await handleGdoDeliveryUpdate(supabase, { sid: 'SM1', status: 'read' })).toMatchObject({ updated: true });
  });

  it('stato intermedio → non si annuncia niente', async () => {
    const { supabase, calls } = makeDeliverySupabase({ msg: MSG, conv: CONV });

    const res = await handleGdoDeliveryUpdate(supabase, { sid: 'SM1', status: 'sent' });

    expect(res).toMatchObject({ updated: false });
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(calls.updates).toHaveLength(0);
  });

  it('esito già consegnato → nessun secondo avviso (le callback di Twilio si ripetono)', async () => {
    const { supabase, calls } = makeDeliverySupabase({ msg: MSG, conv: { ...CONV, gdo_agenda_esito: 'consegnato' } });

    const res = await handleGdoDeliveryUpdate(supabase, { sid: 'SM1', status: 'read' });

    expect(res).toMatchObject({ updated: false });
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(calls.updates).toHaveLength(0);
  });

  it('messaggio che non è l\'agenda GDO → non ci riguarda', async () => {
    const { supabase } = makeDeliverySupabase({ msg: { conversation_id: 42, template_sid: 'HX_ALTRO' }, conv: CONV });
    expect(await handleGdoDeliveryUpdate(supabase, { sid: 'SM1', status: 'delivered' })).toMatchObject({ updated: false });
  });

  it('messaggio sconosciuto → nessun errore, nessuna azione', async () => {
    const { supabase } = makeDeliverySupabase({ msg: null, conv: null });
    expect(await handleGdoDeliveryUpdate(supabase, { sid: 'ignoto', status: 'delivered' })).toMatchObject({ updated: false });
  });

  // Questo test diceva il contrario fino al 07/08: senza env, nessuna chiamata. E'
  // esattamente cio' che e' successo in produzione — l'endpoint del CRM, online dal 30
  // luglio, ha ricevuto ZERO chiamate perche' CRM_AGENDA_DELIVERED_URL non e' mai stata
  // configurata su Vercel, e 63 agende su 316 sono rimaste "inviato" per sempre col
  // reinvio bloccato. Una env dimenticata non deve poter zittire un canale.
  it('senza CRM_AGENDA_DELIVERED_URL l\'avviso parte lo stesso, sull\'URL di default', async () => {
    vi.stubEnv('CRM_AGENDA_DELIVERED_URL', '');
    const { supabase, calls } = makeDeliverySupabase({ msg: MSG, conv: CONV });

    const res = await handleGdoDeliveryUpdate(supabase, { sid: 'SM1', status: 'delivered' });

    expect(res).toMatchObject({ updated: true, notified: true });
    expect(calls.updates).toEqual([{ gdo_agenda_esito: 'consegnato' }]);
    const [url, init] = (globalThis.fetch as any).mock.calls[0];
    expect(url).toBe(DEFAULT_CRM_AGENDA_DELIVERED_URL);
    expect(init.headers['x-bot-signature']).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(JSON.parse(init.body)).toMatchObject({ leadId: 'gdo-1', esito: 'consegnato', sid: 'SM1' });
  });

  it('l\'env, se c\'e\', vince sul default', async () => {
    const { supabase } = makeDeliverySupabase({ msg: MSG, conv: CONV });
    await handleGdoDeliveryUpdate(supabase, { sid: 'SM1', status: 'delivered' });
    expect((globalThis.fetch as any).mock.calls[0][0]).toBe('https://crm.example/api/bot/agenda-delivered');
  });

  it('senza segreto HMAC non si manda niente in chiaro', async () => {
    vi.stubEnv('BOT_WEBHOOK_SECRET', '');
    const { supabase, calls } = makeDeliverySupabase({ msg: MSG, conv: CONV });

    const res = await handleGdoDeliveryUpdate(supabase, { sid: 'SM1', status: 'delivered' });

    expect(res).toMatchObject({ updated: true, notified: false });
    expect(calls.updates).toEqual([{ gdo_agenda_esito: 'consegnato' }]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('CRM irraggiungibile: il nostro esito resta corretto e l\'errore resta scritto', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('rete'); }));
    const { supabase, calls } = makeDeliverySupabase({ msg: MSG, conv: CONV });

    const res = await handleGdoDeliveryUpdate(supabase, { sid: 'SM1', status: 'delivered' });

    expect(res).toMatchObject({ updated: true, notified: false });
    expect(calls.updates).toEqual([{ gdo_agenda_esito: 'consegnato' }]);
    expect(calls.events.some((e) => e.type === 'gdo_agenda_notifica_fallita' && e.level === 'error')).toBe(true);
  });
});
