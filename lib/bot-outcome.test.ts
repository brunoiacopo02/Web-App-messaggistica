import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sendOutcome } from './bot-outcome';

const DATE = '2026-06-29T17:00:00Z';

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
    expect(calls.updates).toEqual([{ ai_status: 'closed' }]);
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
    const res = await sendOutcome(supabase, 1, { outcome: 'APPUNTAMENTO', date: DATE });

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
    expect(calls.updates).toEqual([{ ai_status: 'closed' }]);
    expect(calls.events.some((e) => e.type === 'bot_outcome_rejected')).toBe(true);
  });
});

describe('sendOutcome — RICHIAMO interim', () => {
  it('interim su lead in lavorazione → POST inviato, nessuna persistenza locale', async () => {
    const { supabase, calls } = makeSupabase({ crm_lead_id: 'crm1', bot_outcome: null, bot_scheduled_at: null });
    const res = await sendOutcome(supabase, 1, { outcome: 'RICHIAMO', date: '2026-08-07T09:00:00+02:00', note: 'seq' }, { interim: true });

    expect(res.sent).toBe(true);
    const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
    expect(body.outcome).toBe('RICHIAMO');
    expect(calls.updates).toHaveLength(0);  // conversazione resta aperta
    expect(calls.events.some((e) => e.type === 'bot_outcome_sent' && e.payload.interim === true)).toBe(true);
  });

  it('interim su lead già APPUNTAMENTO → nessun POST (mai riportare indietro lo stato)', async () => {
    const { supabase, calls } = makeSupabase({ crm_lead_id: 'crm1', bot_outcome: 'APPUNTAMENTO', bot_scheduled_at: DATE });
    const res = await sendOutcome(supabase, 1, { outcome: 'RICHIAMO', date: '2026-08-07T09:00:00+02:00' }, { interim: true });

    expect(res.sent).toBe(false);
    expect(res.error).toBe('interim_skipped_locked');
    expect((globalThis.fetch as any).mock.calls).toHaveLength(0);
    expect(calls.updates).toHaveLength(0);
  });

  it('interim con CRM 403 → nessuna persistenza (RICHIAMO non è un esito nostro)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 403, text: async () => 'no' })));
    const { supabase, calls } = makeSupabase({ crm_lead_id: 'crm1', bot_outcome: null, bot_scheduled_at: null });
    const res = await sendOutcome(supabase, 1, { outcome: 'RICHIAMO', date: '2026-08-07T09:00:00+02:00' }, { interim: true });

    expect(res.sent).toBe(false);
    expect(calls.updates).toHaveLength(0);
    expect(calls.events.some((e) => e.type === 'bot_outcome_rejected')).toBe(true);
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
    expect(calls.updates).toEqual([{ ai_status: 'closed' }]);
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
    expect(calls.updates).toHaveLength(0);
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
    expect(calls.updates).toHaveLength(0);
    expect(calls.events.some((e) => e.type === 'bot_outcome_rejected')).toBe(true);
  });
});
