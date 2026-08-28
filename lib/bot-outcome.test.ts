import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sendOutcome, sendCrmNota } from './bot-outcome';
import { romeOffset } from './rome-time';

const DATE = '2026-06-29T17:00:00Z';

/**
 * Un giorno lavorativo futuro all'ora indicata, in ora di Roma. Le fixture a data fissa
 * scadono: `checkDataAppuntamento` scarta i giorni passati, le domeniche e le ore fuori
 * dalla fascia 09-21, quindi un appuntamento "buono" va costruito relativo a adesso.
 */
function giornoUtile(ora = 15, piuGiorni = 3): string {
  const d = new Date(Date.now() + piuGiorni * 86_400_000);
  if (d.getUTCDay() === 0) d.setUTCDate(d.getUTCDate() + 1);
  const key = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
  return `${key}T${String(ora).padStart(2, '0')}:00:00${romeOffset(d)}`;
}

/**
 * Data di richiamo plausibile, relativa a adesso. Fissarla a una data assoluta la fa
 * scadere: `checkDataRichiamo` scarta le date nel passato, e una fixture scritta come
 * "domani" diventa rossa a mezzanotte senza che nessuno abbia toccato il codice.
 */
const FRA_TRE_GIORNI = new Date(Date.now() + 3 * 86400_000).toISOString();

/** Valore di una colonna secondo il filtro passato a `.eq()`. Riproduce la sintassi
 *  Postgres `payload->>chiave` che la guardia anti-duplicato usa sul JSON. */
function valoreColonna(riga: any, colonna: string): string | undefined {
  const json = colonna.match(/^payload->>(.+)$/);
  const v = json ? riga?.payload?.[json[1]] : riga?.[colonna];
  return v == null ? undefined : String(v);
}

/**
 * Fake del client Supabase: traccia update ed event_log, restituisce una riga fissa
 * per `conversations`.
 * `eventLogRows` sono le righe gia presenti su event_log: la select le filtra davvero
 * applicando gli `.eq()` ricevuti, cosi la guardia anti-duplicato deve interrogare il
 * tipo, la conversazione e l'impronta giusti per trovarle.
 */
function makeSupabase(convRow: any, opts: { eventLogRows?: any[] } = {}) {
  const eventLogRows = opts.eventLogRows ?? [];
  const calls = { updates: [] as any[], events: [] as any[], eventLogQueries: [] as [string, string][][] };
  const supabase: any = {
    from(table: string) {
      if (table === 'conversations') {
        return {
          select() { return this; },
          eq() { return this; },
          maybeSingle() { return Promise.resolve({ data: convRow }); },
          update(payload: any) { calls.updates.push(payload); return { eq() { return Promise.resolve({}); } }; },
        };
      }
      return {
        insert(payload: any) { calls.events.push(payload); return Promise.resolve({}); },
        select() {
          const filtri: [string, string][] = [];
          const stub: any = {
            eq(colonna: string, valore: string) { filtri.push([colonna, valore]); return stub; },
            limit() {
              calls.eventLogQueries.push([...filtri]);
              const data = eventLogRows.filter((r) =>
                filtri.every(([colonna, valore]) => valoreColonna(r, colonna) === valore));
              return Promise.resolve({ data });
            },
          };
          return stub;
        },
      };
    },
  };
  return { supabase, calls };
}

/** Nota gia inviata: fa girare sendOutcome una prima volta e restituisce l'evento
 *  `bot_outcome_locked` che avrebbe lasciato su event_log, da riusare come precedente. */
async function eventoLockedGiaScritto(convRow: any, conversationId: number, args: any) {
  const { supabase, calls } = makeSupabase(convRow);
  await sendOutcome(supabase, conversationId, args);
  const locked = calls.events.find((e: { type: string }) => e.type === 'bot_outcome_locked');
  return { id: 1, ...locked };
}

