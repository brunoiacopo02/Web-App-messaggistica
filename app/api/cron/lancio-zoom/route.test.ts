import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─────────────────────────── finto Supabase ───────────────────────────
// Registra ogni chiamata (tabella, operazione, payload, filtri) così i test possono
// interrogare anche quello che NON è stato scritto: "nessuna riga messages sul frequency
// cap", "il congedo è escluso nella query" e "il timbro è stato liberato" sono asserzioni
// sul secondo tipo.
//
// `conversations.lancio_link_inviato_at` è finto per davvero — l'update con
// `.is('lancio_link_inviato_at', null)` restituisce righe solo la prima volta — perché il
// lucchetto contro il doppio invio è tutto lì: se il compare-and-set non fosse simulato,
// il test lo vedrebbe funzionare anche se il route non lo usasse.

type Filtro = { m: string; args: unknown[] };
type Chiamata = {
  table: string;
  op: 'select' | 'insert' | 'update' | 'upsert';
  arg: unknown;
  filtri: Filtro[];
  opzioni?: { head?: boolean; count?: string };
};
const chiamate: Chiamata[] = [];

type ConvFinta = {
  id: number;
  crm_lead_id: string | null;
  /** Il numero con cui la chat e' nata: il link deve uscire di li'. */
  wa_number?: string | null;
  lancio_fase: string | null;
  lancio_info: Record<string, unknown> | null;
  last_inbound_at: string | null;
  leads: { phone_e164: string | null; first_name: string | null } | null;
};

const stato = {
  convs: [] as ConvFinta[],
  /** Righe `messages` già a DB col SID del blast: la seconda idempotenza. */
  spediti: [] as { conversation_id: number }[],
  settings: {} as Record<string, unknown>,
  /** Chat già timbrate: il claim non le restituisce. */
  timbrate: new Set<number>(),
  /** Il VALORE del timbro per conv: il rilascio è ancorato a quello di questo run. */
  timbri: new Map<number, string>(),
  /** La select dei candidati fallisce (migrazione non applicata). */
  convSelectError: null as { message: string; code?: string } | null,
  /** L'insert della riga `messages` esplode: il worker non deve far cadere il run. */
  messagesInsertKo: false,
  /** Chat che la select restituisce ma che un run gemello si prende un istante dopo: il
   *  claim non deve riuscire. E' la corsa vera fra due run del cron. */
  rubate: new Set<number>(),
  /** L'update del claim torna un errore (DB in affanno): niente invio, ma si deve vedere. */
  claimError: null as { message: string } | null,
  /** Chi era già timbrato nel momento in cui Twilio è stato chiamato: se un invio parte
   *  prima del timbro, il crash di mezzo lo fa ripartire al run dopo. */
  timbrateAllInvio: [] as number[][],
};

const arg = (rec: Chiamata, metodo: string, colonna: string): Filtro | undefined =>
  rec.filtri.find((f) => f.m === metodo && f.args[0] === colonna);

function congedato(c: ConvFinta): boolean {
  const v = c.lancio_info?.congedo_at;
  return typeof v === 'string' && v.trim() !== '';
}

/** Applica alla fixture i filtri che il route ha davvero messo nella query. */
function filtraCandidati(rec: Chiamata): ConvFinta[] {
  // `not('lancio_link_inviato_at', 'is', null)` = la query degli incerti: chi il timbro
  // ce l'ha ma è rimasto in una fase da servire.
  const soloTimbrate = Boolean(arg(rec, 'not', 'lancio_link_inviato_at'));
  let out = stato.convs.filter((c) => stato.timbrate.has(c.id) === soloTimbrate);
  if (arg(rec, 'is', 'lancio_info->>congedo_at')) out = out.filter((c) => !congedato(c));
  const fasi = arg(rec, 'in', 'lancio_fase')?.args[1] as string[] | undefined;
  if (fasi) out = out.filter((c) => c.lancio_fase !== null && fasi.includes(c.lancio_fase));
  if (arg(rec, 'not', 'last_inbound_at')) out = out.filter((c) => Boolean(c.last_inbound_at));
  const solo = rec.filtri.find((f) => f.m === 'eq' && f.args[0] === 'id');
  if (solo) out = out.filter((c) => c.id === solo.args[1]);
  return out;
}

