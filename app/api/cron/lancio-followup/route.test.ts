import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─────────────────────────── finto Supabase ───────────────────────────
// Stessa forma del test del cron Zoom: registra ogni chiamata (tabella, operazione,
// payload, filtri) così i test possono interrogare anche quello che NON è stato scritto —
// "il congedato non è nella query", "il timbro è stato liberato", "nessuna conversazione
// letta a lancio spento".
//
// `conversations.lancio_followup_inviato_at` è finto per davvero: l'update con
// `.is(colonna, null)` restituisce righe solo la prima volta. Il lucchetto contro il
// doppio invio è tutto lì.

type Filtro = { m: string; args: unknown[] };
type Chiamata = {
  table: string;
  op: 'select' | 'insert' | 'update' | 'upsert';
  arg: unknown;
  filtri: Filtro[];
  opzioni?: { head?: boolean; count?: string };
  singola?: boolean;
};
const chiamate: Chiamata[] = [];

type Riga = { direction: string; body: string | null; template_sid: string | null; created_at: string; conversation_id: number };
type ConvFinta = {
  id: number;
  crm_lead_id: string | null;
  lancio_fase: string | null;
  lancio_info: Record<string, unknown> | null;
  lancio_benvenuto_at: string | null;
  lancio_followup_inviato_at: string | null;
  last_inbound_at: string | null;
  ai_paused_at: string | null;
  handed_off_at: string | null;
  leads: { phone_e164: string | null; first_name: string | null } | null;
};

const stato = {
  convs: [] as ConvFinta[],
  messaggi: new Map<number, Riga[]>(),
  /** Righe `messages` già a DB col SID del follow-up: la seconda idempotenza. */
  spediti: [] as { conversation_id: number }[],
  settings: {} as Record<string, unknown>,
  /** Chat già timbrate: il claim non le restituisce e la query non le vede. */
  timbrate: new Set<number>(),
  /** Il VALORE del timbro per conv: il rilascio è ancorato a quello di questo run. */
  timbri: new Map<number, string>(),
  /** La select dei candidati fallisce (migrazione non applicata). */
  convSelectError: null as { message: string; code?: string } | null,
  /** La select della seconda idempotenza fallisce: ha un type di evento suo. */
  idempotenzaSelectError: null as { message: string; code?: string } | null,
  /** Chi era già timbrato quando Twilio è stato chiamato: il timbro viene PRIMA. */
  timbrateAllInvio: [] as number[][],
};

const arg = (rec: Chiamata, metodo: string, colonna: string): Filtro | undefined =>
  rec.filtri.find((f) => f.m === metodo && f.args[0] === colonna);
const congedato = (c: ConvFinta) => typeof c.lancio_info?.congedo_at === 'string';

/** Applica alla fixture i filtri che il route ha davvero messo nella query. */
function filtraCandidati(rec: Chiamata): ConvFinta[] {
  let out = stato.convs.filter((c) => !stato.timbrate.has(c.id));
  if (arg(rec, 'is', 'lancio_info->>congedo_at')) out = out.filter((c) => !congedato(c));
  const fasi = arg(rec, 'in', 'lancio_fase')?.args[1] as string[] | undefined;
  if (fasi) out = out.filter((c) => c.lancio_fase !== null && fasi.includes(c.lancio_fase));
  if (arg(rec, 'not', 'last_inbound_at')) out = out.filter((c) => Boolean(c.last_inbound_at));
  if (arg(rec, 'is', 'ai_paused_at')) out = out.filter((c) => c.ai_paused_at === null);
  if (arg(rec, 'is', 'handed_off_at')) out = out.filter((c) => c.handed_off_at === null);
  const solo = rec.filtri.find((f) => f.m === 'eq' && f.args[0] === 'id');
  if (solo) out = out.filter((c) => c.id === solo.args[1]);
  return out;
}