beforeEach(() => {
  vi.stubEnv('BOT_WEBHOOK_SECRET', 'test-secret');
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, text: async () => '' })));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('sendOutcome — guard APPUNTAMENTO terminale', () => {
  it('lead già APPUNTAMENTO + SCARTO → invia NOTA (mai APPUNTAMENTO), senza date, riga NON toccata, log locked', async () => {
    const { supabase, calls } = makeSupabase({ crm_lead_id: 'crm1', bot_outcome: 'APPUNTAMENTO', bot_scheduled_at: DATE });
    const res = await sendOutcome(supabase, 1, { outcome: 'DA_SCARTARE', discardReason: 'la madre non paga' });

    expect(res.sent).toBe(true);
    const fetchMock = (globalThis.fetch as any);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.outcome).toBe('NOTA');
    expect(body.outcome).not.toBe('APPUNTAMENTO');
    expect(body.date).toBeUndefined();
    expect(body.note).toContain('annullare');
    // La riga viene chiusa (stop al loop del cron) ma l'esito resta congelato.
    // DA_SCARTARE su un appuntamento fissato è anche una richiesta di disdetta: si
    // aggiunge il marcatore, prima della chiusura.
    expect(calls.updates).toEqual([{ cancel_requested_at: expect.any(String) }, { ai_status: 'closed' }]);
    expect(calls.events.some((e) => e.type === 'bot_outcome_locked' && e.payload.sentAs === 'NOTA')).toBe(true);
  });

  it('lead già APPUNTAMENTO senza data originale → invia comunque NOTA (la data non serve più)', async () => {
    const { supabase, calls } = makeSupabase({ crm_lead_id: 'crm1', bot_outcome: 'APPUNTAMENTO', bot_scheduled_at: null });
    const res = await sendOutcome(supabase, 1, { outcome: 'INTERROTTO' });

    expect(res.sent).toBe(true);
    const fetchMock = (globalThis.fetch as any);
    expect(fetchMock.mock.calls).toHaveLength(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.outcome).toBe('NOTA');
    expect(body.date).toBeUndefined();
    expect(calls.updates).toEqual([{ ai_status: 'closed' }]);
    expect(calls.events.some((e) => e.type === 'bot_outcome_locked')).toBe(true);
  });

  it('lead già APPUNTAMENTO + POST fallito → riga NON toccata (ritentabile)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, text: async () => 'boom' })));
    const { supabase, calls } = makeSupabase({ crm_lead_id: 'crm1', bot_outcome: 'APPUNTAMENTO', bot_scheduled_at: DATE });
    const res = await sendOutcome(supabase, 1, { outcome: 'INTERROTTO' });

    expect(res.sent).toBe(false);
    expect(calls.updates).toHaveLength(0);
    expect(calls.events.some((e) => e.type === 'bot_outcome_error')).toBe(true);
  });

  it('lead non ancora deciso + APPUNTAMENTO → comportamento normale (persiste e chiude)', async () => {
    const { supabase, calls } = makeSupabase({ crm_lead_id: 'crm1', bot_outcome: null, bot_scheduled_at: null });
    const res = await sendOutcome(supabase, 1, { outcome: 'APPUNTAMENTO', date: giornoUtile() });

    expect(res.sent).toBe(true);
    expect(calls.updates[0]).toMatchObject({ bot_outcome: 'APPUNTAMENTO', ai_status: 'closed' });
    expect(calls.events.some((e) => e.type === 'bot_outcome_sent')).toBe(true);
  });

  it('CRM 403 su lead normale → persiste esito localmente, chiude, log rejected (no retry loop)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 403, text: async () => 'lead non assegnato' })));
    const { supabase, calls } = makeSupabase({ crm_lead_id: 'crm1', bot_outcome: null, bot_scheduled_at: null });
    const res = await sendOutcome(supabase, 1, { outcome: 'INTERROTTO', note: 'nota' });

    expect(res.sent).toBe(false);
    expect(res.status).toBe(403);
    expect(calls.updates[0]).toMatchObject({ bot_outcome: 'INTERROTTO', ai_status: 'closed' });
    expect(calls.events.some((e) => e.type === 'bot_outcome_rejected' && e.level === 'warn')).toBe(true);
  });

  it('CRM 403 su lead già APPUNTAMENTO → chiude senza declassare bot_outcome, body inviato è NOTA', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 403, text: async () => 'no' })));
    const { supabase, calls } = makeSupabase({ crm_lead_id: 'crm1', bot_outcome: 'APPUNTAMENTO', bot_scheduled_at: DATE });
    const res = await sendOutcome(supabase, 1, { outcome: 'DA_SCARTARE', discardReason: 'x' });

    expect(res.sent).toBe(false);
    const fetchMock = (globalThis.fetch as any);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.outcome).toBe('NOTA');
    expect(body.outcome).not.toBe('APPUNTAMENTO');
    expect(calls.updates).toEqual([{ cancel_requested_at: expect.any(String) }, { ai_status: 'closed' }]);
    expect(calls.events.some((e) => e.type === 'bot_outcome_rejected')).toBe(true);
  });
});

describe('sendOutcome — RICHIAMO interim', () => {
  it('interim su lead in lavorazione → POST inviato, nessuna persistenza locale', async () => {
    const { supabase, calls } = makeSupabase({ crm_lead_id: 'crm1', bot_outcome: null, bot_scheduled_at: null });
    const res = await sendOutcome(supabase, 1, { outcome: 'RICHIAMO', date: FRA_TRE_GIORNI, note: 'seq' }, { interim: true });

    expect(res.sent).toBe(true);
    const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
    expect(body.outcome).toBe('RICHIAMO');
    expect(calls.updates).toHaveLength(0);  // conversazione resta aperta
    expect(calls.events.some((e) => e.type === 'bot_outcome_sent' && e.payload.interim === true)).toBe(true);
  });

  it('interim su lead già APPUNTAMENTO → nessun POST (mai riportare indietro lo stato)', async () => {
    const { supabase, calls } = makeSupabase({ crm_lead_id: 'crm1', bot_outcome: 'APPUNTAMENTO', bot_scheduled_at: DATE });
    const res = await sendOutcome(supabase, 1, { outcome: 'RICHIAMO', date: FRA_TRE_GIORNI }, { interim: true });

    expect(res.sent).toBe(false);
    expect(res.error).toBe('interim_skipped_locked');
    expect((globalThis.fetch as any).mock.calls).toHaveLength(0);
    expect(calls.updates).toHaveLength(0);
  });

  it('interim con CRM 403 → nessuna persistenza (RICHIAMO non è un esito nostro)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 403, text: async () => 'no' })));
    const { supabase, calls } = makeSupabase({ crm_lead_id: 'crm1', bot_outcome: null, bot_scheduled_at: null });
    const res = await sendOutcome(supabase, 1, { outcome: 'RICHIAMO', date: FRA_TRE_GIORNI }, { interim: true });

    expect(res.sent).toBe(false);
    expect(calls.updates).toHaveLength(0);
    expect(calls.events.some((e) => e.type === 'bot_outcome_rejected')).toBe(true);
  });

  // La guardia "RICHIAMO senza data plausibile" (vedi sendOutcome) sta prima del
  // ramo interim: senza l'esclusione esplicita si mangerebbe anche gli interim,
  // convertendoli in una NOTA che racconta al commerciale una richiesta del lead
  // che non è mai esistita — l'interim è un ping automatico della sequenza, non
  // qualcosa che il lead ha detto. In produzione la data del cron è sempre futura
  // quindi il caso non scatta mai, ma un interim con data passata deve comunque
  // seguire il percorso interim normale, non diventare una nota.
  it('interim con data nel passato su lead in lavorazione → resta un interim normale, non diventa una nota', async () => {
    const { supabase, calls } = makeSupabase({ crm_lead_id: 'crm1', bot_outcome: null, bot_scheduled_at: null });
    const PASSATA = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const res = await sendOutcome(supabase, 1, { outcome: 'RICHIAMO', date: PASSATA, note: 'seq' }, { interim: true });

    expect(res.sent).toBe(true);
    const fetchMock = globalThis.fetch as unknown as { mock: { calls: [string, { body: string }][] } };
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.outcome).toBe('RICHIAMO');
    expect(calls.updates).toHaveLength(0);
    expect(calls.events.some((e) => e.type === 'richiamo_senza_data')).toBe(false);
    expect(calls.events.some((e) => e.type === 'bot_outcome_sent' && e.payload.interim === true)).toBe(true);
  });
});