function esegui(rec: Chiamata): { data: unknown; error: unknown; count?: number } {
  if (rec.table === 'conversations' && rec.op === 'update') {
    const campi = rec.arg as Record<string, unknown>;
    const id = Number(rec.filtri.find((f) => f.m === 'eq' && f.args[0] === 'id')?.args[1]);
    if (!('lancio_link_inviato_at' in campi)) return { data: [], error: null };
    if (campi.lancio_link_inviato_at === null) {
      // Rilascio ancorato: si libera solo il timbro scritto da questo run.
      const atteso = arg(rec, 'eq', 'lancio_link_inviato_at')?.args[1];
      if (atteso === undefined || stato.timbri.get(id) === atteso) {
        stato.timbrate.delete(id);
        stato.timbri.delete(id);
      }
      return { data: [], error: null };
    }
    // Claim: `is('lancio_link_inviato_at', null)` è un compare-and-set.
    if (stato.claimError) return { data: null, error: stato.claimError };
    if (stato.timbrate.has(id) || stato.rubate.has(id)) return { data: [], error: null };
    stato.timbrate.add(id);
    stato.timbri.set(id, String(campi.lancio_link_inviato_at));
    return { data: [{ id }], error: null };
  }
  if (rec.table === 'messages' && rec.op === 'insert' && stato.messagesInsertKo) {
    throw new Error('insert messages KO');
  }
  if (rec.op !== 'select') return { data: null, error: null };
  if (rec.table === 'app_settings') {
    return { data: Object.entries(stato.settings).map(([key, value]) => ({ key, value })), error: null };
  }
  if (rec.table === 'conversations') {
    if (stato.convSelectError) return { data: null, error: stato.convSelectError };
    const righe = filtraCandidati(rec);
    if (rec.opzioni?.head) return { data: null, error: null, count: righe.length };
    const range = (rec.filtri.find((f) => f.m === 'range')?.args as number[] | undefined) ?? [0, 999];
    return { data: righe.slice(range[0], range[1] + 1), error: null };
  }
  if (rec.table === 'messages') {
    const ids = (arg(rec, 'in', 'conversation_id')?.args[1] as number[] | undefined) ?? [];
    return { data: stato.spediti.filter((m) => ids.includes(m.conversation_id)), error: null };
  }
  return { data: [], error: null };
}