function esegui(rec: Chiamata): { data: unknown; error: unknown; count?: number } {
  if (rec.table === 'conversations' && rec.op === 'update') {
    const campi = rec.arg as Record<string, unknown>;
    const id = Number(rec.filtri.find((f) => f.m === 'eq' && f.args[0] === 'id')?.args[1]);
    // Il merge su `lancio_info` (marcatore dell'ancora ignota) si applica davvero alla
    // fixture: il run successivo deve vederlo, o la fame delle 50 letture non si prova.
    if ('lancio_info' in campi) {
      const c = stato.convs.find((x) => x.id === id);
      if (c) c.lancio_info = campi.lancio_info as Record<string, unknown>;
      return { data: [], error: null };
    }
    if (!('lancio_followup_inviato_at' in campi)) return { data: [], error: null };
    if (campi.lancio_followup_inviato_at === null) {
      // Rilascio ancorato: si libera solo il timbro scritto da questo run.
      const atteso = arg(rec, 'eq', 'lancio_followup_inviato_at')?.args[1];
      if (atteso === undefined || stato.timbri.get(id) === atteso) {
        stato.timbrate.delete(id);
        stato.timbri.delete(id);
      }
      return { data: [], error: null };
    }
    // Claim: `is('lancio_followup_inviato_at', null)` è un compare-and-set.
    if (stato.timbrate.has(id)) return { data: [], error: null };
    stato.timbrate.add(id);
    stato.timbri.set(id, String(campi.lancio_followup_inviato_at));
    return { data: [{ id }], error: null };
  }
  if (rec.op !== 'select') return { data: null, error: null };
  if (rec.table === 'app_settings') {
    return { data: Object.entries(stato.settings).map(([key, value]) => ({ key, value })), error: null };
  }
  if (rec.table === 'conversations') {
    if (stato.convSelectError) return { data: null, error: stato.convSelectError };
    const righe = filtraCandidati(rec);
    // `maybeSingle()` è la rilettura di `lancio_info` prima del merge del marcatore.
    if (rec.singola) return { data: righe[0] ?? null, error: null };
    if (rec.opzioni?.head) return { data: null, error: null, count: righe.length };
    const range = (rec.filtri.find((f) => f.m === 'range')?.args as number[] | undefined) ?? [0, 999];
    return { data: righe.slice(range[0], range[1] + 1), error: null };
  }
  if (rec.table === 'messages') {
    const ids = (arg(rec, 'in', 'conversation_id')?.args[1] as number[] | undefined) ?? [];
    // Con `eq('template_sid', …)` è la seconda idempotenza; senza, la cronologia.
    if (arg(rec, 'eq', 'template_sid')) {
      if (stato.idempotenzaSelectError) return { data: null, error: stato.idempotenzaSelectError };
      return { data: stato.spediti.filter((m) => ids.includes(m.conversation_id)), error: null };
    }
    let righe = ids.flatMap((id) => stato.messaggi.get(id) ?? []).sort((a, b) => a.created_at.localeCompare(b.created_at));
    // Taglio dello storico: la cronologia di Mario prima del lancio non deve arrivare
    // a `decideFollowup`, e il test lo deve vedere per davvero.
    const taglio = arg(rec, 'gte', 'created_at')?.args[1] as string | undefined;
    if (taglio) righe = righe.filter((r) => r.created_at >= taglio);
    // `or('direction.eq.in,template_sid.eq.HX…')`: solo inbound e benvenuto.
    const or = rec.filtri.find((f) => f.m === 'or')?.args[0] as string | undefined;
    if (or) {
      const clausole = or.split(',').map((s) => s.split('.'));
      righe = righe.filter((r) =>
        clausole.some(([col, , val]) => String((r as unknown as Record<string, unknown>)[col] ?? '') === val),
      );
    }
    return { data: righe, error: null };
  }
  return { data: [], error: null };
}

function query(table: string, op: Chiamata['op'], a: unknown, opzioni?: Chiamata['opzioni']) {
  const rec: Chiamata = { table, op, arg: a, filtri: [], opzioni };
  chiamate.push(rec);
  const q: Record<string, unknown> = {};
  for (const m of ['eq', 'is', 'in', 'not', 'or', 'order', 'limit', 'range', 'gte', 'lte', 'select', 'contains']) {
    q[m] = (...args: unknown[]) => {
      rec.filtri.push({ m, args });
      return q;
    };
  }
  q.maybeSingle = () => {
    rec.singola = true;
    return q;
  };
  q.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) =>
    Promise.resolve()
      .then(() => esegui(rec))
      .then(ok, ko);
  return q;
}

vi.mock('@/lib/supabase/admin', () => ({
  getSupabaseAdmin: () => ({
    from: (table: string) => ({
      select: (s: string, opzioni?: Chiamata['opzioni']) => query(table, 'select', s, opzioni),
      insert: (r: unknown) => query(table, 'insert', r),
      update: (r: unknown) => query(table, 'update', r),
      upsert: (r: unknown) => query(table, 'upsert', r),
    }),
  }),
}));

// ─────────────────────────── finto Twilio ───────────────────────────
const sendTemplate = vi.fn();
vi.mock('@/lib/twilio', () => ({
  sendTemplate: (...a: unknown[]) => sendTemplate(...a),
  getTemplateBody: async () => 'Ciao {{1}}, ieri sera alla live...',
}));

// `impostaFaseLancio` ha i suoi test (B1): qui interessa CHE venga chiamata, con quale
// fase e con quale timbro. La fase però la sposta davvero nella fixture, `soloDaFasi`
// compreso: il compare-and-set è esattamente quello che questo test deve vedere.
const impostaFaseLancio = vi.fn<(...a: unknown[]) => Promise<void>>(async (...a) => {
  const c = stato.convs.find((x) => x.id === a[1]);
  if (!c) return;
  const soloDaFasi = (a[4] as { soloDaFasi?: readonly string[] } | undefined)?.soloDaFasi;
  if (soloDaFasi && !soloDaFasi.includes(c.lancio_fase ?? '')) return;
  c.lancio_fase = a[2] as string;
});
const marcaCongedo = vi.fn<(...a: unknown[]) => Promise<void>>(async () => {});
const leggiIngressoLancioAt = vi.fn<(...a: unknown[]) => Promise<string | null>>(async () => null);
vi.mock('@/lib/lancio-db', () => ({
  impostaFaseLancio: (...a: unknown[]) => impostaFaseLancio(...a),
  marcaCongedo: (...a: unknown[]) => marcaCongedo(...a),
  leggiIngressoLancioAt: (...a: unknown[]) => leggiIngressoLancioAt(...a),
}));
const congedoLancio = vi.fn<(...a: unknown[]) => Promise<'active' | 'closed' | 'handed_off'>>(async () => 'closed');
vi.mock('@/lib/lancio-effetti', () => ({ congedoLancio: (...a: unknown[]) => congedoLancio(...a) }));