describe('sendOutcome — nota duplicata non rimandata', () => {
  const CONV = { crm_lead_id: 'crm1', bot_outcome: 'APPUNTAMENTO', bot_scheduled_at: DATE };
  const ARGS = { outcome: 'DA_SCARTARE' as const, discardReason: 'non ha budget' };

  it('non rimanda al CRM una nota identica gia inviata', async () => {
    const precedente = await eventoLockedGiaScritto(CONV, 42, ARGS);
    (globalThis.fetch as any).mockClear();
    const { supabase, calls } = makeSupabase(CONV, { eventLogRows: [precedente] });

    const res = await sendOutcome(supabase, 42, ARGS);

    expect(res).toEqual({ sent: false, error: 'note_duplicate' });
    expect((globalThis.fetch as any)).not.toHaveBeenCalled();
    // La query deve cercare il tipo, LA conversazione e L'impronta giusti.
    expect(calls.eventLogQueries[0]).toEqual([
      ['type', 'bot_outcome_locked'],
      ['payload->>conversationId', '42'],
      ['payload->>noteFingerprint', precedente.payload.noteFingerprint],
    ]);
  });

  it('la soppressione della nota duplicata lascia traccia su event_log', async () => {
    const precedente = await eventoLockedGiaScritto(CONV, 42, ARGS);
    const { supabase, calls } = makeSupabase(CONV, { eventLogRows: [precedente] });

    await sendOutcome(supabase, 42, ARGS);

    const evento = calls.events.find((e: { type: string }) => e.type === 'bot_outcome_note_duplicate');
    expect(evento).toBeDefined();
    expect(evento.level).toBe('info');
    expect(evento.payload).toMatchObject({
      conversationId: 42,
      crmLeadId: 'crm1',
      attemptedOutcome: 'DA_SCARTARE',
      noteFingerprint: precedente.payload.noteFingerprint,
    });
    expect(evento.message).toContain('crm1');
  });

  it('chiude comunque la conversazione: la nota duplicata resta un esito terminale', async () => {
    const precedente = await eventoLockedGiaScritto(CONV, 42, ARGS);
    const { supabase, calls } = makeSupabase(CONV, { eventLogRows: [precedente] });

    await sendOutcome(supabase, 42, ARGS);

    // Stesso trattamento dell'invio riuscito: nessun declassamento di bot_outcome,
    // ma la riga non resta 'active' con un esito terminale in attesa del cron.
    // ARGS è DA_SCARTARE su un appuntamento fissato: anche qui parte il marcatore.
    expect(calls.updates).toEqual([{ cancel_requested_at: expect.any(String) }, { ai_status: 'closed' }]);
  });

  it('la stessa nota su un\'altra conversazione viene inviata', async () => {
    const precedente = await eventoLockedGiaScritto(CONV, 42, ARGS);
    (globalThis.fetch as any).mockClear();
    const { supabase } = makeSupabase(CONV, { eventLogRows: [precedente] });

    const res = await sendOutcome(supabase, 99, ARGS);

    expect(res.sent).toBe(true);
    expect((globalThis.fetch as any).mock.calls).toHaveLength(1);
  });

  it('una nota diversa sulla stessa conversazione viene inviata', async () => {
    const precedente = await eventoLockedGiaScritto(CONV, 42, ARGS);
    (globalThis.fetch as any).mockClear();
    const { supabase } = makeSupabase(CONV, { eventLogRows: [precedente] });

    const res = await sendOutcome(supabase, 42, { outcome: 'DA_SCARTARE', discardReason: 'ci ha ripensato' });

    expect(res.sent).toBe(true);
    const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
    expect(body.outcome).toBe('NOTA');
  });

  it('un evento di tipo diverso con la stessa impronta non blocca l\'invio', async () => {
    const precedente = await eventoLockedGiaScritto(CONV, 42, ARGS);
    (globalThis.fetch as any).mockClear();
    const { supabase } = makeSupabase(CONV, {
      eventLogRows: [{ ...precedente, type: 'bot_outcome_sent' }],
    });

    const res = await sendOutcome(supabase, 42, ARGS);

    expect(res.sent).toBe(true);
  });

  it('invia la nota quando non ce n\'e una identica', async () => {
    const { supabase } = makeSupabase(CONV);
    const res = await sendOutcome(supabase, 42, ARGS);

    expect(res.sent).toBe(true);
    const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
    expect(body.outcome).toBe('NOTA');
  });

  it('registra l\'impronta della nota nell\'evento locked', async () => {
    const { supabase, calls } = makeSupabase(CONV);
    await sendOutcome(supabase, 42, ARGS);

    const locked = calls.events.find((e: { type: string }) => e.type === 'bot_outcome_locked');
    expect(locked.payload.noteFingerprint).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('sendOutcome — RICHIAMO con data non utilizzabile', () => {
  const attivo = { crm_lead_id: 'crm1', bot_outcome: null, bot_scheduled_at: null };
  const bodyInviato = () => JSON.parse(vi.mocked(globalThis.fetch).mock.calls[0][1]!.body as string);

  // Dal contratto v1.5: se il lead dice QUANDO con parole sue, quelle parole partono
  // nel campo `periodo` e il richiamo resta un richiamo. Prima diventava una nota, e
  // il CRM non aveva modo di rimetterlo in agenda.
  it('col periodo detto dal lead parte come RICHIAMO, senza data inventata', async () => {
    const { supabase } = makeSupabase(attivo);
    const res = await sendOutcome(supabase, 1, { outcome: 'RICHIAMO', note: 'ci risentiamo a settembre' });

    const body = bodyInviato();
    expect(body.outcome).toBe('RICHIAMO');
    expect(body.periodo).toBe('a settembre');
    expect(body.date).toBeUndefined();
    expect(res.sent).toBe(true);
  });

  it("senza un'espressione di tempo resta una NOTA: non si deduce un periodo", async () => {
    const { supabase } = makeSupabase(attivo);
    const res = await sendOutcome(supabase, 1, { outcome: 'RICHIAMO', note: 'ora non posso parlare' });

    const body = bodyInviato();
    expect(body.outcome).toBe('NOTA');
    expect(body.date).toBeUndefined();
    expect(body.periodo).toBeUndefined();
    expect(body.note).toContain('"ora non posso parlare"');
    expect(res.sent).toBe(true);
    expect(res.keepOpen).toBe(true);
  });

  it('una data nel passato non arriva mai al CRM (caso conv 3369)', async () => {
    const { supabase } = makeSupabase(attivo);
    await sendOutcome(supabase, 1, { outcome: 'RICHIAMO', date: '2026-01-27T09:00:00+01:00' });
    const body = bodyInviato();
    expect(body.outcome).toBe('NOTA');
    expect(JSON.stringify(body)).not.toContain('2026-01-27');
  });

  it('una data sbagliata non parte nemmeno quando il periodo la sostituisce', async () => {
    const { supabase } = makeSupabase(attivo);
    await sendOutcome(supabase, 1, {
      outcome: 'RICHIAMO',
      date: '2026-01-27T09:00:00+01:00',
      note: 'mi richiami la settimana prossima',
    });
    const body = bodyInviato();
    expect(body.outcome).toBe('RICHIAMO');
    expect(body.periodo).toBe('la settimana prossima');
    expect(JSON.stringify(body)).not.toContain('2026-01-27');
  });

  it('una data a due anni non arriva mai al CRM', async () => {
    const { supabase } = makeSupabase(attivo);
    const fra2anni = new Date(Date.now() + 730 * 86400_000).toISOString();
    await sendOutcome(supabase, 1, { outcome: 'RICHIAMO', date: fra2anni });
    expect(bodyInviato().outcome).toBe('NOTA');
  });

  it('non tocca bot_outcome né ai_status: la conversazione resta lavorabile', async () => {
    const { supabase, calls } = makeSupabase(attivo);
    await sendOutcome(supabase, 1, { outcome: 'RICHIAMO', note: 'più avanti' });
    for (const u of calls.updates) {
      expect(u).not.toHaveProperty('bot_outcome');
      expect(u).not.toHaveProperty('ai_status');
    }
  });

  it('una data valida detta dal lead passa intatta come RICHIAMO', async () => {
    const { supabase } = makeSupabase(attivo);
    const fra7giorni = new Date(Date.now() + 7 * 86400_000).toISOString();
    const res = await sendOutcome(supabase, 1, { outcome: 'RICHIAMO', date: fra7giorni });
    const body = bodyInviato();
    expect(body.outcome).toBe('RICHIAMO');
    expect(body.date).toBe(fra7giorni);
    expect(res.keepOpen).toBeUndefined();
  });

  it('registra l\'evento con la data scartata, per poterla ritrovare', async () => {
    const { supabase, calls } = makeSupabase(attivo);
    await sendOutcome(supabase, 1, { outcome: 'RICHIAMO', date: '2026-01-27T09:00:00+01:00' });
    const ev = calls.events.find((e: { type: string }) => e.type === 'richiamo_senza_data');
    expect(ev).toBeTruthy();
    expect(ev.payload.dataScartata).toBe('2026-01-27T09:00:00+01:00');
    expect(ev.payload.motivo).toBe('passato');
  });
});

describe('sendCrmNota — una nota diretta, fuori dalla logica degli esiti', () => {
  it('manda una NOTA anche su un lead già APPUNTAMENTO, senza toccare nulla', async () => {
    // Passando da sendOutcome, resolveOutcomeAction la trasformerebbe in una nota
    // "appuntamento mantenuto": il fatto che il bot abbia ripreso la chat sparirebbe.
    const { supabase, calls } = makeSupabase({ crm_lead_id: 'crm1', bot_outcome: 'APPUNTAMENTO', bot_scheduled_at: DATE });
    const r = await sendCrmNota(supabase, 1, 'IL BOT HA RIPRESO LA CHAT — ...');

    expect(r.sent).toBe(true);
    const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
    expect(body.outcome).toBe('NOTA');
    expect(body.note).toContain('IL BOT HA RIPRESO');
    expect(calls.updates).toHaveLength(0);
  });

  it('lead non CRM: nessuna chiamata', async () => {
    const { supabase } = makeSupabase({ crm_lead_id: null, bot_outcome: null, bot_scheduled_at: null });
    const r = await sendCrmNota(supabase, 1, 'qualcosa');
    expect(r).toEqual({ sent: false, error: 'not_crm_lead' });
    expect((globalThis.fetch as any).mock.calls).toHaveLength(0);
  });
});

// Il CRM ha aperto CONTATTO_UMANO il 05/08: è una segnalazione, non un esito. Non
// cambia stato, non riassegna, non tocca l'appuntamento. Prima, il tag
// [PASSAGGIO_UMANO] impostava solo ai_status='handed_off' in locale e la richiesta del
// lead non usciva mai dal nostro database.
describe('sendOutcome — CONTATTO_UMANO', () => {
  const CONV_UMANO = { crm_lead_id: 'crm1', bot_outcome: null, bot_scheduled_at: null };

  it('fa il POST e non tocca nessuno stato locale', async () => {
    const { supabase, calls } = makeSupabase(CONV_UMANO);
    const res = await sendOutcome(supabase, 1, { outcome: 'CONTATTO_UMANO', note: 'voglio parlare con una persona' });

    expect(res.sent).toBe(true);
    const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
    expect(body.outcome).toBe('CONTATTO_UMANO');
    expect(body.date).toBeUndefined();
    expect(body.note).toContain('voglio parlare con una persona');
    expect(calls.updates).toHaveLength(0);
    expect(calls.events.some((e: { type: string }) => e.type === 'bot_contatto_umano_inviato')).toBe(true);
  });

  it('su un lead già APPUNTAMENTO parte lo stesso come CONTATTO_UMANO, non come NOTA', async () => {
    // Passando da resolveOutcomeAction il ramo locked lo tradurrebbe in una nota
    // generica "appuntamento mantenuto": la richiesta si perderebbe un'altra volta.
    const { supabase, calls } = makeSupabase({ crm_lead_id: 'crm1', bot_outcome: 'APPUNTAMENTO', bot_scheduled_at: DATE });
    const res = await sendOutcome(supabase, 1, { outcome: 'CONTATTO_UMANO', note: 'passatemi un responsabile' });

    expect(res.sent).toBe(true);
    const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
    expect(body.outcome).toBe('CONTATTO_UMANO');
    expect(body.note).toContain('passatemi un responsabile');
    expect(calls.updates).toHaveLength(0);
  });

  it('notifySuppressed non è un errore e non si ritenta', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200, text: async () => JSON.stringify({ ok: true, notifySuppressed: true }),
    })));
    const { supabase, calls } = makeSupabase(CONV_UMANO);
    const res = await sendOutcome(supabase, 1, { outcome: 'CONTATTO_UMANO', note: 'ancora io' });

    expect(res.sent).toBe(true);
    expect(res.notifySuppressed).toBe(true);
    expect((globalThis.fetch as any).mock.calls).toHaveLength(1);
    expect(calls.events.some((e: { type: string; level: string }) =>
      e.type === 'bot_contatto_umano_soppresso' && e.level === 'info')).toBe(true);
  });

  it('senza le parole del lead la segnalazione parte lo stesso, mai con una nota vuota', async () => {
    // La nota è obbligatoria per il CRM (senza → 400). Il fallback esiste perché il
    // segnale non vada perso quando l'ultimo turno del lead è vuoto (una nota vocale
    // non trascritta, un media senza didascalia): meglio una richiesta senza citazione
    // che nessuna richiesta.
    const { supabase } = makeSupabase(CONV_UMANO);
    const res = await sendOutcome(supabase, 1, { outcome: 'CONTATTO_UMANO', note: '   ' });

    expect(res.sent).toBe(true);
    const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
    expect(body.note.trim().length).toBeGreaterThan(0);
    expect(body.note).not.toContain('""');
  });

  it('un CRM che risponde male lascia la traccia e non persiste niente', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, text: async () => 'boom' })));
    const { supabase, calls } = makeSupabase(CONV_UMANO);
    const res = await sendOutcome(supabase, 1, { outcome: 'CONTATTO_UMANO', note: 'voglio una persona' });

    expect(res.sent).toBe(false);
    expect(res.status).toBe(500);
    expect(calls.updates).toHaveLength(0);
    expect(calls.events.some((e: { type: string; level: string }) =>
      e.type === 'bot_outcome_error' && e.level === 'error')).toBe(true);
  });

  it('una risposta non JSON vale come notifica passata', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, text: async () => 'OK' })));
    const { supabase, calls } = makeSupabase(CONV_UMANO);
    const res = await sendOutcome(supabase, 1, { outcome: 'CONTATTO_UMANO', note: 'voglio una persona' });

    expect(res.sent).toBe(true);
    expect(res.notifySuppressed).toBeUndefined();
    expect(calls.events.some((e: { type: string }) => e.type === 'bot_contatto_umano_inviato')).toBe(true);
  });

  // Il CRM instrada 13 segnalazioni su 66 alla coda sbagliata (GDO invece delle
  // Conferme) perché non sa che il lead ha già un appuntamento fissato: senza questo
  // campo non può capire che la richiesta è di competenza di chi conferma, non di chi
  // fissa.
  it('con un appuntamento già fissato, la data viaggia in info.appuntamento', async () => {
    const CONV_CON_APPUNTAMENTO = { crm_lead_id: 'crm1', bot_outcome: 'APPUNTAMENTO', bot_scheduled_at: DATE };
    const { supabase } = makeSupabase(CONV_CON_APPUNTAMENTO);
    const res = await sendOutcome(supabase, 1, { outcome: 'CONTATTO_UMANO', note: 'aspetto la call' });

    expect(res.sent).toBe(true);
    const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
    expect(body.info.appuntamento).toBe(DATE);
  });

  /** Il corpo del POST al CRM, senza `any`: e' l'unica cosa che questi test guardano. */
  const corpoFetch = () => {
    const fetchFinto = globalThis.fetch as unknown as { mock: { calls: [string, { body: string }][] } };
    return JSON.parse(fetchFinto.mock.calls[0][1].body) as { info: Record<string, string | undefined> };
  };

  // `bot_scheduled_at` la valorizza il ramo normale per QUALSIASI esito con una data,
  // RICHIAMO compreso: senza la condizione sull'esito, un lead con un richiamo arriva
  // al CRM marcato "gia' fissato + data" e finisce alle Conferme per un appuntamento
  // che non esiste.
  it('un RICHIAMO con una data non e un appuntamento: il campo non parte', async () => {
    const CONV_RICHIAMO = { crm_lead_id: 'crm1', bot_outcome: 'RICHIAMO', bot_scheduled_at: DATE };
    const { supabase } = makeSupabase(CONV_RICHIAMO);
    const res = await sendOutcome(supabase, 1, { outcome: 'CONTATTO_UMANO', note: 'voglio una persona' });

    expect(res.sent).toBe(true);
    expect(corpoFetch().info?.appuntamento).toBeUndefined();
  });

  // I lead "postino" hanno l'appuntamento su `gdo_appuntamento_at` e niente su
  // `bot_scheduled_at`: uscivano senza data, e il CRM li instradava al GDO invece che
  // alle Conferme — esattamente il caso che questo campo esiste per chiudere.
  it('appuntamento preso da un GDO: la data viaggia lo stesso', async () => {
    const CONV_GDO_APP = { crm_lead_id: 'gdo1', bot_outcome: null, bot_scheduled_at: null, gdo_appuntamento_at: DATE };
    const { supabase } = makeSupabase(CONV_GDO_APP);
    const res = await sendOutcome(supabase, 1, { outcome: 'CONTATTO_UMANO', note: 'aspetto la call' });

    expect(res.sent).toBe(true);
    expect(corpoFetch().info.appuntamento).toBe(DATE);
  });

  it('senza un appuntamento fissato, il campo non compare affatto (niente null, niente stringa vuota)', async () => {
    const { supabase } = makeSupabase(CONV_UMANO);
    const res = await sendOutcome(supabase, 1, { outcome: 'CONTATTO_UMANO', note: 'voglio parlare con una persona' });

    expect(res.sent).toBe(true);
    const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
    // `info` può anche non esserci del tutto (nessun altro fatto noto): quello che
    // conta è che `appuntamento` non ci sia mai come null o stringa vuota.
    expect(body.info?.appuntamento).toBeUndefined();
  });
});