function query(table: string, op: Chiamata['op'], a: unknown, opzioni?: Chiamata['opzioni']) {
  const rec: Chiamata = { table, op, arg: a, filtri: [], opzioni };
  chiamate.push(rec);
  const q: Record<string, unknown> = {};
  for (const m of ['eq', 'is', 'in', 'not', 'order', 'limit', 'range', 'gte', 'lte', 'select', 'contains']) {
    q[m] = (...args: unknown[]) => {
      rec.filtri.push({ m, args });
      return q;
    };
  }
  q.maybeSingle = () => q;
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
const assertTemplateSendable = vi.fn();
vi.mock('@/lib/twilio', () => ({
  sendTemplate: (...a: unknown[]) => sendTemplate(...a),
  assertTemplateSendable: (...a: unknown[]) => assertTemplateSendable(...a),
  getTemplateBody: async () => 'Ciao {{1}}, link: {{2}}',
}));

// `impostaFaseLancio` ha i suoi test (B1): qui interessa CHE venga chiamata, con quale
// fase e con quale timbro — non come scrive. La fase però la sposta davvero nella
// fixture: una chat servita esce dalle fasi bersaglio, ed è quello che distingue un invio
// riuscito da uno dall'esito incerto quando a fine serata si contano i conti.
const impostaFaseLancio = vi.fn<(...a: unknown[]) => Promise<void>>(async (...a) => {
  const conversazione = stato.convs.find((c) => c.id === a[1]);
  if (!conversazione) return;
  // `soloDaFasi` e' il compare-and-set sulla fase di partenza: qui e' finto come e' finto
  // il lucchetto del timbro, perche' e' esattamente quello che il test deve vedere.
  const soloDaFasi = (a[4] as { soloDaFasi?: readonly string[] } | undefined)?.soloDaFasi;
  if (soloDaFasi && !soloDaFasi.includes(conversazione.lancio_fase ?? '')) return;
  conversazione.lancio_fase = a[2] as string;
});
vi.mock('@/lib/lancio-db', () => ({
  impostaFaseLancio: (...a: unknown[]) => impostaFaseLancio(...a),
}));

import { GET } from './route';

const SEGRETO = 'segreto-di-test';
const SID = 'HXzoom';
const ZOOM = 'https://us06web.zoom.us/j/89845223337';
const EVENTO = '2026-10-05T21:00:00+02:00';
/** 20:00 di Roma del 5/10: dentro la finestra 19:30-20:45. */
const DENTRO = '2026-10-05T20:00:00+02:00';
const PRIMA = '2026-10-05T19:20:00+02:00';
const DOPO = '2026-10-05T22:00:00+02:00';

const richiesta = (now: string = DENTRO, extra = '', secret: string | null = SEGRETO) =>
  GET({
    headers: new Headers(secret ? { authorization: `Bearer ${secret}` } : {}),
    nextUrl: new URL(`https://x/api/cron/lancio-zoom?now=${encodeURIComponent(now)}${extra}`),
  } as never);

const tel = (id: number) => `+39333000${String(id).padStart(4, '0')}`;

const conv = (id: number, extra: Partial<ConvFinta> = {}): ConvFinta => ({
  id,
  crm_lead_id: `crm-${id}`,
  wa_number: null,
  lancio_fase: 'attesa',
  lancio_info: null,
  last_inbound_at: null,
  leads: { phone_e164: tel(id), first_name: 'mario rossi' },
  ...extra,
});

const insertIn = (table: string) =>
  chiamate.filter((c) => c.table === table && c.op === 'insert').map((c) => c.arg as Record<string, unknown>);
const eventi = () => insertIn('event_log');
const tipiEvento = () => eventi().map((e) => e.type);
const eventoRun = () => eventi().find((e) => e.type === 'lancio_zoom_run');
const selectConv = () => chiamate.find((c) => c.table === 'conversations' && c.op === 'select');
const upserts = () => chiamate.filter((c) => c.op === 'upsert').map((c) => c.arg as Record<string, unknown>);
const timbriTolti = () =>
  chiamate.filter(
    (c) =>
      c.table === 'conversations' &&
      c.op === 'update' &&
      (c.arg as Record<string, unknown>).lancio_link_inviato_at === null,
  );

beforeEach(() => {
  chiamate.length = 0;
  stato.convs = [conv(1), conv(2, { leads: { phone_e164: tel(2), first_name: 'anna verdi' } })];
  stato.spediti = [];
  stato.timbrate = new Set();
  stato.timbri = new Map();
  stato.convSelectError = null;
  stato.messagesInsertKo = false;
  stato.rubate = new Set();
  stato.claimError = null;
  stato.timbrateAllInvio = [];
  stato.settings = {
    lancio_attivo: true,
    lancio_zoom_link: ZOOM,
    lancio_evento_at: EVENTO,
    lancio_blast_perimetro: 'tutti',
    lancio_sender: 'principale',
  };
  sendTemplate.mockReset().mockImplementation(async () => {
    stato.timbrateAllInvio.push([...stato.timbrate]);
    return { sid: 'SMtest', status: 'queued' };
  });
  assertTemplateSendable.mockReset().mockResolvedValue(undefined);
  impostaFaseLancio.mockClear();
  vi.stubEnv('CRON_SECRET', SEGRETO);
  vi.stubEnv('LANCIO_ZOOM_TEMPLATE_SID', SID);
  vi.stubEnv('TWILIO_WHATSAPP_NUMBER_FENICE', 'whatsapp:+390000000000');
  vi.stubEnv('LANCIO_BATCH_MAX', '');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('GET /api/cron/lancio-zoom — cancelli', () => {
  it('senza segreto: 401 e nessuna lettura', async () => {
    const res = await richiesta(DENTRO, '', null);
    expect(res.status).toBe(401);
    expect(chiamate).toHaveLength(0);
  });

  it('lancio non attivo: nessuna conversazione letta, nessun invio, ma il run resta scritto', async () => {
    stato.settings.lancio_attivo = false;
    await expect((await richiesta()).json()).resolves.toMatchObject({ skipped: 'lancio_non_attivo' });
    expect(sendTemplate).not.toHaveBeenCalled();
    expect(selectConv()).toBeUndefined();
    expect(eventoRun()).toMatchObject({ type: 'lancio_zoom_run' });
  });

  // Il caso vero: dopo la prova generale `lancio_evento_at` era rimasta al 17/09. La
  // finestra del blast e' quindi gia' passata, il cron esce "fuori_finestra" a livello
  // info e nessuno riceve il link. L'allarme e' l'unica cosa che lo fa vedere.
  it('lancio_evento_at nel passato: evento error accanto al fuori_finestra', async () => {
    stato.settings.lancio_evento_at = '2026-09-17T21:00:00+02:00';
    await richiesta(DENTRO);
    const allarme = eventi().find((e) => e.type === 'lancio_evento_at_nel_passato');
    expect(allarme?.level).toBe('error');
    expect(allarme?.payload).toMatchObject({ cron: 'lancio-zoom', evento_giorno: '2026-09-17', oggi: '2026-10-05' });
  });

  it('la sera dell evento (data giusta) l allarme non suona', async () => {
    await richiesta(DENTRO);
    expect(tipiEvento()).not.toContain('lancio_evento_at_nel_passato');
  });

  it('fuori dalla finestra di Roma: skip, e il run lo dice', async () => {
    await expect((await richiesta(PRIMA)).json()).resolves.toMatchObject({ skipped: 'fuori_finestra' });
    expect(sendTemplate).not.toHaveBeenCalled();
    expect((eventoRun()?.payload as Record<string, unknown>).motivo).toBe('fuori_finestra');
  });

  it('a serata finita il run conta chi è rimasto senza link', async () => {
    await expect((await richiesta(DOPO)).json()).resolves.toMatchObject({
      skipped: 'fuori_finestra', residui: 2, incerti: 0,
    });
    const p = eventoRun()?.payload as Record<string, unknown>;
    expect(p.residui).toBe(2);
    expect(p.finestraChiusa).toBe(true);
    expect(eventoRun()?.level).toBe('warn');
  });

  it('a serata finita gli incerti si contano a parte: non sono residui, ma nemmeno serviti', async () => {
    // Prima la serata vera: la conv 1 resta col timbro e senza certezza.
    sendTemplate.mockRejectedValueOnce(new Error('socket hang up'));
    await richiesta();
    chiamate.length = 0;
    // Poi il run a finestra chiusa.
    const res = await (await richiesta(DOPO)).json();
    expect(res).toMatchObject({ residui: 0, incerti: 1 });
    expect(String(eventoRun()?.message)).toContain('senza link certo');
  });

  it('prima della finestra i residui non si contano: la serata deve ancora cominciare', async () => {
    await richiesta(PRIMA);
    const p = eventoRun()?.payload as Record<string, unknown>;
    expect(p.finestraChiusa).toBe(false);
    expect(p.residui).toBeNull();
  });

  it('forza=1 senza solo=<id> è un 400: non si manda il link a tutti per sbaglio', async () => {
    const res = await richiesta(PRIMA, '&forza=1');
    expect(res.status).toBe(400);
    expect(sendTemplate).not.toHaveBeenCalled();
  });

  it('forza=1&solo=<id> salta solo la finestra, e manda a quella sola conversazione', async () => {
    await expect((await richiesta(PRIMA, '&forza=1&solo=2')).json()).resolves.toMatchObject({ sent: 1 });
    expect(selectConv()?.filtri).toContainEqual({ m: 'eq', args: ['id', 2] });
    expect(sendTemplate).toHaveBeenCalledTimes(1);
    expect(sendTemplate).toHaveBeenCalledWith(expect.objectContaining({ to: tel(2) }));
  });

  it('il kill-switch vince anche su forza+solo', async () => {
    stato.settings.lancio_attivo = false;
    await expect((await richiesta(PRIMA, '&forza=1&solo=2')).json()).resolves.toMatchObject({
      skipped: 'lancio_non_attivo',
    });
    expect(sendTemplate).not.toHaveBeenCalled();
  });

  it('template o numero mittente mancanti: si logga e non si manda', async () => {
    vi.stubEnv('LANCIO_ZOOM_TEMPLATE_SID', '');
    await expect((await richiesta()).json()).resolves.toMatchObject({ skipped: 'config' });
    expect(tipiEvento()).toContain('lancio_zoom_config_error');
    expect(sendTemplate).not.toHaveBeenCalled();
  });

  it('la config si controlla PRIMA della finestra: l allarme suona il 4, non alle 19:30 del 5', async () => {
    vi.stubEnv('LANCIO_ZOOM_TEMPLATE_SID', '');
    await expect((await richiesta(PRIMA)).json()).resolves.toMatchObject({ skipped: 'config' });
    expect(tipiEvento()).toContain('lancio_zoom_config_error');
  });

  it('link Zoom non impostato: config error, mai un messaggio senza link', async () => {
    stato.settings.lancio_zoom_link = '';
    await expect((await richiesta()).json()).resolves.toMatchObject({ skipped: 'config' });
    expect(sendTemplate).not.toHaveBeenCalled();
  });

  it('ora dell evento illeggibile: config error (la finestra non si saprebbe calcolare)', async () => {
    stato.settings.lancio_evento_at = 'domani sera';
    await expect((await richiesta()).json()).resolves.toMatchObject({ skipped: 'config' });
    expect(sendTemplate).not.toHaveBeenCalled();
  });

  it('dry: conta e basta', async () => {
    await expect((await richiesta(DENTRO, '&dry=1')).json()).resolves.toMatchObject({ dry: true, candidati: 2 });
    expect(sendTemplate).not.toHaveBeenCalled();
    expect(impostaFaseLancio).not.toHaveBeenCalled();
    expect(stato.timbrate.size).toBe(0);
  });

  it('query dei candidati fallita: si logga, non si finge una coda vuota', async () => {
    stato.convSelectError = { message: 'column conversations.lancio_fase does not exist', code: '42703' };
    await richiesta();
    expect(tipiEvento()).toContain('lancio_zoom_query_error');
    expect((eventoRun()?.payload as Record<string, unknown>).queryKo).toBe(true);
    expect(sendTemplate).not.toHaveBeenCalled();
  });
});

describe('GET /api/cron/lancio-zoom — perimetro e ordine', () => {
  it('la query esclude i congedati e le fasi già servite', async () => {
    await richiesta();
    const f = selectConv()?.filtri ?? [];
    expect(f).toContainEqual({ m: 'is', args: ['lancio_info->>congedo_at', null] });
    expect(f).toContainEqual({ m: 'is', args: ['lancio_link_inviato_at', null] });
    expect(f).toContainEqual({ m: 'in', args: ['lancio_fase', ['attesa', 'posto_bloccato']] });
    expect(f).toContainEqual({ m: 'order', args: ['id', { ascending: true }] });
  });

  it('chi si è congedato non riceve il link', async () => {
    stato.convs = [conv(1, { lancio_info: { congedo_at: '2026-10-04T10:00:00Z' } }), conv(2)];
    await expect((await richiesta()).json()).resolves.toMatchObject({ candidati: 1, sent: 1 });
    expect(sendTemplate).toHaveBeenCalledWith(expect.objectContaining({ to: tel(2) }));
  });

  it('perimetro "risposto": la query chiede almeno un inbound', async () => {
    stato.settings.lancio_blast_perimetro = 'risposto';
    stato.convs = [conv(1), conv(2, { last_inbound_at: '2026-10-05T18:00:00Z' })];
    await expect((await richiesta()).json()).resolves.toMatchObject({ candidati: 1, sent: 1 });
    expect(selectConv()?.filtri).toContainEqual({ m: 'not', args: ['last_inbound_at', 'is', null] });
    expect(sendTemplate).toHaveBeenCalledWith(expect.objectContaining({ to: tel(2) }));
  });

  it('ordine per intenzione: prima chi ha bloccato il posto, poi chi ha scritto, poi i muti', async () => {
    vi.stubEnv('LANCIO_BATCH_MAX', '2');
    stato.convs = [
      conv(1),
      conv(2, { last_inbound_at: '2026-10-05T18:00:00Z' }),
      conv(3, { lancio_fase: 'posto_bloccato' }),
    ];
    await expect((await richiesta()).json()).resolves.toMatchObject({ sent: 2, residui: 1 });
    const chiamati = sendTemplate.mock.calls.map((c) => (c[0] as { to: string }).to);
    expect(chiamati).toEqual([tel(3), tel(2)]);
  });

  it('il tetto del lotto lascia i residui al run dopo', async () => {
    vi.stubEnv('LANCIO_BATCH_MAX', '1');
    await expect((await richiesta()).json()).resolves.toMatchObject({ candidati: 2, sent: 1, residui: 1 });
    expect(sendTemplate).toHaveBeenCalledTimes(1);
  });

  it('mittente secondario chiesto ma non ancora disponibile: warn e si parte dal principale', async () => {
    stato.settings.lancio_sender = 'secondario';
    await expect((await richiesta()).json()).resolves.toMatchObject({ sent: 2 });
    expect(tipiEvento()).toContain('lancio_sender_secondario_non_disponibile');
    expect(sendTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ from: 'whatsapp:+390000000000' }),
    );
  });
});

describe('GET /api/cron/lancio-zoom — invio', () => {
  it('manda il template con nome proprio e link, registra il messaggio e passa a link_inviato', async () => {
    await expect((await richiesta()).json()).resolves.toMatchObject({
      candidati: 2, sent: 2, failed: 0, capped: 0, riparati: 0, skip: 0, residui: 0, fermo: null,
    });
    expect(sendTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ to: tel(1), contentSid: SID, variables: { '1': 'Mario', '2': ZOOM } }),
    );
    const msg = insertIn('messages');
    expect(msg).toHaveLength(2);
    expect(msg[0]).toMatchObject({
      template_sid: SID, is_template: true, direction: 'out', sender: 'automazione', twilio_status: 'queued',
    });
    expect(String(msg[0].body)).toContain(`Ciao Mario, link: ${ZOOM}`);
    expect(impostaFaseLancio).toHaveBeenCalledWith(expect.anything(), 1, 'link_inviato', {
      lancio_link_inviato_at: expect.any(String),
    }, { soloDaFasi: ['attesa', 'posto_bloccato'] });
  });

  // La corsa vera: mentre il link e' in volo, il turno dell'attesa (B1) — o il pulsante
  // del webinar — porta avanti la stessa chat. Prima il blast ci scriveva sopra
  // `link_inviato` alla cieca e la fase tornava indietro col link gia' partito.
  it('una fase avanzata durante l invio non torna indietro', async () => {
    stato.convs = [conv(1)];
    sendTemplate.mockImplementationOnce(async () => {
      stato.convs[0].lancio_fase = 'post_pitch';
      return { sid: 'SMtest', status: 'queued' };
    });
    await expect((await richiesta()).json()).resolves.toMatchObject({ sent: 1, failed: 0 });
    expect(stato.convs[0].lancio_fase).toBe('post_pitch');
    // Il timbro invece resta: il messaggio e' partito e non si rimanda.
    expect(stato.timbrate).toEqual(new Set([1]));
    expect(impostaFaseLancio).toHaveBeenCalledWith(expect.anything(), 1, 'link_inviato', expect.anything(), { soloDaFasi: ['attesa', 'posto_bloccato'] });
  });

  it('il timbro si mette PRIMA di Twilio, non dopo', async () => {
    stato.convs = [conv(1)];
    await richiesta();
    // Al momento della chiamata a Twilio la chat era già timbrata: se il run morisse
    // subito dopo, nessun secondo run la riprenderebbe.
    expect(stato.timbrateAllInvio).toEqual([[1]]);
  });

  it('un run gemello non rimanda niente: le chat timbrate non sono più candidate', async () => {
    await richiesta();
    expect(stato.timbrate).toEqual(new Set([1, 2]));
    sendTemplate.mockClear();
    await expect((await richiesta()).json()).resolves.toMatchObject({ candidati: 0, sent: 0 });
    expect(sendTemplate).not.toHaveBeenCalled();
  });

  it('timbro perso sul filo (un altro run se l è preso dopo la select): si salta senza mandare', async () => {
    stato.rubate.add(1);
    stato.convs = [conv(1), conv(2)];
    const res = await (await richiesta()).json();
    expect(sendTemplate).toHaveBeenCalledTimes(1);
    expect(sendTemplate).toHaveBeenCalledWith(expect.objectContaining({ to: tel(2) }));
    expect(res).toMatchObject({ sent: 1, skip: 1 });
  });

  it('già spedito secondo messages.template_sid: si ripara la fase, non si rimanda', async () => {
    stato.spediti = [{ conversation_id: 1 }];
    await expect((await richiesta()).json()).resolves.toMatchObject({ sent: 1, riparati: 1 });
    expect(sendTemplate).toHaveBeenCalledTimes(1);
    expect(sendTemplate).toHaveBeenCalledWith(expect.objectContaining({ to: tel(2) }));
    expect(impostaFaseLancio).toHaveBeenCalledWith(expect.anything(), 1, 'link_inviato', expect.anything(), { soloDaFasi: ['attesa', 'posto_bloccato'] });
  });

  it('lead senza telefono: saltato senza rompere il giro e senza timbro', async () => {
    stato.convs = [conv(9, { leads: null }), conv(2)];
    await expect((await richiesta()).json()).resolves.toMatchObject({ sent: 1, skip: 1 });
    expect(stato.timbrate.has(9)).toBe(false);
  });

  it('errore Twilio comune: riga failed, send_error, timbro liberato per il run dopo', async () => {
    sendTemplate.mockRejectedValueOnce(Object.assign(new Error('giu'), { code: 21211 }));
    await expect((await richiesta()).json()).resolves.toMatchObject({ sent: 1, failed: 1 });
    expect(insertIn('messages').some((m) => m.twilio_status === 'failed' && m.template_sid === SID)).toBe(true);
    expect(tipiEvento()).toContain('send_error');
    expect(timbriTolti()).toHaveLength(1);
    expect(stato.timbrate.has(1)).toBe(false);
  });

  it('63049: nessuna riga messages, timbro liberato, e il blast TIRA DRITTO', async () => {
    // Il frequency cap è del destinatario, non del mittente: fermare 3.000 invii perché
    // un lead è sopra il suo cap sarebbe il freno che si tira da solo sul caso più banale.
    sendTemplate.mockRejectedValueOnce(Object.assign(new Error('cap'), { code: 63049 }));
    const res = await (await richiesta()).json();
    expect(res).toMatchObject({ capped: 1, sent: 1, fermo: null });
    expect(insertIn('messages')).toHaveLength(1);
    expect(tipiEvento()).toContain('lancio_zoom_freq_capped');
    expect(stato.timbrate.has(1)).toBe(false);
    // Nessuno spegne il lancio per un cap: i run dopo devono continuare.
    expect(upserts()).toHaveLength(0);
    expect((eventoRun()?.payload as Record<string, unknown>).codici).toEqual([]);
  });

  it('una valanga di 63049 non ferma comunque il run: contano solo i falliti veri', async () => {
    stato.convs = Array.from({ length: 30 }, (_, i) => conv(i + 1));
    sendTemplate.mockImplementation(async () => {
      throw Object.assign(new Error('cap'), { code: 63049 });
    });
    const res = await (await richiesta()).json();
    expect(res).toMatchObject({ capped: 30, failed: 0, sent: 0, fermo: null });
    expect(upserts()).toHaveLength(0);
  });

  it('Twilio non risponde (errore senza codice): timbro TENUTO e esito incerto', async () => {
    // Il messaggio può essere partito lo stesso: un lead senza link si recupera a mano,
    // un lead con due link sullo stesso numero a qualità LOW no.
    stato.convs = [conv(1)];
    sendTemplate.mockRejectedValueOnce(new Error('socket hang up'));
    const res = await (await richiesta()).json();
    // `incerti` è un contatore suo: gli `errori` sono invii RIUSCITI che non siamo
    // riusciti a registrare, questi sono invii di cui non sappiamo niente.
    expect(res).toMatchObject({ sent: 0, failed: 0, capped: 0, incerti: 1, errori: 0 });
    expect(timbriTolti()).toHaveLength(0);
    expect(stato.timbrate.has(1)).toBe(true);
    expect(tipiEvento()).toContain('lancio_zoom_esito_incerto');
    expect(insertIn('messages')).toHaveLength(0);
  });

  it('claim fallito per un errore del DB: si salta, ma la riga si vede', async () => {
    stato.claimError = { message: 'deadlock detected' };
    const res = await (await richiesta()).json();
    expect(res).toMatchObject({ sent: 0, skip: 2 });
    expect(tipiEvento()).toContain('lancio_zoom_claim_error');
    expect(sendTemplate).not.toHaveBeenCalled();
  });

  it('il presidio UTILITY_ONLY rifiuta il template: run fermo subito, nessuna riga messages', async () => {
    sendTemplate.mockRejectedValue(new Error('template bloccato: categoria MARKETING'));
    const res = await (await richiesta()).json();
    expect(res.fermo).toBe('template_bloccato');
    expect(res.sent).toBe(0);
    expect(insertIn('messages')).toHaveLength(0);
    expect(tipiEvento()).toContain('lancio_zoom_config_error');
    expect(stato.timbrate.size).toBe(0);
  });

  it('un guasto nostro dopo l invio non libera il timbro: il lead ha già il link', async () => {
    stato.messagesInsertKo = true;
    const res = await (await richiesta()).json();
    expect(res.ok).toBe(true);
    expect(res.errori).toBe(2);
    expect(timbriTolti()).toHaveLength(0);
    expect(stato.timbrate).toEqual(new Set([1, 2]));
  });
});