import { GET } from './route';

const SEGRETO = 'segreto-di-test';
const SID = 'HXfollowup';
const WELCOME = 'HXwelcome';
const EVENTO = '2026-10-05T21:00:00+02:00';
/** 12:10 di Roma del 6/10: dentro la prima fascia. */
const DENTRO = '2026-10-06T12:10:00+02:00';
const FUORI = '2026-10-06T16:00:00+02:00';
const CHIUSA = '2026-10-07T20:00:00+02:00';
const ANCORA = '2026-09-20T10:00:00Z';

const richiesta = (extra = '', secret: string | null = SEGRETO) =>
  GET({
    headers: new Headers(secret ? { authorization: `Bearer ${secret}` } : {}),
    nextUrl: new URL(`https://x/api/cron/lancio-followup?${extra}`),
  } as never);

const tel = (id: number) => `+39333000${String(id).padStart(4, '0')}`;
const conv = (id: number, extra: Partial<ConvFinta> = {}): ConvFinta => ({
  id,
  crm_lead_id: `crm-${id}`,
  lancio_fase: 'attesa',
  lancio_info: null,
  lancio_benvenuto_at: ANCORA,
  lancio_followup_inviato_at: null,
  last_inbound_at: '2026-09-20T10:30:00Z',
  ai_paused_at: null,
  handed_off_at: null,
  leads: { phone_e164: tel(id), first_name: 'mario rossi' },
  ...extra,
});
const righe = (id: number, ...testi: [string, string][]): Riga[] => [
  { conversation_id: id, direction: 'out', body: 'benvenuto', template_sid: WELCOME, created_at: ANCORA },
  ...testi.map(([body, created_at]) => ({ conversation_id: id, direction: 'in', body, template_sid: null, created_at })),
];

const insertIn = (table: string) =>
  chiamate.filter((c) => c.table === table && c.op === 'insert').map((c) => c.arg as Record<string, unknown>);
const eventi = () => insertIn('event_log');
const tipiEvento = () => eventi().map((e) => e.type);
const eventoRun = () => eventi().find((e) => e.type === 'lancio_followup_run');
const selectConv = () => chiamate.find((c) => c.table === 'conversations' && c.op === 'select');
/** La select della cronologia (l'altra select su `messages` è la seconda idempotenza). */
const selectMessaggi = () =>
  chiamate.find(
    (c) => c.table === 'messages' && c.op === 'select' && !c.filtri.some((f) => f.m === 'eq' && f.args[0] === 'template_sid'),
  );
const updateConv = (id: number) =>
  chiamate.filter(
    (c) =>
      c.table === 'conversations' &&
      c.op === 'update' &&
      c.filtri.some((f) => f.m === 'eq' && f.args[0] === 'id' && f.args[1] === id),
  ).map((c) => c.arg as Record<string, unknown>);
const upserts = () => chiamate.filter((c) => c.op === 'upsert').map((c) => c.arg as Record<string, unknown>);