describe('sendOutcome — canale solo-NOTA per i lead dei GDO (noteOnly)', () => {
  // Lead di proprietà del GDO: nessun esito nostro, nessun appuntamento nostro.
  const CONV_GDO = { crm_lead_id: 'gdo1', bot_outcome: null, bot_scheduled_at: null };

  it('manda NOTA al posto dell\'esito e non tocca la riga', async () => {
    const { supabase, calls } = makeSupabase(CONV_GDO);
    const res = await sendOutcome(supabase, 7, { outcome: 'DA_SCARTARE', discardReason: 'non gli serve più' }, { noteOnly: true });

    expect(res.sent).toBe(true);
    const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
    expect(body.outcome).toBe('NOTA');
    expect(body.leadId).toBe('gdo1');
    expect(body.note).toContain('non gli serve più');
    expect(body.date).toBeUndefined();
    // Niente bot_outcome, niente ai_status: il lead non è nostro e la chat continua.
    // DA_SCARTARE è però una richiesta di disdetta: l'unico update ammesso è il
    // marcatore che spegne gli automatismi.
    for (const u of calls.updates) {
      expect(u).not.toHaveProperty('bot_outcome');
      expect(u).not.toHaveProperty('ai_status');
    }
    expect(calls.updates).toEqual([{ cancel_requested_at: expect.any(String) }]);
  });

  it('un APPUNTAMENTO del modello non diventa mai un esito: resta una nota', async () => {
    const { supabase, calls } = makeSupabase(CONV_GDO);
    const res = await sendOutcome(supabase, 7, { outcome: 'APPUNTAMENTO', date: DATE }, { noteOnly: true });

    expect(res.sent).toBe(true);
    const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
    expect(body.outcome).toBe('NOTA');
    expect(body.outcome).not.toBe('APPUNTAMENTO');
    expect(calls.updates).toHaveLength(0);
    expect(calls.events.some((e) => e.type === 'bot_note_sent')).toBe(true);
  });

  it('lead senza crm_lead_id → nessun POST', async () => {
    const { supabase } = makeSupabase({ crm_lead_id: null, bot_outcome: null, bot_scheduled_at: null });
    const res = await sendOutcome(supabase, 7, { outcome: 'INTERROTTO' }, { noteOnly: true });

    expect(res).toEqual({ sent: false, error: 'not_crm_lead' });
    expect((globalThis.fetch as any)).not.toHaveBeenCalled();
  });

  it('nota identica già inviata → non rimandata, e la conversazione resta aperta', async () => {
    const { supabase: s1, calls: c1 } = makeSupabase(CONV_GDO);
    await sendOutcome(s1, 7, { outcome: 'INTERROTTO' }, { noteOnly: true });
    const precedente = { id: 1, ...c1.events.find((e: { type: string }) => e.type === 'bot_note_sent') };
    (globalThis.fetch as any).mockClear();

    const { supabase, calls } = makeSupabase(CONV_GDO, { eventLogRows: [precedente] });
    const res = await sendOutcome(supabase, 7, { outcome: 'INTERROTTO' }, { noteOnly: true });

    expect(res).toEqual({ sent: false, error: 'note_duplicate' });
    expect((globalThis.fetch as any)).not.toHaveBeenCalled();
    expect(calls.updates).toHaveLength(0);
  });

  it('CRM che rifiuta (403) → nessuna persistenza locale, solo la traccia', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 403, text: async () => 'lead non assegnato al bot' })));
    const { supabase, calls } = makeSupabase(CONV_GDO);
    const res = await sendOutcome(supabase, 7, { outcome: 'RICHIAMO', date: DATE }, { noteOnly: true });

    expect(res.sent).toBe(false);
    // RICHIAMO è una richiesta di disdetta (spostamento): il marcatore va comunque
    // scritto, indipendentemente dall'esito della POST al CRM.
    expect(calls.updates).toEqual([{ cancel_requested_at: expect.any(String) }]);
    expect(calls.events.some((e) => e.type === 'bot_outcome_rejected')).toBe(true);
  });
});