describe('GET /api/cron/lancio-zoom — freno automatico', () => {
  const tanti = (n: number) => Array.from({ length: n }, (_, i) => conv(i + 1));

  it('un run in cui NON arriva niente si ferma al primo blocco: il denominatore sono i tentativi', async () => {
    // Col vecchio conteggio (denominatore = invii riusciti) qui il tasso era 0/0 e il
    // freno non scattava mai: proprio il caso peggiore passava liscio.
    stato.convs = tanti(60);
    sendTemplate.mockImplementation(async () => {
      throw Object.assign(new Error('giu'), { code: 21211 });
    });
    const res = await (await richiesta()).json();
    expect(res).toMatchObject({ sent: 0, fermo: 'freno' });
    expect(res.failed).toBe(25); // un solo blocco da PASSO_FRENO, poi stop
    expect(res.residui).toBe(35);
    expect(upserts()).toContainEqual(expect.objectContaining({ key: 'lancio_attivo', value: false }));
  });

  it('valanga di esiti incerti (rete giù): il freno scatta lo stesso', async () => {
    // Nessun codice Twilio, quindi `codici` resta vuoto e `falliti` pure: senza contare
    // gli incerti il freno guarderebbe un lotto di zeri e direbbe che va tutto bene,
    // mentre il blast sta bruciando 3.000 lead senza consegnarne uno.
    stato.convs = tanti(60);
    sendTemplate.mockImplementation(async () => {
      throw new Error('socket hang up');
    });
    const res = await (await richiesta()).json();
    expect(res).toMatchObject({ sent: 0, failed: 0, fermo: 'freno' });
    expect(res.incerti).toBe(25); // un solo blocco da PASSO_FRENO, poi stop
    expect(res.residui).toBe(35);
    expect(upserts()).toContainEqual(expect.objectContaining({ key: 'lancio_attivo', value: false }));
    // I timbri restano: quei lead NON si ritentano, il messaggio può essere partito.
    expect(timbriTolti()).toHaveLength(0);
    expect(stato.timbrate.size).toBe(25);
    expect(insertIn('messages')).toHaveLength(0);
    const freno = eventi().find((e) => e.type === 'lancio_zoom_freno');
    expect((freno?.payload as Record<string, unknown>).incerti).toBe(25);
  });

  it('la sveglia dei 4 minuti: il run si ferma e scrive il riepilogo invece di morire in timeout', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-05T18:00:00Z'));
    stato.convs = tanti(60);
    // Ogni invio "dura" 20 secondi: il primo blocco da 25 sfonda i 240s.
    sendTemplate.mockImplementation(async () => {
      vi.setSystemTime(Date.now() + 20_000);
      return { sid: 'SMtest', status: 'queued' };
    });
    const res = await (await richiesta()).json();
    expect(res.fermo).toBe('tempo');
    expect(res.sent).toBe(25);
    expect(res.residui).toBe(35);
    // Il riepilogo c'è: è la riga che dice da dove riparte il run dopo.
    expect(eventoRun()).toBeTruthy();
    // La sveglia non è il freno: il lancio resta acceso.
    expect(upserts()).toHaveLength(0);
  });

  it('oltre il 10% di falliti il run si ferma e spegne il lancio per i run dopo', async () => {
    stato.convs = tanti(60);
    let n = 0;
    sendTemplate.mockImplementation(async () => {
      n++;
      if (n % 4 === 0) throw Object.assign(new Error('giu'), { code: 21211 });
      return { sid: 'SMtest', status: 'queued' };
    });
    const res = await (await richiesta()).json();
    expect(res.fermo).toBe('freno');
    // Il freno si valuta a blocchi: non arriva in fondo ai 60 candidati.
    expect(res.sent + res.failed).toBeLessThan(60);
    const freno = eventi().find((e) => e.type === 'lancio_zoom_freno');
    expect(freno?.level).toBe('error');
    expect((freno?.payload as Record<string, unknown>).codici).toContain(21211);
    // Kill-switch: finché un admin non riaccende, i run dopo non partono.
    expect(upserts()).toContainEqual(expect.objectContaining({ key: 'lancio_attivo', value: false }));
  });

  it('qualche fallimento isolato non ferma il blast', async () => {
    stato.convs = tanti(60);
    sendTemplate.mockImplementation(async () => {
      if (sendTemplate.mock.calls.length === 3) throw Object.assign(new Error('giu'), { code: 21211 });
      return { sid: 'SMtest', status: 'queued' };
    });
    const res = await (await richiesta()).json();
    expect(res.fermo).toBeNull();
    expect(res.sent).toBe(59);
    expect(res.failed).toBe(1);
    expect(upserts()).toHaveLength(0);
  });
});

