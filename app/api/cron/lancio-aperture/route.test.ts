import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─────────────────────────── finto Supabase ───────────────────────────
// Registra ogni chiamata (tabella, operazione, payload, filtri) così i test possono
// interrogare anche quello che NON è stato scritto: "nessuna riga messages sul
// frequency cap" e "un solo invio per numero" sono asserzioni sul secondo.
//
// `conversations.lancio_benvenuto_at` è finto per davvero — l'update con
// `.is('lancio_benvenuto_at', null)` restituisce righe solo la prima volta — perché il
// lucchetto contro il doppio invio è tutto lì: se il compare-and-set non fosse
// simulato, il test lo vedrebbe funzionare anche se il route non lo usasse.

type Filtro = [string, unknown];
type Chiamata = { table: string; op: 'select' | 'insert' | 'update'; arg: unknown; filtri: Filtro[]; opzioni?: { head?: boolean } };
const chiamate: Chiamata[] = [];

type ConvFinta = {
  id: number;
  crm_lead_id: string | null;
  /** Il numero con cui la chat e' nata: il benvenuto differito deve uscire di li'. */
  wa_number?: string | null;
  lancio_fase: string | null;
  lancio_benvenuto_at: string | null;
  last_inbound_at: string | null;
  leads: { phone_e164: string | null; first_name: string | null } | null;
};
type OutFinto = {
  conversation_id?: number;
  template_sid: string | null;
  twilio_status: string | null;
  twilio_error_code: number | null;
  created_at: string | null;
};

const stato = {
  convs: [] as ConvFinta[],
  outbound: new Map<number, OutFinto[]>(),
  attivo: '1' as string,
  /** `lancio_evento_at`: serve all'allarme sulla data rimasta indietro. */
  eventoAt: null as string | null,
  /** Chat già timbrate: l'update del claim non le restituisce. */
  timbrate: new Set<number>(),
  /** Il VALORE del timbro, per conv: il rilascio è ancorato a quello che ha scritto
   *  questo run (`.eq('lancio_benvenuto_at', timbro)`), non al solo id. */
  timbri: new Map<number, string>(),
  /** L'insert della riga `messages` fallisce: serve a provare che un invio già partito
   *  non fa liberare il timbro. */
  messagesInsertKo: false,
  /** La select dei candidati fallisce (migrazione non applicata). */
  convSelectError: null as { message: string; code?: string } | null,
  /** Benvenuti gia' partiti nell'ultima ora: il numeratore del tetto orario. */
  benvenutiUltimaOra: 0,
  /** Il conteggio del tetto orario fallisce: il run deve fermarsi, non tirare dritto. */
  conteggioError: null as { message: string } | null,
};

const valore = (rec: Chiamata, colonna: string) => rec.filtri.find(([c]) => c === colonna)?.[1];