describe('sendOutcome — cancel_requested_at', () => {
  const fissato = { crm_lead_id: 'crm1', bot_outcome: 'APPUNTAMENTO', bot_scheduled_at: DATE };
  const marcature = (calls: ReturnType<typeof makeSupabase>['calls']) =>
    calls.updates.filter((u) => 'cancel_requested_at' in u);

  it('un SCARTO su appuntamento fissato marca la disdetta senza declassare', async () => {
    const { supabase, calls } = makeSupabase(fissato);
    await sendOutcome(supabase, 1, { outcome: 'DA_SCARTARE', discardReason: 'non ce la faccio piu' });

    expect(marcature(calls)).toHaveLength(1);
    expect(typeof marcature(calls)[0].cancel_requested_at).toBe('string');
    for (const u of calls.updates) expect(u.bot_outcome).toBeUndefined();
    expect(calls.events.some((e) => e.type === 'cancel_requested')).toBe(true);
  });

  it('un RICHIAMO su appuntamento fissato marca la disdetta', async () => {
    const { supabase, calls } = makeSupabase(fissato);
    await sendOutcome(supabase, 1, { outcome: 'RICHIAMO', note: 'la prossima settimana' });
    expect(marcature(calls)).toHaveLength(1);
  });

  it('un INTERROTTO NON è una disdetta: il lead non ha chiesto niente', async () => {
    const { supabase, calls } = makeSupabase(fissato);
    await sendOutcome(supabase, 1, { outcome: 'INTERROTTO' });
    expect(marcature(calls)).toHaveLength(0);
  });

  it('su una conversazione senza appuntamento non si marca niente', async () => {
    const { supabase, calls } = makeSupabase({ crm_lead_id: 'crm1', bot_outcome: null, bot_scheduled_at: null });
    await sendOutcome(supabase, 1, { outcome: 'DA_SCARTARE', discardReason: 'non mi interessa' });
    expect(marcature(calls)).toHaveLength(0);
  });

  it('anche quando la nota è un duplicato, la disdetta resta marcata', async () => {
    const args = { outcome: 'DA_SCARTARE' as const, discardReason: 'non ce la faccio piu' };
    const precedente = await eventoLockedGiaScritto(fissato, 1, args);
    const { supabase, calls } = makeSupabase(fissato, { eventLogRows: [precedente] });

    const res = await sendOutcome(supabase, 1, args);

    expect(res.error).toBe('note_duplicate');
    expect(marcature(calls)).toHaveLength(1);
  });

  it('un lead del GDO che disdice marca la disdetta (canale solo-nota)', async () => {
    const { supabase, calls } = makeSupabase({ crm_lead_id: 'gdo1', bot_outcome: null, bot_scheduled_at: null });
    await sendOutcome(supabase, 1, { outcome: 'DA_SCARTARE', discardReason: 'annullo tutto' }, { noteOnly: true });
    expect(marcature(calls)).toHaveLength(1);
  });
});