beforeEach(() => {
  chiamate.length = 0;
  stato.convs = [conv(1), conv(2, { leads: { phone_e164: tel(2), first_name: 'anna verdi' } })];
  stato.messaggi = new Map([
    [1, righe(1, ['si', '2026-09-20T10:30:00Z'])],
    [2, righe(2, ['ok ci sono', '2026-09-21T10:30:00Z'])],
  ]);
  stato.spediti = [];
  stato.timbrate = new Set();
  stato.timbri = new Map();
  stato.convSelectError = null;
  stato.idempotenzaSelectError = null;
  stato.timbrateAllInvio = [];
  stato.settings = { lancio_attivo: true, lancio_evento_at: EVENTO, lancio_sender: 'principale' };
  sendTemplate.mockReset().mockImplementation(async () => {
    stato.timbrateAllInvio.push([...stato.timbrate]);
    return { sid: 'SMtest', status: 'queued' };
  });
  impostaFaseLancio.mockClear();
  marcaCongedo.mockClear();
  congedoLancio.mockClear();
  leggiIngressoLancioAt.mockClear().mockResolvedValue(null);
  vi.stubEnv('CRON_SECRET', SEGRETO);
  vi.stubEnv('LANCIO_FOLLOWUP_TEMPLATE_SID', SID);
  vi.stubEnv('LANCIO_WELCOME_TEMPLATE_SID', WELCOME);
  vi.stubEnv('TWILIO_WHATSAPP_NUMBER_FENICE', 'whatsapp:+390000000000');
  vi.stubEnv('LANCIO_BATCH_MAX', '');
  vi.useFakeTimers();
  vi.setSystemTime(new Date(DENTRO));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('GET /api/cron/lancio-followup — cancelli', () => {
  it('senza segreto: 401 e nessuna lettura', async () => {
    expect((await richiesta('', null)).status).toBe(401);
    expect(chiamate).toHaveLength(0);
  });

  it('fuori dalle fasce di Roma: skip, run scritto, nessun invio', async () => {
    vi.setSystemTime(new Date(FUORI));
    await expect((await richiesta()).json()).resolves.toMatchObject({ skipped: 'fuori_finestra' });
    expect(sendTemplate).not.toHaveBeenCalled();
    expect((eventoRun()?.payload as Record<string, unknown>).motivo).toBe('fuori_finestra');
  });

  it('lancio_evento_at di un lancio vecchio (>14gg): evento error, e il run continua', async () => {
    stato.settings.lancio_evento_at = '2026-09-01T21:00:00+02:00';
    await richiesta();
    const allarme = eventi().find((e) => e.type === 'lancio_evento_at_nel_passato');
    expect(allarme?.level).toBe('error');
    expect(allarme?.payload).toMatchObject({ cron: 'lancio-followup', evento_giorno: '2026-09-01', oggi: '2026-10-06', giorni_indietro: 35 });
  });

  // Questo cron gira per definizione il 6 e il 7, cioe' SEMPRE dopo l'evento: con la
  // tolleranza zero avrebbe scritto un error a ogni run (uno ogni 5 minuti) a lancio
  // perfetto, che e' esattamente il rumore che nasconde il guasto vero. Soglia 14 giorni.
  it('il 6/10 con la data giusta l allarme NON suona: l evento appena passato e la norma', async () => {
    await richiesta();
    expect(tipiEvento()).not.toContain('lancio_evento_at_nel_passato');
  });

  it('a 14 giorni tace, a 15 suona', async () => {
    stato.settings.lancio_evento_at = '2026-09-22T21:00:00+02:00'; // 14 giorni prima del 6/10
    await richiesta();
    expect(tipiEvento()).not.toContain('lancio_evento_at_nel_passato');
    chiamate.length = 0;
    stato.settings.lancio_evento_at = '2026-09-21T21:00:00+02:00'; // 15
    await richiesta();
    expect(tipiEvento()).toContain('lancio_evento_at_nel_passato');
  });

  it('a finestra chiusa il run conta chi e rimasto senza follow-up', async () => {
    vi.setSystemTime(new Date(CHIUSA));
    await expect((await richiesta()).json()).resolves.toMatchObject({ skipped: 'fuori_finestra', finestraChiusa: true, residui: 2 });
    expect(eventoRun()?.level).toBe('warn');
  });

  it('lancio spento DENTRO la finestra: nessun invio e un warn lancio_followup_fermo (C7)', async () => {
    stato.settings.lancio_attivo = false;
    await expect((await richiesta()).json()).resolves.toMatchObject({ skipped: 'lancio_non_attivo' });
    expect(sendTemplate).not.toHaveBeenCalled();
    expect(selectConv()).toBeUndefined();
    const fermo = eventi().find((e) => e.type === 'lancio_followup_fermo');
    expect(fermo?.level).toBe('warn');
    expect((fermo?.payload as Record<string, unknown>).motivo).toBe('lancio_attivo_spento');
    expect(eventoRun()).toBeTruthy();
  });

  it('lancio spento FUORI finestra: solo il run, niente warn', async () => {
    stato.settings.lancio_attivo = false;
    vi.setSystemTime(new Date(FUORI));
    await richiesta();
    expect(tipiEvento()).not.toContain('lancio_followup_fermo');
    expect(eventoRun()).toBeTruthy();
  });

  it('forza=1 senza solo e now= senza solo sono 400', async () => {
    expect((await richiesta('forza=1')).status).toBe(400);
    expect((await richiesta(`now=${encodeURIComponent(DENTRO)}`)).status).toBe(400);
    expect(sendTemplate).not.toHaveBeenCalled();
  });

  it('forza=1&solo=<id> salta la finestra e manda a quella sola conversazione', async () => {
    vi.setSystemTime(new Date(FUORI));
    await expect((await richiesta('forza=1&solo=2')).json()).resolves.toMatchObject({ sent: 1 });
    expect(selectConv()?.filtri).toContainEqual({ m: 'eq', args: ['id', 2] });
    expect(sendTemplate).toHaveBeenCalledTimes(1);
    expect(sendTemplate).toHaveBeenCalledWith(expect.objectContaining({ to: tel(2) }));
  });

  it('template o mittente mancanti: config error prima della finestra', async () => {
    vi.stubEnv('LANCIO_FOLLOWUP_TEMPLATE_SID', '');
    vi.setSystemTime(new Date(FUORI));
    await expect((await richiesta()).json()).resolves.toMatchObject({ skipped: 'config' });
    expect(tipiEvento()).toContain('lancio_followup_config_error');
  });

  it('evento illeggibile: config error', async () => {
    stato.settings.lancio_evento_at = 'domani';
    await expect((await richiesta()).json()).resolves.toMatchObject({ skipped: 'config' });
  });

  it('dry: valuta e conta, non timbra e non manda', async () => {
    await expect((await richiesta('dry=1')).json()).resolves.toMatchObject({ dry: true, candidati: 2, targets: 2 });
    expect(sendTemplate).not.toHaveBeenCalled();
    expect(stato.timbrate.size).toBe(0);
  });

  it('query dei candidati fallita: si logga, queryKo, nessuna coda finta', async () => {
    stato.convSelectError = { message: 'column conversations.lancio_fase does not exist', code: '42703' };
    await expect((await richiesta()).json()).resolves.toMatchObject({ queryKo: true, sent: 0 });
    expect(tipiEvento()).toContain('lancio_followup_query_error');
  });
});

describe('GET /api/cron/lancio-followup — perimetro (C4) e decisione', () => {
  it('la query esclude congedati, timbrati, fasi fuori perimetro, chi non ha mai scritto, pausa e passaggio a umano', async () => {
    await richiesta();
    const f = selectConv()?.filtri ?? [];
    expect(f).toContainEqual({ m: 'is', args: ['lancio_info->>congedo_at', null] });
    expect(f).toContainEqual({ m: 'is', args: ['lancio_followup_inviato_at', null] });
    expect(f).toContainEqual({ m: 'in', args: ['lancio_fase', ['attesa', 'posto_bloccato', 'link_inviato', 'post_pitch']] });
    expect(f).toContainEqual({ m: 'not', args: ['last_inbound_at', 'is', null] });
    expect(f).toContainEqual({ m: 'is', args: ['ai_paused_at', null] });
    expect(f).toContainEqual({ m: 'is', args: ['handed_off_at', null] });
    expect(f).toContainEqual({ m: 'order', args: ['id', { ascending: true }] });
  });

  it('chi si e congedato non riceve il follow-up', async () => {
    stato.convs = [conv(1, { lancio_info: { congedo_at: '2026-10-05T23:00:00Z' } }), conv(2)];
    await expect((await richiesta()).json()).resolves.toMatchObject({ candidati: 1, sent: 1 });
    expect(sendTemplate).toHaveBeenCalledTimes(1);
    expect(sendTemplate).toHaveBeenCalledWith(expect.objectContaining({ to: tel(2) }));
  });

  it('post_pitch fermo dalla sera del pitch: riceve il follow-up come gli altri', async () => {
    stato.convs = [conv(1, { lancio_fase: 'post_pitch', last_inbound_at: '2026-10-05T20:10:00Z' })];
    stato.messaggi.set(1, righe(1, ['ho premuto il pulsante', '2026-10-05T19:40:00Z'], ['si, lavoro', '2026-10-05T20:10:00Z']));
    await expect((await richiesta()).json()).resolves.toMatchObject({ sent: 1 });
    expect(sendTemplate).toHaveBeenCalledWith(expect.objectContaining({ to: tel(1) }));
  });

  it('post_pitch ancora vivo il 6: non si interrompe, si conta in_scelta', async () => {
    stato.convs = [conv(1, { lancio_fase: 'post_pitch', last_inbound_at: '2026-10-06T09:30:00Z' })];
    stato.messaggi.set(1, righe(1, ['ho premuto il pulsante', '2026-10-05T19:40:00Z'], ['scusa ieri, possiamo sentirci?', '2026-10-06T09:30:00Z']));
    const res = await (await richiesta()).json();
    expect(res.saltati.in_scelta).toBe(1);
    expect(sendTemplate).not.toHaveBeenCalled();
  });

  it('un inbound solo PRIMA dell ancora (chat riusata) non e interazione: si salta, niente template', async () => {
    stato.messaggi.set(1, righe(1, ['ciao', '2026-08-01T10:00:00Z']));
    const res = await (await richiesta()).json();
    expect(res.saltati.mai_scritto).toBe(1);
    expect(sendTemplate).toHaveBeenCalledTimes(1);
    expect(sendTemplate).toHaveBeenCalledWith(expect.objectContaining({ to: tel(2) }));
  });

  it('senza benvenuto ne colonna si chiede l istante dell intake; se manca pure quello, ancora ignota', async () => {
    stato.convs = [conv(1, { lancio_benvenuto_at: null })];
    stato.messaggi.set(1, [{ conversation_id: 1, direction: 'in', body: 'si', template_sid: null, created_at: '2026-09-20T10:30:00Z' }]);
    const res = await (await richiesta()).json();
    expect(leggiIngressoLancioAt).toHaveBeenCalledWith(expect.anything(), 1);
    expect(res.saltati.ancora_ignota).toBe(1);
    expect(sendTemplate).not.toHaveBeenCalled();
    // Su una chat mai vista, se l'intake risponde, l'ancora c'è e il follow-up parte.
    leggiIngressoLancioAt.mockResolvedValue('2026-09-20T09:00:00Z');
    stato.convs = [conv(9, { lancio_benvenuto_at: null })];
    stato.messaggi.set(9, [{ conversation_id: 9, direction: 'in', body: 'si', template_sid: null, created_at: '2026-09-20T10:30:00Z' }]);
    chiamate.length = 0;
    await expect((await richiesta()).json()).resolves.toMatchObject({ sent: 1 });
  });

  it('chi non ha proprio un ancora si marca su lancio_info e al run dopo non costa una lettura', async () => {
    stato.convs = [conv(1, { lancio_benvenuto_at: null, lancio_info: { risposte: ['ok'] } })];
    stato.messaggi.set(1, [{ conversation_id: 1, direction: 'in', body: 'si', template_sid: null, created_at: '2026-09-20T10:30:00Z' }]);
    const res = await (await richiesta()).json();
    expect(res.saltati.ancora_ignota).toBe(1);
    expect((eventoRun()?.payload as Record<string, unknown>).ancoreIgnoteMarcate).toBe(1);
    // Il merge tiene quello che c'era (C4: `congedo_at` e le risposte di B4 non si toccano).
    const scritto = updateConv(1).map((u) => u.lancio_info as Record<string, unknown>).filter(Boolean);
    expect(scritto).toHaveLength(1);
    expect(scritto[0]).toMatchObject({ risposte: ['ok'], followup_ancora_ignota_at: expect.any(String) });
    expect(scritto[0]).not.toHaveProperty('congedo_at');
    // Run gemello: la chat è ancora candidata (entra nei residui e nel pool del Task 5)
    // ma non si mangia più una delle 50 letture dell'intake.
    leggiIngressoLancioAt.mockClear();
    chiamate.length = 0;
    const dopo = await (await richiesta()).json();
    expect(leggiIngressoLancioAt).not.toHaveBeenCalled();
    expect(dopo.candidati).toBe(1);
    expect(dopo.saltati.ancora_ignota).toBe(1);
    expect(sendTemplate).not.toHaveBeenCalled();
  });

  it('un no secco come ultimo inbound non congeda: riceve il follow-up (C1 aggiornato)', async () => {
    stato.messaggi.set(1, righe(1, ['si', '2026-09-20T10:30:00Z'], ['no', '2026-10-05T20:05:00Z']));
    await expect((await richiesta()).json()).resolves.toMatchObject({ sent: 2, congedati: 0 });
    expect(congedoLancio).not.toHaveBeenCalled();
  });

  it('l ultimo inbound e un rifiuto esplicito: marcaCongedo + congedoLancio senza bolla, nessun template (C1)', async () => {
    stato.messaggi.set(1, righe(1, ['si', '2026-09-20T10:30:00Z'], ['no grazie non mi interessa', '2026-10-06T00:30:00Z']));
    const res = await (await richiesta()).json();
    expect(res).toMatchObject({ sent: 1, congedati: 1 });
    expect(marcaCongedo).toHaveBeenCalledWith(expect.anything(), 1);
    expect(congedoLancio).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ conversationId: 1, crmLeadId: 'crm-1', phone: tel(1) }),
      'no grazie non mi interessa',
      expect.stringContaining('Lancio Web Dev AI'),
      { giaInviato: true },
    );
    expect(sendTemplate).toHaveBeenCalledTimes(1);
    expect(sendTemplate).toHaveBeenCalledWith(expect.objectContaining({ to: tel(2) }));
    expect(tipiEvento()).toContain('lancio_followup_congedo_da_cron');
    expect(stato.timbrate.has(1)).toBe(false);
  });

  it('le letture dell intake sono al massimo MAX_LETTURE_INTAKE per run: il resto conta ancora_ignota e si rivaluta al run dopo', async () => {
    stato.convs = Array.from({ length: 60 }, (_, i) => conv(i + 1, { lancio_benvenuto_at: null }));
    for (const c of stato.convs) {
      stato.messaggi.set(c.id, [{ conversation_id: c.id, direction: 'in', body: 'si', template_sid: null, created_at: '2026-09-20T10:30:00Z' }]);
    }
    const res = await (await richiesta()).json();
    expect(leggiIngressoLancioAt).toHaveBeenCalledTimes(50);
    expect(res.saltati.ancora_ignota).toBe(60);
    expect(sendTemplate).not.toHaveBeenCalled();
  });

  it('il tetto del lotto vale sui bersagli, non sui candidati: chi si salta non ruba posti', async () => {
    vi.stubEnv('LANCIO_BATCH_MAX', '1');
    stato.convs = [conv(1), conv(2), conv(3)];
    stato.messaggi.set(1, righe(1, ['ciao', '2026-08-01T10:00:00Z']));
    stato.messaggi.set(3, righe(3, ['si', '2026-09-22T10:30:00Z']));
    const res = await (await richiesta()).json();
    expect(res).toMatchObject({ sent: 1, residui: 0, nonValutati: 1 });
    expect(sendTemplate).toHaveBeenCalledWith(expect.objectContaining({ to: tel(2) }));
  });

  it('la cronologia si legge dal taglio dello storico in poi e solo per le righe che servono', async () => {
    // Chat riusata: dietro ha mesi di giro di Mario, compreso un "non mi interessa" di
    // luglio che non c'entra niente con questo lancio.
    stato.messaggi.set(1, [
      { conversation_id: 1, direction: 'in', body: 'no grazie non mi interessa', template_sid: null, created_at: '2026-07-01T09:00:00Z' },
      { conversation_id: 1, direction: 'out', body: 'ok ciao', template_sid: null, created_at: '2026-07-01T09:05:00Z' },
      ...righe(1, ['si', '2026-09-20T10:30:00Z']),
    ]);
    const res = await (await richiesta()).json();
    const f = selectMessaggi()?.filtri ?? [];
    // `lancio_evento_at` è il 5/10 alle 21:00 di Roma = 19:00Z; meno 30 giorni.
    expect(f).toContainEqual({ m: 'gte', args: ['created_at', '2026-09-05T19:00:00.000Z'] });
    expect(f).toContainEqual({ m: 'or', args: [`direction.eq.in,template_sid.eq.${WELCOME}`] });
    // Deciso sulle sole righe del lancio: riceve il follow-up, non viene scartato.
    expect(res).toMatchObject({ sent: 2, congedati: 0 });
    expect(congedoLancio).not.toHaveBeenCalled();
  });

  it('cronologia troncata: nessuna decisione sul blocco, warn e tutto ancora_ignota', async () => {
    // Oltre il tetto di righe l ordine crescente butta via le righe PIU NUOVE: decidere
    // su una lettura tagliata vuol dire non mandare per sempre o scartare per un no vecchio.
    stato.messaggi.set(1, [
      ...righe(1, ['si', '2026-09-20T10:30:00Z']),
      ...Array.from({ length: 8000 }, (_, k) => ({
        conversation_id: 1,
        direction: 'in',
        body: `riga ${k}`,
        template_sid: null,
        created_at: `2026-09-${String(21 + (k % 9)).padStart(2, '0')}T10:00:00Z`,
      })),
    ]);
    const res = await (await richiesta()).json();
    expect(res).toMatchObject({ sent: 0, congedati: 0, blocchiTroncati: 1 });
    expect(res.saltati.ancora_ignota).toBe(2);
    expect(sendTemplate).not.toHaveBeenCalled();
    const troncato = eventi().find((e) => e.type === 'lancio_followup_blocco_troncato');
    expect(troncato?.level).toBe('warn');
    expect(troncato?.payload).toMatchObject({ blocco: 0, righe: expect.any(Number), conversazioni: 2 });
  });

  it('da congedare ma senza numero: si conta e si scrive, non sparisce', async () => {
    stato.convs = [conv(1, { leads: null }), conv(2)];
    stato.messaggi.set(1, righe(1, ['si', '2026-09-20T10:30:00Z'], ['non mi interessa', '2026-10-06T00:30:00Z']));
    const res = await (await richiesta()).json();
    expect(res).toMatchObject({ sent: 1, congedati: 0 });
    expect(res.saltati.senza_telefono).toBe(1);
    expect(tipiEvento()).toContain('lancio_followup_congedo_senza_telefono');
    expect(congedoLancio).not.toHaveBeenCalled();
    expect(marcaCongedo).not.toHaveBeenCalled();
  });

  it('mittente secondario chiesto ma non disponibile: warn e si parte dal principale', async () => {
    stato.settings.lancio_sender = 'secondario';
    await expect((await richiesta()).json()).resolves.toMatchObject({ sent: 2 });
    expect(tipiEvento()).toContain('lancio_sender_secondario_non_disponibile');
    expect(sendTemplate).toHaveBeenCalledWith(expect.objectContaining({ from: 'whatsapp:+390000000000' }));
  });
});