function esegui(rec: Chiamata): { data: unknown; error: unknown; count?: number } {
  if (rec.table === 'conversations' && rec.op === 'update') {
    const campi = rec.arg as Record<string, unknown>;
    const id = Number(valore(rec, 'id'));
    if (!('lancio_benvenuto_at' in campi)) return { data: [], error: null };
    if (campi.lancio_benvenuto_at === null) {
      // Rilascio ancorato: si libera solo il timbro scritto da questo run.
      const atteso = valore(rec, 'lancio_benvenuto_at');
      if (atteso === undefined || stato.timbri.get(id) === atteso) {
        stato.timbrate.delete(id);
        stato.timbri.delete(id);
      }
      return { data: [], error: null };
    }
    // Claim: `is('lancio_benvenuto_at', null)` è un compare-and-set.
    if (stato.timbrate.has(id)) return { data: [], error: null };
    stato.timbrate.add(id);
    stato.timbri.set(id, String(campi.lancio_benvenuto_at));
    return { data: [{ id }], error: null };
  }
  if (rec.table === 'messages' && rec.op === 'insert' && stato.messagesInsertKo) {
    throw new Error('insert messages KO');
  }
  if (rec.op !== 'select') return { data: null, error: null };
  if (rec.table === 'app_settings') {
    const righe: { key: string; value: unknown }[] = [{ key: 'lancio_attivo', value: stato.attivo }];
    if (stato.eventoAt !== null) righe.push({ key: 'lancio_evento_at', value: stato.eventoAt });
    return { data: righe, error: null };
  }
  if (rec.table === 'conversations') {
    if (stato.convSelectError) return { data: null, error: stato.convSelectError };
    // La paginazione del route: la seconda pagina è sempre vuota (fixture piccole).
    const pagina = (valore(rec, '__range') as number[] | undefined) ?? [0, 999];
    const liberi = stato.convs.filter((c) => !stato.timbrate.has(c.id));
    return { data: liberi.slice(pagina[0], pagina[1] + 1), error: null };
  }
  if (rec.table === 'messages') {
    // `head: true` = la query di conteggio del tetto orario: nessuna riga, un numero.
    if (rec.opzioni?.head) {
      if (stato.conteggioError) return { data: null, error: stato.conteggioError };
      return { data: null, error: null, count: stato.benvenutiUltimaOra };
    }
    const ids = (valore(rec, '__in') as number[] | undefined) ?? [];
    const righe = ids.flatMap((id) =>
      (stato.outbound.get(id) ?? []).map((r) => ({ ...r, conversation_id: id })),
    );
    return { data: righe, error: null };
  }
  return { data: [], error: null };
}

function query(table: string, op: Chiamata['op'], arg: unknown, opzioni?: { head?: boolean }) {
  const rec: Chiamata = { table, op, arg, filtri: [], opzioni };
  chiamate.push(rec);
  const q: Record<string, unknown> = {};
  for (const m of ['is', 'or', 'gte', 'lte', 'not', 'order', 'limit', 'single', 'maybeSingle', 'select', 'contains']) {
    q[m] = () => q;
  }
  q.eq = (colonna: string, v: unknown) => { rec.filtri.push([colonna, v]); return q; };
  q.in = (_c: string, v: unknown) => { rec.filtri.push(['__in', v]); return q; };
  q.range = (a: number, b: number) => { rec.filtri.push(['__range', [a, b]]); return q; };
  q.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) =>
    Promise.resolve(esegui(rec)).then(ok, ko);
  return q;
}

vi.mock('@/lib/supabase/admin', () => ({
  getSupabaseAdmin: () => ({
    from: (table: string) => ({
      select: (s: string, opzioni?: { head?: boolean }) => query(table, 'select', s, opzioni),
      insert: (r: unknown) => query(table, 'insert', r),
      update: (r: unknown) => query(table, 'update', r),
    }),
  }),
}));

// ─────────────────────────── finto Twilio ───────────────────────────
const sendTemplate = vi.fn();
const assertTemplateSendable = vi.fn();
vi.mock('@/lib/twilio', () => ({
  sendTemplate: (...a: unknown[]) => sendTemplate(...a),
  assertTemplateSendable: (...a: unknown[]) => assertTemplateSendable(...a),
  getTemplateBody: async () => null,
}));

import { GET } from './route';

const SEGRETO = 'segreto-di-test';
const WELCOME = 'HXbenvenuto';
const ADESSO = new Date('2026-09-20T10:00:00Z'); // 12:00 Roma, in fascia
const NOTTE = new Date('2026-09-20T01:00:00Z'); // 03:00 Roma
const H = 3600_000;
const G = 24 * H;

const richiesta = (secret: string | null = SEGRETO) =>
  GET({
    headers: new Headers(secret ? { authorization: `Bearer ${secret}` } : {}),
    nextUrl: new URL('https://x/api/cron/lancio-aperture'),
  } as never);

/** Un numero per conversazione, formato E.164 italiano. */
const tel = (id: number) => `+39333000${String(id).padStart(4, '0')}`;

