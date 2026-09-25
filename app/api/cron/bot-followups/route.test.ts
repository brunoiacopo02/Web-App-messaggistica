import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Il ramo `interrotto_classify` del cron, isolato: il resto del giro (re-drive,
// watchdog, sequenza) e' spento dai mock qui sotto. Si guarda solo cosa parte verso il
// CRM e cosa si scrive su `event_log`.

type Filtro = { m: string; args: unknown[] };
type Chiamata = { table: string; op: 'select' | 'insert' | 'update'; arg: unknown; filtri: Filtro[] };
const chiamate: Chiamata[] = [];
type ConvFinta = {
  id: number; ai_status: string; crm_lead_id: string | null; bot_outcome: string | null;
  bot_followups_sent: number; gdo_agenda_at: string | null; lancio_slug: string | null; lancio_fase: string | null;
  ai_started_at: string | null; leads: { phone_e164: string | null } | null;
};
type Riga = { direction: string; body: string | null; created_at: string; twilio_status: string | null; template_sid: string | null };
type Evento = { type: string; payload: Record<string, unknown>; created_at: string };
const stato = {
  convs: [] as ConvFinta[],
  messaggi: [] as Riga[],
  eventi: [] as Evento[],
};

function esegui(rec: Chiamata): { data: unknown; error: unknown } {
  if (rec.op !== 'select') return { data: null, error: null };
  if (rec.table === 'conversations') return { data: stato.convs, error: null };
  if (rec.table === 'messages') return { data: stato.messaggi, error: null };
  if (rec.table === 'event_log') {
    const tipo = rec.filtri.find((f) => f.m === 'eq' && f.args[0] === 'type')?.args[1];
    const contiene = rec.filtri.find((f) => f.m === 'contains')?.args[1] as Record<string, unknown> | undefined;
    let out = stato.eventi.filter((e) => e.type === tipo);
    if (contiene) out = out.filter((e) => Object.entries(contiene).every(([k, v]) => e.payload[k] === v));
    const ordine = rec.filtri.find((f) => f.m === 'order');
    if (ordine && (ordine.args[1] as { ascending?: boolean } | undefined)?.ascending === false) {
      out = [...out].sort((a, b) => b.created_at.localeCompare(a.created_at));
    }
    const limite = rec.filtri.find((f) => f.m === 'limit')?.args[0] as number | undefined;
    return { data: limite ? out.slice(0, limite) : out, error: null };
  }
  return { data: [], error: null };
}
function query(table: string, op: Chiamata['op'], a: unknown) {
  const rec: Chiamata = { table, op, arg: a, filtri: [] };
  chiamate.push(rec);
  const q: Record<string, unknown> = {};
  for (const m of ['eq', 'is', 'in', 'not', 'gte', 'lt', 'order', 'limit', 'range', 'select', 'contains']) {
    q[m] = (...args: unknown[]) => { rec.filtri.push({ m, args }); return q; };
  }
  q.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve().then(() => esegui(rec)).then(ok, ko);
  return q;
}
vi.mock('@/lib/supabase/admin', () => ({
  getSupabaseAdmin: () => ({
    from: (table: string) => ({
      select: (s: string) => query(table, 'select', s),
      insert: (r: unknown) => query(table, 'insert', r),
      update: (r: unknown) => query(table, 'update', r),
    }),
  }),
}));

type EsitoOutcome = { sent: boolean; status?: number; error?: string };
const sendOutcome = vi.fn<(...a: unknown[]) => Promise<EsitoOutcome>>(async () => ({ sent: true, status: 200 }));
vi.mock('@/lib/bot-outcome', () => ({ sendOutcome: (...a: unknown[]) => sendOutcome(...a) }));

type Verdetto = { discard: boolean; discardReason?: string; note: string; confermato: boolean };
const NOTA_CLASSIFICATORE = 'Interrotta dopo il prezzo. Ultima frase del lead: "ok"';
const classifyInterrupted = vi.fn<(...a: unknown[]) => Promise<Verdetto>>(async () => ({
  discard: false, note: NOTA_CLASSIFICATORE, confermato: false,
}));
vi.mock('@/lib/interrotto-note', () => ({ classifyInterrupted: (...a: unknown[]) => classifyInterrupted(...a) }));

// L'azione decisa si cambia per test; `esitoMaiConsegnato` resta quello vero.
const azione = { valore: 'interrotto_classify' as string };
vi.mock('@/lib/bot-followups', async (importOriginal) => ({
  esitoMaiConsegnato: (await importOriginal<typeof import('@/lib/bot-followups')>()).esitoMaiConsegnato,
  decideFollowupAction: () => azione.valore,
  serveCronologia: () => true,
  ultimaAttivitaMs: () => 0,
}));
vi.mock('@/lib/fenice-autoreply', () => ({
  drainMarioReplies: vi.fn(),
  lastIsUnansweredInbound: () => false,
  isOrphanedReplyingLock: () => false,
  isLockStale: () => false,
  LOCK_TTL_MS: 600_000,
  serveRedrive: () => false,
}));
vi.mock('@/lib/agenda-followup', () => ({ runAgendaFollowups: vi.fn(async () => ({ sent: 0, skipped: 0 })) }));

import { GET } from './route';

const SEGRETO = 's';
const richiesta = () =>
  GET({ headers: new Headers({ authorization: `Bearer ${SEGRETO}` }), nextUrl: new URL('https://x/api/cron/bot-followups') } as never);
const conv = (extra: Partial<ConvFinta> = {}): ConvFinta => ({
  id: 7, ai_status: 'active', crm_lead_id: 'crm-7', bot_outcome: null, bot_followups_sent: 1,
  gdo_agenda_at: null, lancio_slug: null, lancio_fase: null, ai_started_at: null,
  leads: { phone_e164: '+393330000007' }, ...extra,
});
const out = (body: string, created_at: string): Riga => ({ direction: 'out', body, created_at, twilio_status: 'read', template_sid: null });
const inb = (body: string, created_at: string): Riga => ({ direction: 'in', body, created_at, twilio_status: null, template_sid: null });

const CHAT_NORMALE = [
  out('Ciao, sono Mario!', '2026-09-20T10:00:00Z'),
  inb('Sentiamoci fra 2 giorni, ora non posso', '2026-09-20T10:05:00Z'),
  out('Certo, a presto!', '2026-09-20T10:06:00Z'),
];
const CHAT_CON_FORM = [
  out('Dimmi, quando hai cliccato su invia, che nome ti è comparso?', '2026-09-20T10:00:00Z'),
  inb('Noemi', '2026-09-20T10:05:00Z'),
];
const tenutoAperto = (quando: string | null, created_at = '2026-09-20T10:05:30Z', conversationId = 7): Evento => ({
  type: 'richiamo_tenuto_aperto',
  payload: { conversationId, crmLeadId: 'crm-7', date: null, quando },
  created_at,
});

const esitoInviato = (outcome: string) =>
  sendOutcome.mock.calls.find((c) => (c[2] as { outcome: string }).outcome === outcome)?.[2] as
    | { outcome: string; note?: string }
    | undefined;
const righeGuardia = () =>
  chiamate
    .filter((c) => c.table === 'event_log' && c.op === 'insert')
    .map((c) => c.arg as { type: string; payload: Record<string, unknown> })
    .filter((e) => e.type === 'restituzione_bloccata_conferma_form');

beforeEach(() => {
  azione.valore = 'interrotto_classify';
  chiamate.length = 0;
  stato.convs = [conv()];
  stato.messaggi = CHAT_NORMALE;
  stato.eventi = [];
  sendOutcome.mockReset().mockResolvedValue({ sent: true, status: 200 });
  classifyInterrupted.mockClear();
  vi.stubEnv('CRON_SECRET', SEGRETO);
  vi.stubEnv('AGENDA_FOLLOWUP_ENABLED', '');
});
afterEach(() => { vi.unstubAllEnvs(); });

describe('interrotto_classify — il "quando" di un richiamo tenuto aperto arriva al GDO', () => {
  it('senza evento richiamo_tenuto_aperto la nota dell\'INTERROTTO resta quella del classificatore', async () => {
    await richiesta();
    expect(esitoInviato('INTERROTTO')?.note).toBe(NOTA_CLASSIFICATORE);
  });

  it('con un richiamo_tenuto_aperto che porta un "quando", la nota dice quando voleva essere risentito', async () => {
    stato.eventi = [tenutoAperto('tra 2 giorni')];
    await richiesta();
    const nota = esitoInviato('INTERROTTO')?.note ?? '';
    expect(nota).toContain('VOLEVA ESSERE RISENTITO');
    expect(nota).toContain('Voleva essere risentito tra 2 giorni.');
    // La lettura del classificatore resta: dice a che punto si era fermata la chat.
    expect(nota).toContain(NOTA_CLASSIFICATORE);
  });

  it('vince l\'ultimo "quando" detto, non il primo', async () => {
    stato.eventi = [
      tenutoAperto('tra 3 giorni', '2026-09-19T10:00:00Z'),
      tenutoAperto('26/09/2026 alle 10:00', '2026-09-20T10:05:30Z'),
    ];
    await richiesta();
    const nota = esitoInviato('INTERROTTO')?.note ?? '';
    expect(nota).toContain('Voleva essere risentito 26/09/2026 alle 10:00.');
    expect(nota).not.toContain('tra 3 giorni');
  });

  it('un richiamo_tenuto_aperto con quando null lascia la nota com\'era', async () => {
    stato.eventi = [tenutoAperto(null)];
    await richiesta();
    expect(esitoInviato('INTERROTTO')?.note).toBe(NOTA_CLASSIFICATORE);
  });

  it('l\'evento di un\'altra conversazione non conta', async () => {
    stato.eventi = [tenutoAperto('tra 2 giorni', '2026-09-20T10:05:30Z', 99)];
    await richiesta();
    expect(esitoInviato('INTERROTTO')?.note).toBe(NOTA_CLASSIFICATORE);
  });

  it('con la conferma del form non parte MAI un INTERROTTO, nemmeno con un richiamo tenuto aperto', async () => {
    stato.messaggi = CHAT_CON_FORM;
    stato.eventi = [tenutoAperto('tra 2 giorni')];
    await richiesta();
    expect(esitoInviato('INTERROTTO')).toBeUndefined();
    expect(esitoInviato('CONTATTO_UMANO')).toBeTruthy();
  });
});

describe('restituzione_bloccata_conferma_form — la riga dice come è andato l\'invio', () => {
  it('CONTATTO_UMANO arrivato al CRM: esito inviato', async () => {
    stato.messaggi = CHAT_CON_FORM;
    await richiesta();
    const righe = righeGuardia();
    expect(righe).toHaveLength(1);
    expect(righe[0].payload).toMatchObject({ conversationId: 7, crmLeadId: 'crm-7', esito: 'inviato' });
  });

  it('CONTATTO_UMANO rifiutato dal CRM: esito fallito, con l\'errore', async () => {
    stato.messaggi = CHAT_CON_FORM;
    sendOutcome.mockResolvedValue({ sent: false, status: 500, error: 'http_500' });
    await richiesta();
    const righe = righeGuardia();
    expect(righe).toHaveLength(1);
    expect(righe[0].payload).toMatchObject({ esito: 'fallito', errore: 'http_500' });
  });

  it('senza crm_lead_id nessun CONTATTO_UMANO parte: esito senza_lead', async () => {
    stato.messaggi = CHAT_CON_FORM;
    stato.convs = [conv({ crm_lead_id: null })];
    await richiesta();
    expect(sendOutcome).not.toHaveBeenCalled();
    const righe = righeGuardia();
    expect(righe).toHaveLength(1);
    expect(righe[0].payload).toMatchObject({ esito: 'senza_lead' });
  });
});

describe('mai_consegnato — numero senza WhatsApp: torna a un GDO, mai scartato (PO 25/09/2026)', () => {
  const nonConsegnato = (created_at: string): Riga & { twilio_error_code: number } => ({
    direction: 'out', body: 'Ciao, sono Mario!', created_at, twilio_status: 'undelivered', template_sid: null, twilio_error_code: 63024,
  });

  beforeEach(() => {
    azione.valore = 'mai_consegnato';
    stato.messaggi = [nonConsegnato('2026-09-20T10:00:00Z'), nonConsegnato('2026-09-21T10:00:00Z')];
  });

  it('parte NON_RISPOSTO con la nota per il GDO, nessun DA_SCARTARE', async () => {
    await richiesta();
    expect(esitoInviato('DA_SCARTARE')).toBeUndefined();
    const e = esitoInviato('NON_RISPOSTO');
    expect(e?.note).toContain('WhatsApp mai consegnato');
    expect(e?.note).toContain('chiamare a voce');
    expect(e).not.toHaveProperty('discardReason');
    expect(sendOutcome).toHaveBeenCalledTimes(1);
  });

  it('il codice d\'errore Twilio viene letto dai messaggi: senza, la cronologia non direbbe "senza WhatsApp"', async () => {
    await richiesta();
    const sel = chiamate.find((c) => c.table === 'messages' && c.op === 'select');
    expect(String(sel?.arg)).toContain('twilio_error_code');
    expect(esitoInviato('NON_RISPOSTO')?.note).toContain('senza WhatsApp');
  });

  it('non chiama il classificatore a pagamento', async () => {
    await richiesta();
    expect(classifyInterrupted).not.toHaveBeenCalled();
  });
});