describe('GET /api/cron/lancio-followup — invio col motore', () => {
  it('manda il template col nome proprio, registra il messaggio, timbra e passa a followup_inviato', async () => {
    await expect((await richiesta()).json()).resolves.toMatchObject({ candidati: 2, sent: 2, failed: 0, capped: 0, fermo: null });
    expect(sendTemplate).toHaveBeenCalledWith(expect.objectContaining({ to: tel(1), contentSid: SID, variables: { '1': 'Mario' } }));
    const msg = insertIn('messages');
    expect(msg).toHaveLength(2);
    expect(msg[0]).toMatchObject({ template_sid: SID, is_template: true, direction: 'out', sender: 'automazione' });
    expect(String(msg[0].body)).toContain('Ciao Mario, ieri sera');
    expect(impostaFaseLancio).toHaveBeenCalledWith(
      expect.anything(),
      1,
      'followup_inviato',
      { lancio_followup_inviato_at: expect.any(String) },
      { soloDaFasi: ['attesa', 'posto_bloccato', 'link_inviato', 'post_pitch'] },
    );
    expect(tipiEvento()).toContain('lancio_followup_inviato');
    expect(stato.timbrateAllInvio[0]).toContain(1);
  });

  // `post_pitch` ora e' DENTRO il perimetro (fix del 17/09), quindi la fase di prova qui
  // e' `scelta_fatta`: il compare-and-set serve proprio a non riportare indietro una chat
  // che nel frattempo ha scelto. Il timbro invece resta: e' del claim, e tiene la chat
  // fuori dalla coda del run successivo.
  it('una fase avanzata durante l invio (scelta fatta) non torna indietro; il timbro resta', async () => {
    stato.convs = [conv(1)];
    sendTemplate.mockImplementationOnce(async () => {
      stato.convs[0].lancio_fase = 'scelta_fatta';
      return { sid: 'SMtest', status: 'queued' };
    });
    await expect((await richiesta()).json()).resolves.toMatchObject({ sent: 1, failed: 0 });
    expect(stato.convs[0].lancio_fase).toBe('scelta_fatta');
    expect(stato.timbrate).toEqual(new Set([1]));
  });

  it('un run gemello non rimanda: le chat timbrate escono dalla coda', async () => {
    await richiesta();
    sendTemplate.mockClear();
    chiamate.length = 0;
    await expect((await richiesta()).json()).resolves.toMatchObject({ candidati: 0, sent: 0 });
    expect(sendTemplate).not.toHaveBeenCalled();
  });

  it('gia spedito secondo messages.template_sid: si ripara la fase, non si rimanda', async () => {
    stato.spediti = [{ conversation_id: 1 }];
    await expect((await richiesta()).json()).resolves.toMatchObject({ sent: 1, riparati: 1 });
    expect(impostaFaseLancio).toHaveBeenCalledWith(
      expect.anything(),
      1,
      'followup_inviato',
      expect.anything(),
      { soloDaFasi: ['attesa', 'posto_bloccato', 'link_inviato', 'post_pitch'] },
    );
  });

  it('63049: capped, timbro liberato, il run tira dritto e non spegne il lancio', async () => {
    sendTemplate.mockRejectedValueOnce(Object.assign(new Error('cap'), { code: 63049 }));
    await expect((await richiesta()).json()).resolves.toMatchObject({ capped: 1, sent: 1, fermo: null });
    expect(tipiEvento()).toContain('lancio_followup_freq_capped');
    expect(stato.timbrate.has(1)).toBe(false);
    expect(upserts()).toHaveLength(0);
  });

  it('errore Twilio senza codice: esito incerto, timbro tenuto', async () => {
    sendTemplate.mockRejectedValueOnce(new Error('socket hang up'));
    await expect((await richiesta()).json()).resolves.toMatchObject({ incerti: 1, sent: 1 });
    expect(stato.timbrate.has(1)).toBe(true);
    expect(tipiEvento()).toContain('lancio_followup_esito_incerto');
  });

  it('oltre il 10% di falliti il freno ferma il run e spegne lancio_attivo (C6)', async () => {
    stato.convs = Array.from({ length: 60 }, (_, i) => conv(i + 1));
    for (const c of stato.convs) stato.messaggi.set(c.id, righe(c.id, ['si', '2026-09-20T10:30:00Z']));
    sendTemplate.mockImplementation(async () => {
      throw Object.assign(new Error('giu'), { code: 21211 });
    });
    const res = await (await richiesta()).json();
    expect(res.fermo).toBe('freno');
    expect(res.failed).toBe(25);
    expect(tipiEvento()).toContain('lancio_followup_freno');
    expect(upserts()).toContainEqual(expect.objectContaining({ key: 'lancio_attivo', value: false }));
  });

  it('i conti tornano: targets = inviati + riparati + capped + falliti + incerti + saltatiInvio + errori + residui; candidati = valutati + nonValutati', async () => {
    vi.stubEnv('LANCIO_BATCH_MAX', '3');
    stato.convs = [conv(1), conv(2), conv(3, { leads: null }), conv(4)];
    for (const id of [3, 4]) stato.messaggi.set(id, righe(id, ['si', '2026-09-20T10:30:00Z']));
    sendTemplate.mockRejectedValueOnce(Object.assign(new Error('giu'), { code: 21211 }));
    const res = await (await richiesta()).json();
    const p = eventoRun()?.payload as Record<string, number>;
    expect(p.candidati).toBe(4);
    expect(p.targets).toBe(3);
    expect(p.nonValutati).toBe(1);
    expect(p.inviati + p.riparati + p.capped + p.falliti + p.incerti + p.saltatiInvio + p.errori + p.residui).toBe(3);
    expect(res).toMatchObject({ sent: 1, failed: 1, skip: 1, nonValutati: 1 });
  });

  it('la query della seconda idempotenza ha un type di evento suo', async () => {
    stato.idempotenzaSelectError = { message: 'column messages.twilio_status does not exist', code: '42703' };
    await expect((await richiesta()).json()).resolves.toMatchObject({ sent: 2 });
    expect(tipiEvento()).toContain('lancio_followup_idempotenza_query_error');
    expect(tipiEvento()).not.toContain('lancio_followup_messages_query_error');
  });

  it('il run si scrive anche senza candidati', async () => {
    stato.convs = [];
    await expect((await richiesta()).json()).resolves.toMatchObject({ candidati: 0, sent: 0 });
    expect(eventoRun()).toBeTruthy();
  });
});