const conv = (id: number, extra: Partial<ConvFinta> = {}): ConvFinta => ({
  id,
  crm_lead_id: `crm-${id}`,
  wa_number: null,
  lancio_fase: 'attesa',
  lancio_benvenuto_at: null,
  last_inbound_at: null,
  leads: { phone_e164: tel(id), first_name: 'mario rossi' },
  ...extra,
});

const insertIn = (table: string) =>
  chiamate
    .filter((c) => c.table === table && c.op === 'insert')
    .map((c) => c.arg as Record<string, unknown>);
const eventi = () => insertIn('event_log');
const tipiEvento = () => eventi().map((e) => e.type);
const eventoRun = () => eventi().find((e) => e.type === 'lancio_aperture_run');
const selectSu = (table: string) => chiamate.filter((c) => c.table === table && c.op === 'select');
const timbriTolti = () =>
  chiamate.filter(
    (c) =>
      c.table === 'conversations' &&
      c.op === 'update' &&
      (c.arg as Record<string, unknown>).lancio_benvenuto_at === null,
  );

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(ADESSO);
  chiamate.length = 0;
  stato.convs = [];
  stato.outbound = new Map();
  stato.attivo = '1';
  stato.eventoAt = null;
  stato.timbrate = new Set();
  stato.timbri = new Map();
  stato.messagesInsertKo = false;
  stato.convSelectError = null;
  stato.benvenutiUltimaOra = 0;
  stato.conteggioError = null;
  sendTemplate.mockReset();
  sendTemplate.mockResolvedValue({ sid: 'SMtest', status: 'queued' });
  assertTemplateSendable.mockReset();
  assertTemplateSendable.mockResolvedValue(undefined);
  process.env.CRON_SECRET = SEGRETO;
  process.env.LANCIO_WELCOME_TEMPLATE_SID = WELCOME;
  process.env.TWILIO_WHATSAPP_NUMBER_FENICE = 'whatsapp:+390000000';
  delete process.env.LANCIO_APERTURE_MAX_PER_RUN;
  delete process.env.LANCIO_WELCOME_MAX_PER_HOUR;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('GET /api/cron/lancio-aperture', () => {
  it('senza segreto non si entra', async () => {
    const res = await richiesta(null);
    expect(res.status).toBe(401);
    expect(sendTemplate).not.toHaveBeenCalled();
  });

  // `lancio_evento_at` rimasto indietro: tutte le finestre del lancio si derivano da
  // quella data, e senza questo allarme i cron escono "fuori_finestra" a livello info.
  it('lancio_evento_at nel passato: evento error, e il run continua', async () => {
    stato.eventoAt = '2026-09-17T21:00:00+02:00';
    stato.convs = [conv(1)];
    await richiesta();
    const allarme = eventi().find((e) => e.type === 'lancio_evento_at_nel_passato');
    expect(allarme?.level).toBe('error');
    expect(allarme?.payload).toMatchObject({ cron: 'lancio-aperture', evento_giorno: '2026-09-17', oggi: '2026-09-20' });
    // Non blocca: il benvenuto parte lo stesso.
    expect(sendTemplate).toHaveBeenCalledTimes(1);
  });

  it('data dell evento nel futuro: nessun allarme', async () => {
    stato.eventoAt = '2026-10-05T21:00:00+02:00';
    stato.convs = [conv(1)];
    await richiesta();
    expect(tipiEvento()).not.toContain('lancio_evento_at_nel_passato');
  });

  it('lancio spento: l allarme non suona (il cron gira tutto l anno ogni 15 minuti)', async () => {
    stato.attivo = '0';
    stato.eventoAt = '2026-09-17T21:00:00+02:00';
    await richiesta();
    expect(tipiEvento()).not.toContain('lancio_evento_at_nel_passato');
  });

  it('manda il benvenuto alle chat in attesa e lascia traccia', async () => {
    stato.convs = [conv(1), conv(2)];
    const res = await richiesta();
    const body = await res.json();

    expect(sendTemplate).toHaveBeenCalledTimes(2);
    expect(sendTemplate.mock.calls[0][0]).toMatchObject({
      to: tel(1),
      contentSid: WELCOME,
      variables: { '1': 'Mario' },
    });
    const righe = insertIn('messages');
    expect(righe).toHaveLength(2);
    expect(righe[0]).toMatchObject({
      direction: 'out',
      template_sid: WELCOME,
      twilio_sid: 'SMtest',
      is_template: true,
      sender: 'automazione',
    });
    expect(String(righe[0].body)).toContain('5 ottobre');
    expect(tipiEvento().filter((t) => t === 'lancio_apertura_inviata')).toHaveLength(2);
    expect(body).toMatchObject({ ok: true, inviati: 2, candidati: 2 });
  });

  it('il timbro si mette PRIMA dell’invio e non si toglie se parte', async () => {
    stato.convs = [conv(1)];
    await richiesta();
    const claim = chiamate.findIndex(
      (c) => c.table === 'conversations' && c.op === 'update' && (c.arg as Record<string, unknown>).lancio_benvenuto_at,
    );
    const inserimento = chiamate.findIndex((c) => c.table === 'messages' && c.op === 'insert');
    expect(claim).toBeGreaterThanOrEqual(0);
    expect(claim).toBeLessThan(inserimento);
    expect(timbriTolti()).toHaveLength(0);
    expect(stato.timbrate.has(1)).toBe(true);
  });

  it('una chat gia’ timbrata non e’ nemmeno candidata (la coda non si intasa)', async () => {
    stato.convs = [conv(1), conv(2)];
    stato.timbrate.add(1);
    const body = await (await richiesta()).json();
    expect(body.candidati).toBe(1);
    expect(sendTemplate).toHaveBeenCalledTimes(1);
    expect(sendTemplate.mock.calls[0][0]).toMatchObject({ to: tel(2) });
  });

  it('se un altro run se l’e’ presa mentre leggevamo, si passa oltre', async () => {
    stato.convs = [conv(1), conv(2)];
    // La select aveva già restituito la conv 1, poi l'altro run l'ha timbrata: il
    // compare-and-set non torna righe e il benvenuto non parte due volte.
    stato.timbrate.add(1);
    stato.convs = [conv(1), conv(2)];
    const body = await (await richiesta()).json();
    expect(sendTemplate).toHaveBeenCalledTimes(1);
    expect(body.inviati).toBe(1);
  });

  it('il tetto per run ferma gli invii, non li perde', async () => {
    process.env.LANCIO_APERTURE_MAX_PER_RUN = '2';
    stato.convs = [conv(1), conv(2), conv(3)];
    const body = await (await richiesta()).json();
    expect(sendTemplate).toHaveBeenCalledTimes(2);
    expect(body.inviati).toBe(2);
  });

  // Spec §11.3: il tetto è dello stesso numero WhatsApp, quindi questo cron non può
  // essere la scorciatoia per rifare il picco che il tetto dell'intake ha appena evitato.
  it('tetto orario già raggiunto: run fermo prima ancora di leggere i candidati', async () => {
    process.env.LANCIO_WELCOME_MAX_PER_HOUR = '200';
    stato.benvenutiUltimaOra = 200;
    stato.convs = [conv(1), conv(2)];
    const body = await (await richiesta()).json();

    expect(sendTemplate).not.toHaveBeenCalled();
    expect(selectSu('conversations')).toHaveLength(0);
    expect(eventoRun()).toMatchObject({
      type: 'lancio_aperture_run',
      level: 'warn',
      payload: { fermo: 'tetto_orario', inviatiUltimaOra: 200, tetto: 200, inviati: 0 },
    });
    expect(body).toMatchObject({ ok: true, inviati: 0, fermo: 'tetto_orario' });
  });

  // Fail CLOSED (ruling della review T13): il tetto che non si legge ferma il run. La
  // coda non si perde, il cron ripassa fra 15 minuti.
  it('conteggio del tetto illeggibile: run fermo, nessun invio alla cieca', async () => {
    stato.conteggioError = { message: 'timeout' };
    stato.convs = [conv(1), conv(2)];
    const body = await (await richiesta()).json();

    expect(sendTemplate).not.toHaveBeenCalled();
    expect(selectSu('conversations')).toHaveLength(0);
    expect(tipiEvento()).toContain('lancio_tetto_non_letto');
    expect(eventoRun()).toMatchObject({
      type: 'lancio_aperture_run',
      level: 'warn',
      payload: { fermo: 'tetto_non_leggibile', inviati: 0 },
    });
    expect(body).toMatchObject({ ok: true, inviati: 0, fermo: 'tetto_non_leggibile' });
  });

  it('il tetto vale anche DENTRO il run: si ferma quando lo raggiunge, non a fine lotto', async () => {
    process.env.LANCIO_WELCOME_MAX_PER_HOUR = '200';
    stato.benvenutiUltimaOra = 198; // due di spazio
    stato.convs = [conv(1), conv(2), conv(3), conv(4)];
    const body = await (await richiesta()).json();

    expect(sendTemplate).toHaveBeenCalledTimes(2);
    expect(body).toMatchObject({ inviati: 2, fermo: 'tetto_orario', candidati: 4 });
    // Le chat non servite non sono state timbrate: il run dopo le ritrova candidate.
    expect(stato.timbrate.has(3)).toBe(false);
    expect(stato.timbrate.has(4)).toBe(false);
  });

  it('env spazzatura → tetto di default 200 (199 partiti: uno passa)', async () => {
    process.env.LANCIO_WELCOME_MAX_PER_HOUR = 'boh';
    stato.benvenutiUltimaOra = 199;
    stato.convs = [conv(1), conv(2)];
    const body = await (await richiesta()).json();
    expect(sendTemplate).toHaveBeenCalledTimes(1);
    expect(body).toMatchObject({ inviati: 1, fermo: 'tetto_orario', tetto: 200 });
  });

  it('un numero, un benvenuto: due chat sullo stesso telefono non si sommano', async () => {
    stato.convs = [conv(1), conv(2, { leads: { phone_e164: tel(1), first_name: 'Anna' } })];
    const body = await (await richiesta()).json();
    expect(sendTemplate).toHaveBeenCalledTimes(1);
    expect(body.inviati).toBe(1);
  });

  it('frequency cap Meta: nessuna riga, timbro tolto, si ritenta al run dopo', async () => {
    stato.convs = [conv(1)];
    sendTemplate.mockRejectedValueOnce(Object.assign(new Error('frequency cap'), { code: 63049 }));
    const body = await (await richiesta()).json();
    expect(insertIn('messages')).toHaveLength(0);
    expect(tipiEvento()).toContain('lancio_apertura_freq_capped');
    expect(timbriTolti()).toHaveLength(1);
    expect(stato.timbrate.has(1)).toBe(false);
    expect(body).toMatchObject({ capped: 1, inviati: 0 });
  });

  it('un invio fallito lascia la riga fallita e libera il timbro (il prossimo run ritenta)', async () => {
    stato.convs = [conv(1)];
    sendTemplate.mockRejectedValueOnce(Object.assign(new Error('numero morto'), { code: 63024 }));
    const body = await (await richiesta()).json();
    expect(insertIn('messages')[0]).toMatchObject({ twilio_status: 'failed', twilio_error_code: 63024 });
    expect(tipiEvento()).toContain('send_error');
    expect(stato.timbrate.has(1)).toBe(false);
    expect(body).toMatchObject({ falliti: 1, inviati: 0 });
  });

  it('il presidio template ferma tutto il run, senza righe e senza consumare budget', async () => {
    stato.convs = [conv(1), conv(2), conv(3)];
    sendTemplate.mockRejectedValue(
      new Error(`template ${WELCOME} bloccato: categoria MARKETING con UTILITY_ONLY attivo.`),
    );
    const body = await (await richiesta()).json();
    expect(sendTemplate).toHaveBeenCalledTimes(1);
    expect(insertIn('messages')).toHaveLength(0);
    expect(tipiEvento().filter((t) => t === 'lancio_aperture_config_error')).toHaveLength(1);
    expect(stato.timbrate.size).toBe(0);
    expect(body).toMatchObject({ inviati: 0, falliti: 0, fermo: 'template_bloccato' });
  });

  it('lancio spento: si esce prima di leggere le conversazioni', async () => {
    stato.attivo = '0';
    stato.convs = [conv(1)];
    const body = await (await richiesta()).json();
    expect(sendTemplate).not.toHaveBeenCalled();
    expect(selectSu('conversations')).toHaveLength(0);
    expect(eventoRun()).toMatchObject({ type: 'lancio_aperture_run' });
    expect(body).toMatchObject({ inviati: 0, motivo: 'lancio_spento', attivo: false });
  });

  it('di notte si esce subito, senza leggere niente', async () => {
    vi.setSystemTime(NOTTE);
    stato.convs = [conv(1)];
    const body = await (await richiesta()).json();
    expect(selectSu('conversations')).toHaveLength(0);
    expect(body).toMatchObject({ inviati: 0, motivo: 'fuori_fascia' });
  });

  it("l'apertura di Mario di un'ora fa blocca il benvenuto, quella di ieri no", async () => {
    stato.convs = [conv(1), conv(2)];
    stato.outbound.set(1, [
      { template_sid: 'HXapertura', twilio_status: 'delivered', twilio_error_code: null, created_at: new Date(ADESSO.getTime() - 1 * H).toISOString() },
    ]);
    stato.outbound.set(2, [
      { template_sid: 'HXapertura', twilio_status: 'delivered', twilio_error_code: null, created_at: new Date(ADESSO.getTime() - 13 * H).toISOString() },
    ]);
    const body = await (await richiesta()).json();
    expect(sendTemplate).toHaveBeenCalledTimes(1);
    expect(sendTemplate.mock.calls[0][0]).toMatchObject({ to: tel(2) });
    expect(body).toMatchObject({ inviati: 1, attesi: 1 });
  });

  it('una chat viva (inbound di 2 giorni fa) aspetta; a 8 giorni il benvenuto parte', async () => {
    stato.convs = [
      conv(1, { last_inbound_at: new Date(ADESSO.getTime() - 2 * G).toISOString() }),
      conv(2, { last_inbound_at: new Date(ADESSO.getTime() - 8 * G).toISOString() }),
    ];
    const body = await (await richiesta()).json();
    expect(sendTemplate).toHaveBeenCalledTimes(1);
    expect(sendTemplate.mock.calls[0][0]).toMatchObject({ to: tel(2) });
    expect(body).toMatchObject({ inviati: 1, attesi: 1 });
  });

  it('un benvenuto riuscito non si ripete; tre falliti si lasciano stare', async () => {
    const vecchio = new Date(ADESSO.getTime() - 20 * H).toISOString();
    stato.convs = [conv(1), conv(2)];
    stato.outbound.set(1, [
      { template_sid: WELCOME, twilio_status: 'delivered', twilio_error_code: null, created_at: vecchio },
    ]);
    stato.outbound.set(2, [
      { template_sid: WELCOME, twilio_status: 'failed', twilio_error_code: 63024, created_at: vecchio },
      { template_sid: WELCOME, twilio_status: 'failed', twilio_error_code: 63024, created_at: vecchio },
      { template_sid: WELCOME, twilio_status: 'undelivered', twilio_error_code: 63024, created_at: vecchio },
    ]);
    const body = await (await richiesta()).json();
    expect(sendTemplate).not.toHaveBeenCalled();
    expect(body).toMatchObject({ inviati: 0, saltati: 2 });
  });

  it('due falliti si ritentano ancora, e un frequency cap non conta come fallimento', async () => {
    const vecchio = new Date(ADESSO.getTime() - 20 * H).toISOString();
    stato.convs = [conv(1), conv(2)];
    stato.outbound.set(1, [
      { template_sid: WELCOME, twilio_status: 'failed', twilio_error_code: 63024, created_at: vecchio },
      { template_sid: WELCOME, twilio_status: 'failed', twilio_error_code: 63024, created_at: vecchio },
    ]);
    stato.outbound.set(2, [
      { template_sid: WELCOME, twilio_status: 'failed', twilio_error_code: 63049, created_at: vecchio },
      { template_sid: WELCOME, twilio_status: 'failed', twilio_error_code: 63049, created_at: vecchio },
      { template_sid: WELCOME, twilio_status: 'failed', twilio_error_code: 63049, created_at: vecchio },
    ]);
    const body = await (await richiesta()).json();
    expect(sendTemplate).toHaveBeenCalledTimes(2);
    expect(body.inviati).toBe(2);
  });

  it('una sola query messages per lotto, non una per conversazione', async () => {
    stato.convs = [conv(1), conv(2), conv(3)];
    await richiesta();
    // Il conteggio del tetto orario (`head: true`) è una query sola per run, non per
    // lotto: qui si contano solo le letture di righe.
    expect(selectSu('messages').filter((c) => !c.opzioni?.head)).toHaveLength(1);
    expect(selectSu('messages').filter((c) => c.opzioni?.head)).toHaveLength(1);
  });

  it('senza telefono non si manda niente', async () => {
    stato.convs = [conv(1, { leads: { phone_e164: null, first_name: 'Anna' } })];
    const body = await (await richiesta()).json();
    expect(sendTemplate).not.toHaveBeenCalled();
    expect(body.saltati).toBe(1);
  });

  it('env mancanti: run saltato e detto a voce alta', async () => {
    delete process.env.LANCIO_WELCOME_TEMPLATE_SID;
    stato.convs = [conv(1)];
    const body = await (await richiesta()).json();
    expect(sendTemplate).not.toHaveBeenCalled();
    expect(tipiEvento()).toContain('lancio_aperture_config_error');
    expect(body).toMatchObject({ ok: true, skipped: 'config' });
  });

  it('anche a mani vuote il run si scrive: un cron inceppato deve vedersi', async () => {
    stato.convs = [];
    await richiesta();
    expect(eventoRun()).toMatchObject({
      type: 'lancio_aperture_run',
      payload: { candidati: 0, inviati: 0 },
    });
  });

  // Il messaggio è già su WhatsApp: qualunque cosa fallisca dopo, liberare il timbro
  // rimetterebbe la chat fra i candidati e il run successivo manderebbe il benvenuto una
  // seconda volta alla stessa persona.
  it('se salta la scrittura DOPO un invio riuscito il timbro resta: nessun secondo invio', async () => {
    stato.convs = [conv(1)];
    stato.messagesInsertKo = true;
    const body = await (await richiesta()).json();

    expect(sendTemplate).toHaveBeenCalledTimes(1);
    expect(timbriTolti()).toHaveLength(0);
    expect(stato.timbrate.has(1)).toBe(true);
    expect(tipiEvento()).toContain('lancio_apertura_meta_incompleta');
    expect(body).toMatchObject({ inviati: 0, falliti: 0, errori: 1 });

    // Run successivo, col guasto passato: la chat non è nemmeno più candidata.
    chiamate.length = 0;
    stato.messagesInsertKo = false;
    const body2 = await (await richiesta()).json();
    expect(sendTemplate).toHaveBeenCalledTimes(1);
    expect(body2).toMatchObject({ candidati: 0, inviati: 0 });
  });

  it('il rilascio del timbro è ancorato a quello scritto da questo run', async () => {
    stato.convs = [conv(1)];
    sendTemplate.mockRejectedValueOnce(Object.assign(new Error('numero morto'), { code: 63024 }));
    await richiesta();
    const rilascio = timbriTolti()[0];
    expect(rilascio.filtri).toContainEqual(['lancio_benvenuto_at', expect.any(String)]);
  });

  // Con le colonne `lancio_*` non ancora applicate la select torna `data: null`: zero
  // candidati, `ok: true`, identico a una coda vuota.
  it('una query candidati fallita si vede: riga di errore, niente invii', async () => {
    const spia = vi.spyOn(console, 'error').mockImplementation(() => {});
    stato.convs = [conv(1)];
    stato.convSelectError = { message: 'column conversations.lancio_slug does not exist', code: '42703' };
    const body = await (await richiesta()).json();
    expect(sendTemplate).not.toHaveBeenCalled();
    expect(tipiEvento()).toContain('lancio_aperture_query_error');
    expect(body).toMatchObject({ ok: true, candidati: 0, inviati: 0 });
    expect(spia).toHaveBeenCalled();
    spia.mockRestore();
  });
});