// Guardia sulla data dell'APPUNTAMENTO. Le regole su giorni e orari stavano solo nel
// prompt: reggevano finché era il bot a proporre il giorno, e cadevano appena era il
// lead a proporlo. Una call in un giorno chiuso o a mezzanotte arriva alle Conferme e
// al venditore come se fosse vera.
describe('sendOutcome — APPUNTAMENTO in un giorno o a un\'ora impossibili', () => {
  const attivo = { crm_lead_id: 'crm1', bot_outcome: null, bot_scheduled_at: null };
  const bodyInviato = () => JSON.parse(vi.mocked(globalThis.fetch).mock.calls[0][1]!.body as string);

  it('un appuntamento normale passa intatto: la guardia non tocca il caso buono', async () => {
    const { supabase, calls } = makeSupabase(attivo);
    const quando = giornoUtile(15);
    const res = await sendOutcome(supabase, 1, { outcome: 'APPUNTAMENTO', date: quando });

    expect(bodyInviato().outcome).toBe('APPUNTAMENTO');
    expect(res.keepOpen).toBeUndefined();
    expect(calls.events.some((e: { type: string }) => e.type === 'appuntamento_non_fissabile')).toBe(false);
  });

  it('un\'ora fuori fascia diventa una nota e la chat resta aperta', async () => {
    const { supabase } = makeSupabase(attivo);
    const res = await sendOutcome(supabase, 1, { outcome: 'APPUNTAMENTO', date: giornoUtile(2) });

    const body = bodyInviato();
    expect(body.outcome).toBe('NOTA');
    expect(body.note).toContain('APPUNTAMENTO NON FISSATO');
    expect(res.keepOpen).toBe(true);
  });

  it('una domenica non diventa mai un appuntamento', async () => {
    const { supabase } = makeSupabase(attivo);
    // Cerca la prossima domenica futura, all'ora buona.
    const d = new Date(Date.now() + 86_400_000);
    while (d.getUTCDay() !== 0) d.setUTCDate(d.getUTCDate() + 1);
    const key = new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(d);
    await sendOutcome(supabase, 1, { outcome: 'APPUNTAMENTO', date: `${key}T15:00:00${romeOffset(d)}` });

    expect(bodyInviato().outcome).toBe('NOTA');
  });

  it('la data scartata non arriva mai al CRM come data', async () => {
    const { supabase } = makeSupabase(attivo);
    const quando = giornoUtile(2);
    await sendOutcome(supabase, 1, { outcome: 'APPUNTAMENTO', date: quando });

    const body = bodyInviato();
    expect(body.date).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain(quando);
  });

  it('non scrive bot_scheduled_at: in agenda non deve finire niente', async () => {
    const { supabase, calls } = makeSupabase(attivo);
    await sendOutcome(supabase, 1, { outcome: 'APPUNTAMENTO', date: giornoUtile(2) });

    for (const u of calls.updates) {
      expect(u).not.toHaveProperty('bot_scheduled_at');
      expect(u).not.toHaveProperty('bot_outcome');
    }
  });

  it('registra l\'evento con la data scartata e il motivo, per poterla ritrovare', async () => {
    const { supabase, calls } = makeSupabase(attivo);
    const quando = giornoUtile(2);
    await sendOutcome(supabase, 1, { outcome: 'APPUNTAMENTO', date: quando });

    const ev = calls.events.find((e: { type: string }) => e.type === 'appuntamento_non_fissabile');
    expect(ev).toBeDefined();
    expect(ev.payload.dataScartata).toBe(quando);
    expect(ev.payload.motivo).toBe('fuori_fascia');
    expect(ev.level).toBe('warn');
  });

  // Da v1.5 un lead gia' fissato puo' essere SPOSTATO, e quindi la guardia deve
  // valere anche li': spostare una call alle 02:00 e' sbagliato quanto fissarcela.
  it('anche uno spostamento passa dalla guardia: le 02:00 non diventano un appuntamento', async () => {
    const giaFissato = { crm_lead_id: 'crm1', bot_outcome: 'APPUNTAMENTO', bot_scheduled_at: DATE };
    const { supabase, calls } = makeSupabase(giaFissato);
    await sendOutcome(supabase, 1, { outcome: 'APPUNTAMENTO', date: giornoUtile(2) });

    expect(bodyInviato().outcome).toBe('NOTA');
    expect(bodyInviato().note).toContain('APPUNTAMENTO NON FISSATO');
    expect(calls.events.some((e: { type: string }) => e.type === 'appuntamento_non_fissabile')).toBe(true);
    // E l'appuntamento in agenda non si muove.
    for (const u of calls.updates) expect(u).not.toHaveProperty('bot_scheduled_at');
  });
});