describe('GET /api/cron/lancio-zoom — il run scritto', () => {
  it('i conti tornano: candidati = inviati + riparati + falliti + cap + saltati + residui', async () => {
    vi.stubEnv('LANCIO_BATCH_MAX', '3');
    stato.convs = [conv(1), conv(2), conv(3, { leads: null }), conv(4)];
    sendTemplate.mockRejectedValueOnce(Object.assign(new Error('giu'), { code: 21211 }));
    const res = await (await richiesta()).json();
    const p = eventoRun()?.payload as Record<string, number>;
    expect(p.candidati).toBe(4);
    expect(
      p.inviati + p.riparati + p.capped + p.falliti + p.incerti + p.saltati + p.errori + p.residui,
    ).toBe(4);
    expect(res.candidati).toBe(4);
  });

  it('il run si scrive anche quando non c è niente da mandare', async () => {
    stato.convs = [];
    await expect((await richiesta()).json()).resolves.toMatchObject({ candidati: 0, sent: 0 });
    expect(eventoRun()).toBeTruthy();
  });
});


// Il link Zoom esce dal numero della CHAT (dal 17/09 una conversazione puo' nascere sul
// secondo numero). Ma prima si verifica che il template sia spedibile da quell'account:
// alle 19:30 del 5 ottobre un template che di la' non parte sarebbe il 9% dei lead senza
// il link, e nessuno che se ne accorge fino a serata finita.
describe('GET /api/cron/lancio-zoom — mittente del secondo numero', () => {
  const PRIMARIO = 'whatsapp:+390000000000';
  const SECONDO = 'whatsapp:+393522070047';

  beforeEach(() => {
    vi.stubEnv('TWILIO_WHATSAPP_NUMBER_FENICE_2', SECONDO);
  });

  it('chat nata sul numero nuovo: il link parte da li', async () => {
    stato.convs = [conv(1, { wa_number: SECONDO })];
    await richiesta();
    expect(sendTemplate).toHaveBeenCalledTimes(1);
    expect(sendTemplate.mock.calls[0][0]).toMatchObject({ from: SECONDO });
    expect(tipiEvento()).not.toContain('lancio_mittente_ripiego');
  });

  it('template non spedibile da quel numero: il link parte dal numero storico, non si perde', async () => {
    stato.convs = [conv(1, { wa_number: SECONDO })];
    assertTemplateSendable.mockRejectedValue(
      new Error('template bloccato: categoria MARKETING con UTILITY_ONLY attivo.'),
    );
    const res = await (await richiesta()).json();

    expect(sendTemplate).toHaveBeenCalledTimes(1);
    expect(sendTemplate.mock.calls[0][0]).toMatchObject({ from: PRIMARIO });
    expect(res).toMatchObject({ sent: 1, fermo: null });

    const ripiego = eventi().find((e) => e.type === 'lancio_mittente_ripiego');
    expect(ripiego).toBeTruthy();
    expect(ripiego!.level).toBe('warn');
    // Quale cron, quale conversazione, quale SID: la serata si legge in dieci secondi.
    expect(ripiego!.payload).toMatchObject({
      origine: 'lancio_zoom', conversationId: 1, numero: SECONDO, templateSid: SID,
      motivo: 'template_bloccato',
    });
  });

  it('il ripiego di una chat non ferma il blast delle altre', async () => {
    stato.convs = [conv(1, { wa_number: SECONDO }), conv(2), conv(3)];
    assertTemplateSendable.mockRejectedValue(new Error('bloccato su questo account'));
    const res = await (await richiesta()).json();
    expect(res).toMatchObject({ sent: 3, fermo: null });
    expect(sendTemplate.mock.calls.every((c) => c[0].from === PRIMARIO)).toBe(true);
    expect(eventi().filter((e) => e.type === 'lancio_mittente_ripiego')).toHaveLength(1);
  });

  it('chat sul numero storico: nessuna verifica in piu, come prima', async () => {
    stato.convs = [conv(1), conv(2, { wa_number: PRIMARIO })];
    await richiesta();
    expect(assertTemplateSendable).not.toHaveBeenCalled();
    expect(sendTemplate.mock.calls.every((c) => c[0].from === PRIMARIO)).toBe(true);
  });
});