// Il benvenuto differito esce dal numero della CHAT. Ma prima si verifica che il
// template sia davvero spedibile da quel numero: i Content template vivono dentro un
// account Twilio, e una copia che di la' non esiste (o che `UTILITY_ONLY` rifiuta) e'
// una riga `failed` senza SID e un lead che non riceve niente.
describe('GET /api/cron/lancio-aperture — mittente del secondo numero', () => {
  const PRIMARIO = 'whatsapp:+390000000';
  const SECONDO = 'whatsapp:+393522070047';

  beforeEach(() => {
    process.env.TWILIO_WHATSAPP_NUMBER_FENICE_2 = SECONDO;
  });
  afterEach(() => {
    delete process.env.TWILIO_WHATSAPP_NUMBER_FENICE_2;
  });

  it('chat nata sul numero nuovo: il benvenuto parte da li, non dal numero del run', async () => {
    stato.convs = [conv(1, { wa_number: SECONDO })];
    await richiesta();
    expect(sendTemplate).toHaveBeenCalledTimes(1);
    expect(sendTemplate.mock.calls[0][0]).toMatchObject({ from: SECONDO });
    expect(tipiEvento()).not.toContain('lancio_mittente_ripiego');
  });

  it('template bloccato su quel numero: parte dal numero storico e resta scritto', async () => {
    stato.convs = [conv(1, { wa_number: SECONDO })];
    assertTemplateSendable.mockRejectedValue(
      new Error('template bloccato: categoria MARKETING con UTILITY_ONLY attivo.'),
    );
    const res = await richiesta();

    // Il messaggio parte comunque: meglio dal numero sbagliato che mai.
    expect(sendTemplate).toHaveBeenCalledTimes(1);
    expect(sendTemplate.mock.calls[0][0]).toMatchObject({ from: PRIMARIO });
    expect(await res.json()).toMatchObject({ inviati: 1, fermo: null });

    const ripiego = eventi().find((e) => e.type === 'lancio_mittente_ripiego');
    expect(ripiego).toBeTruthy();
    expect(ripiego!.level).toBe('warn');
    expect(ripiego!.payload).toMatchObject({
      conversationId: 1, motivo: 'template_bloccato', numero: SECONDO, origine: 'lancio-aperture',
    });
  });

  it('il ripiego di una chat non ferma la coda delle altre', async () => {
    stato.convs = [conv(1, { wa_number: SECONDO }), conv(2), conv(3)];
    assertTemplateSendable.mockImplementation(async (_sid: unknown, from: unknown) => {
      if (from === SECONDO) throw new Error('template bloccato su questo account');
    });
    const res = await richiesta();
    expect(await res.json()).toMatchObject({ inviati: 3, fermo: null });
    expect(sendTemplate.mock.calls.every((c) => c[0].from === PRIMARIO)).toBe(true);
  });

  it('chat sul numero storico: nessuna verifica in piu, come prima', async () => {
    stato.convs = [conv(1), conv(2, { wa_number: PRIMARIO })];
    await richiesta();
    expect(sendTemplate).toHaveBeenCalledTimes(2);
    expect(sendTemplate.mock.calls.every((c) => c[0].from === PRIMARIO)).toBe(true);
    expect(tipiEvento()).not.toContain('lancio_mittente_ripiego');
  });
});