// Contratto v1.5: il lead gia' fissato che chiede di spostare non finisce piu' in un
// vicolo cieco. Il CRM registra la data nuova e avvisa le Conferme.
describe('sendOutcome — rifissaggio di un appuntamento (v1.5)', () => {
  const domani = new Date(Date.now() + 30 * 3600_000).toISOString();
  const fissato = { crm_lead_id: 'crm1', bot_outcome: 'APPUNTAMENTO', bot_scheduled_at: domani };
  const bodyInviato = () => JSON.parse(vi.mocked(globalThis.fetch).mock.calls[0][1]!.body as string);
  // Un mercoledi' alle 15 dentro la fascia 09-21, lontano da domeniche e chiusure.
  const nuovaData = () => {
    const d = new Date(Date.now() + 5 * 24 * 3600_000);
    while (d.getUTCDay() === 0) d.setUTCDate(d.getUTCDate() + 1);
    d.setUTCHours(13, 0, 0, 0);
    return d.toISOString();
  };

  it('la data nuova parte come APPUNTAMENTO, non come nota', async () => {
    const { supabase } = makeSupabase(fissato);
    const res = await sendOutcome(supabase, 1, { outcome: 'APPUNTAMENTO', date: nuovaData() });
    const body = bodyInviato();
    expect(body.outcome).toBe('APPUNTAMENTO');
    expect(body.date).toBe(nuovaData());
    expect(res.sent).toBe(true);
  });

  it('aggiorna la data ma non ricconta il fissaggio', async () => {
    const { supabase, calls } = makeSupabase(fissato);
    await sendOutcome(supabase, 1, { outcome: 'APPUNTAMENTO', date: nuovaData() });
    const agg = calls.updates.find((u: any) => 'bot_scheduled_at' in u);
    expect(agg.bot_scheduled_at).toBe(nuovaData());
    // Se `bot_outcome_at` si aggiornasse, un lead spostato tre volte comparirebbe tre
    // volte fra gli appuntamenti presi oggi.
    for (const u of calls.updates) expect(u).not.toHaveProperty('bot_outcome_at');
  });

  it('riaccende i promemoria: l\'appuntamento e\' di nuovo vivo', async () => {
    const { supabase, calls } = makeSupabase(fissato);
    await sendOutcome(supabase, 1, { outcome: 'APPUNTAMENTO', date: nuovaData() });
    const agg = calls.updates.find((u: any) => 'cancel_requested_at' in u);
    expect(agg.cancel_requested_at).toBeNull();
  });

  it('uno spostamento di domenica non passa, come un primo fissaggio', async () => {
    const { supabase } = makeSupabase(fissato);
    const domenica = new Date(Date.now() + 3 * 24 * 3600_000);
    while (domenica.getUTCDay() !== 0) domenica.setUTCDate(domenica.getUTCDate() + 1);
    domenica.setUTCHours(13, 0, 0, 0);
    await sendOutcome(supabase, 1, { outcome: 'APPUNTAMENTO', date: domenica.toISOString() });
    expect(bodyInviato().outcome).toBe('NOTA');
  });

  it('la stessa data resta una riconferma e non rimbalza al CRM come nuovo fissaggio', async () => {
    const { supabase } = makeSupabase(fissato);
    await sendOutcome(supabase, 1, { outcome: 'APPUNTAMENTO', date: domani });
    expect(bodyInviato().outcome).toBe('NOTA');
  });
});
