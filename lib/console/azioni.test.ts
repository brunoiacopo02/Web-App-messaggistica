import { describe, it, expect, vi, beforeEach } from 'vitest';
import { clienteFinto, type Scrittura } from './__finti__/cliente';

const sendOutcome = vi.fn();
vi.mock('@/lib/bot-outcome', () => ({ sendOutcome: (...a: unknown[]) => sendOutcome(...a) }));
const perimetro = { dentro: true };
vi.mock('@/lib/chat-perimetro', () => ({ isConversazioneChat: async () => perimetro.dentro }));

const { anteprima, esegui, PARAMS, canonico } = await import('./azioni');

const chiamate: { url: string; init: RequestInit }[] = [];
const finto = (risposte: Record<string, unknown>) => (async (url: string, init: RequestInit) => {
  chiamate.push({ url, init });
  const corpo = JSON.parse(String(init.body ?? '{}'));
  return new Response(JSON.stringify(risposte[corpo.esegui ? 'si' : 'no']), { status: 200 });
}) as unknown as typeof fetch;
let cliente = clienteFinto();
const soloTipo = (sc: Scrittura[], tipo: string) => sc.filter((x) => x.riga.type === tipo);
beforeEach(() => {
  chiamate.length = 0; cliente = clienteFinto(); process.env.CRON_SECRET = 'x';
  sendOutcome.mockReset(); perimetro.dentro = true;
});

// --- I test del brief, sul client finto con event_log in memoria ---

it('l\'anteprima non esegue', async () => {
  const f = finto({ no: { ok: true, candidate: 38, esempi: ['conv 1'] }, si: { ok: true, inviate: 38, fallite: 0 } });
  const a = await anteprima('rinvia_esiti_403', {}, { s: cliente.s, origin: 'https://x', email: 'admin@fenice.com', now: new Date(), fetch: f });
  expect(a.conteggio).toBe(38);
  expect(JSON.parse(String(chiamate[0].init.body)).esegui).toBe(false);
  expect(cliente.scritture).toHaveLength(0);
});
it('esegui una volta sola e registra', async () => {
  const f = finto({ no: { ok: true, candidate: 38, esempi: [] }, si: { ok: true, inviate: 36, fallite: 2 } });
  const ctx = { s: cliente.s, origin: 'https://x', email: 'admin@fenice.com', now: new Date(), fetch: f };
  const a = await anteprima('rinvia_esiti_403', {}, ctx);
  const e = await esegui(a.token, ctx);
  expect(e).toMatchObject({ ok: true, fatti: 36, falliti: 2 });
  expect(soloTipo(cliente.scritture, 'console_azione')).toHaveLength(1);
  await expect(esegui(a.token, ctx)).rejects.toThrow('gia_eseguita');
  expect(chiamate.filter((x) => JSON.parse(String(x.init.body)).esegui === true)).toHaveLength(1);
  expect(soloTipo(cliente.scritture, 'console_azione')).toHaveLength(1);
});
it('token sconosciuto', async () => {
  await expect(esegui('nope', { s: cliente.s, origin: 'https://x', email: 'a', now: new Date() })).rejects.toThrow('anteprima_scaduta');
});
it('conteggio cambiato oltre il 20%', async () => {
  let giro = 0;
  const f = (async (_u: string, init: RequestInit) => {
    const c = JSON.parse(String(init.body)); giro++;
    return new Response(JSON.stringify(c.esegui ? { ok: true, inviate: 1, fallite: 0 } : { ok: true, candidate: giro === 1 ? 10 : 50, esempi: [] }));
  }) as unknown as typeof fetch;
  const ctx = { s: cliente.s, origin: 'https://x', email: 'a', now: new Date(), fetch: f };
  const a = await anteprima('rinvia_esiti_403', {}, ctx);
  await expect(esegui(a.token, ctx)).rejects.toThrow('conteggio_cambiato');
});
it('parametri non validi', async () => {
  await expect(anteprima('rilancia_cron', { cron: 'rm -rf' }, { s: cliente.s, origin: 'https://x', email: 'a', now: new Date() })).rejects.toThrow();
});

// --- Oltre il brief ---

const ADESSO = '2026-09-30T10:00:00.000Z';
const ctxCon = (c: { s: never }, f?: typeof fetch, now = new Date(ADESSO)) =>
  ({ s: c.s, origin: 'https://bot.example', email: 'admin@fenice.com', now, fetch: f });

describe('PARAMS', () => {
  it('accetta solo le chiavi dichiarate', () => {
    expect(PARAMS.interruttore.safeParse({ chiave: 'lancio_zoom_link', valore: true }).success).toBe(false);
    expect(PARAMS.interruttore.safeParse({ chiave: 'lancio_attivo', valore: 'si' }).success).toBe(false);
    expect(PARAMS.pausa_mario.safeParse({ conversationId: 12 }).success).toBe(true);
    expect(PARAMS.rinvia_esito.safeParse({ conversationId: '12' }).success).toBe(false);
  });
});

describe('token firmato e monouso', () => {
  it('senza stato: una firma alterata o un payload cambiato sono anteprima_scaduta', async () => {
    const c = clienteFinto({ settings: { lancio_attivo: false } });
    const a = await anteprima('interruttore', { chiave: 'lancio_attivo', valore: true }, ctxCon(c));
    const [corpo, firma] = a.token.split('.');
    const carico = JSON.parse(Buffer.from(corpo, 'base64url').toString());
    const falso = Buffer.from(JSON.stringify({ ...carico, params: { chiave: 'lancio_attivo', valore: false } })).toString('base64url');
    await expect(esegui(`${falso}.${firma}`, ctxCon(c))).rejects.toThrow('anteprima_scaduta');
    await expect(esegui(`${corpo}.${firma.slice(0, -2)}xx`, ctxCon(c))).rejects.toThrow('anteprima_scaduta');
    expect(c.scritture).toHaveLength(0);
  });
  it('scade dopo 5 minuti', async () => {
    const c = clienteFinto({ settings: { lancio_attivo: false } });
    const a = await anteprima('interruttore', { chiave: 'lancio_attivo', valore: true }, ctxCon(c));
    await expect(esegui(a.token, ctxCon(c, undefined, new Date(Date.parse(ADESSO) + 5 * 60_000 + 1)))).rejects.toThrow('anteprima_scaduta');
  });
  it('un altro avvio con lo stesso nonce (altra istanza) vince: gia_eseguita e niente effetti', async () => {
    const c = clienteFinto({ settings: { lancio_attivo: false } });
    const a = await anteprima('interruttore', { chiave: 'lancio_attivo', valore: true }, ctxCon(c));
    const nonce = JSON.parse(Buffer.from(a.token.split('.')[0], 'base64url').toString()).nonce;
    // L'altra istanza ha scritto il suo avvio per prima: id piu' basso del prossimo insert.
    c.eventi.push({ id: 0, created_at: ADESSO, type: 'console_azione_avviata', payload: { nonce, azione: 'interruttore', params: a.params } });
    await expect(esegui(a.token, ctxCon(c))).rejects.toThrow('gia_eseguita');
    expect(c.scritture.some((x) => x.op === 'upsert')).toBe(false);
  });
  it('la riga d\'avvio precede gli effetti e la chiusura porta il nonce', async () => {
    const c = clienteFinto({ settings: { lancio_attivo: false } });
    const a = await anteprima('interruttore', { chiave: 'lancio_attivo', valore: true }, ctxCon(c));
    await esegui(a.token, ctxCon(c));
    const tipi = c.scritture.map((x) => x.riga.type ?? x.op);
    expect(tipi[0]).toBe('console_azione_avviata');
    expect(tipi.indexOf('upsert')).toBeGreaterThan(0);
    const avvio = soloTipo(c.scritture, 'console_azione_avviata')[0].riga;
    expect(avvio).toMatchObject({ level: 'info', message: '[console] avvio interruttore da admin@fenice.com', payload: { azione: 'interruttore', by: 'admin@fenice.com' } });
    const nonce = (avvio.payload as { nonce: string }).nonce;
    expect(soloTipo(c.scritture, 'console_azione')[0].riga.payload).toMatchObject({ nonce });
  });
  it('se la riga d\'avvio non si scrive non parte niente', async () => {
    const c = clienteFinto({ settings: { lancio_attivo: false }, falliscoInsert: (r) => (r.type === 'console_azione_avviata' ? 'db giu' : null) });
    const a = await anteprima('interruttore', { chiave: 'lancio_attivo', valore: true }, ctxCon(c));
    await expect(esegui(a.token, ctxCon(c))).rejects.toThrow('registro_non_scritto');
    expect(c.scritture.some((x) => x.op === 'upsert')).toBe(false);
  });
});

describe('azione_in_corso', () => {
  const avvio = (nonce: string, created_at: string, params: unknown = { valore: true, chiave: 'lancio_attivo' }) =>
    ({ created_at, type: 'console_azione_avviata', payload: { nonce, azione: 'interruttore', params } });
  it('un avvio aperto degli ultimi 6 minuti blocca anteprima ed esegui, anche con le chiavi in altro ordine', async () => {
    const c = clienteFinto({ settings: { lancio_attivo: false } });
    const a = await anteprima('interruttore', { chiave: 'lancio_attivo', valore: true }, ctxCon(c));
    c.eventi.push({ id: 50, ...avvio('altro', '2026-09-30T09:57:00.000Z') });
    const err = await anteprima('interruttore', { chiave: 'lancio_attivo', valore: true }, ctxCon(c)).catch((e) => e);
    expect(err.message).toBe('azione_in_corso');
    expect(err.spiegazione).toBe('Questa azione è già in corso da 11:57. Aspetta che finisca.');
    await expect(esegui(a.token, ctxCon(c))).rejects.toThrow('azione_in_corso');
    expect(c.scritture).toHaveLength(0);
  });
  it('non blocca se chiuso, piu\' vecchio di 6 minuti o con parametri diversi', async () => {
    const c = clienteFinto({
      settings: { lancio_attivo: false },
      eventi: [
        avvio('chiuso', '2026-09-30T09:58:00.000Z'),
        { created_at: '2026-09-30T09:59:00.000Z', type: 'console_azione', payload: { nonce: 'chiuso' } },
        avvio('vecchio', '2026-09-30T09:53:00.000Z'),
        avvio('diverso', '2026-09-30T09:59:00.000Z', { chiave: 'lancio_attivo', valore: false }),
      ],
    });
    const a = await anteprima('interruttore', { chiave: 'lancio_attivo', valore: true }, ctxCon(c));
    expect((await esegui(a.token, ctxCon(c))).ok).toBe(true);
  });
  it('JSON canonico', () => {
    expect(canonico({ b: 1, a: { d: 2, c: [1, { f: 1, e: 2 }] } })).toBe(canonico({ a: { c: [1, { e: 2, f: 1 }], d: 2 }, b: 1 }));
  });
});

describe('arretrati', () => {
  it('manda Bearer, cosa e max 1000; per le agende il conteggio sono le consegnate', async () => {
    const f = finto({ no: { ok: true, candidate: 9, consegnate: 2, esempi: [{ conv: 7, lead: 'L1', status: 'delivered' }] }, si: { ok: true, consegnate: 2, avvisate: 2, fallite: 0 } });
    const c = clienteFinto();
    const a = await anteprima('recupera_agende_consegnate', {}, ctxCon(c, f));
    expect(chiamate[0].url).toBe('https://bot.example/api/cron/arretrati');
    expect(chiamate[0].init.method).toBe('POST');
    expect((chiamate[0].init.headers as Record<string, string>).authorization).toBe('Bearer x');
    expect(JSON.parse(String(chiamate[0].init.body))).toEqual({ cosa: 'agenda-delivery', esegui: false, max: 1000 });
    expect(a.conteggio).toBe(2);
    expect(a.righe).toEqual(['conv 7 · lead L1 · status delivered']);
    const e = await esegui(a.token, ctxCon(c, f));
    expect(e).toMatchObject({ ok: true, fatti: 2, falliti: 0 });
    expect(JSON.parse(String(chiamate.at(-1)!.init.body))).toEqual({ cosa: 'agenda-delivery', esegui: true, max: 1000 });
    const [log] = soloTipo(c.scritture, 'console_azione');
    expect(log.riga).toMatchObject({
      type: 'console_azione', level: 'info',
      payload: { azione: 'recupera_agende_consegnate', params: {}, anteprima: { conteggio: 2 }, by: 'admin@fenice.com' },
    });
    expect(String(log.riga.message)).toMatch(/^\[console\] recupera_agende_consegnate da admin@fenice.com: /);
  });
  it('senza CRON_SECRET non parte niente', async () => {
    delete process.env.CRON_SECRET;
    const f = finto({ no: { ok: true, candidate: 1, esempi: [] } });
    await expect(anteprima('rinvia_esiti_403', {}, ctxCon(clienteFinto(), f))).rejects.toThrow('cron_secret_mancante');
    expect(chiamate).toHaveLength(0);
  });
  it('un HTTP non 2xx in esecuzione e\' un esito fallito registrato come errore', async () => {
    const c = clienteFinto();
    const f = (async (_u: string, init: RequestInit) => {
      const corpo = JSON.parse(String(init.body));
      return corpo.esegui
        ? new Response(JSON.stringify({ ok: false, error: 'BOT_WEBHOOK_SECRET non impostato' }), { status: 503 })
        : new Response(JSON.stringify({ ok: true, candidate: 3, esempi: [] }));
    }) as unknown as typeof fetch;
    const a = await anteprima('rinvia_esiti_403', {}, ctxCon(c, f));
    const e = await esegui(a.token, ctxCon(c, f));
    expect(e.ok).toBe(false);
    expect(e.messaggio).toContain('BOT_WEBHOOK_SECRET non impostato');
    expect(soloTipo(c.scritture, 'console_azione')[0].riga.level).toBe('error');
  });
  it('se la riverifica fallisce non esegue e registra un console_azione di errore', async () => {
    let giro = 0;
    const f = (async (_u: string, init: RequestInit) => {
      chiamate.push({ url: _u, init }); giro++;
      return giro === 1
        ? new Response(JSON.stringify({ ok: true, candidate: 3, esempi: [] }))
        : new Response('boom', { status: 500 });
    }) as unknown as typeof fetch;
    const c = clienteFinto();
    const a = await anteprima('rinvia_esiti_403', {}, ctxCon(c, f));
    const e = await esegui(a.token, ctxCon(c, f));
    expect(e.ok).toBe(false);
    expect(e.messaggio).toContain('prova a vuoto di controllo fallita');
    expect(chiamate.every((x) => JSON.parse(String(x.init.body)).esegui === false)).toBe(true);
    expect(soloTipo(c.scritture, 'console_azione')[0].riga.level).toBe('error');
  });
  it('conteggio_cambiato porta la nuova anteprima, non esegue e chiude l\'avvio', async () => {
    let giro = 0;
    const f = (async (_u: string, init: RequestInit) => {
      chiamate.push({ url: _u, init }); giro++;
      return new Response(JSON.stringify({ ok: true, candidate: giro === 1 ? 10 : 13, esempi: [] }));
    }) as unknown as typeof fetch;
    const c = clienteFinto();
    const a = await anteprima('rinvia_esiti_403', {}, ctxCon(c, f));
    const err = await esegui(a.token, ctxCon(c, f)).catch((e) => e);
    expect(err.message).toBe('conteggio_cambiato');
    expect(err.nuovaAnteprima.conteggio).toBe(13);
    expect(err.nuovaAnteprima.token).not.toBe(a.token);
    expect(chiamate.every((x) => JSON.parse(String(x.init.body)).esegui === false)).toBe(true);
    expect(soloTipo(c.scritture, 'console_azione')[0].riga.level).toBe('warn');
    // La nuova anteprima e' subito confermabile: l'avvio rifiutato non la blocca.
    await expect(anteprima('rinvia_esiti_403', {}, ctxCon(c, f))).resolves.toBeTruthy();
  });
  it('entro il 20% esegue', async () => {
    let giro = 0;
    const f = (async (_u: string, init: RequestInit) => {
      const corpo = JSON.parse(String(init.body)); giro++;
      return new Response(JSON.stringify(corpo.esegui ? { ok: true, inviate: 12, fallite: 0 } : { ok: true, candidate: giro === 1 ? 10 : 12, esempi: [] }));
    }) as unknown as typeof fetch;
    const c = clienteFinto();
    const a = await anteprima('rinvia_esiti_403', {}, ctxCon(c, f));
    expect((await esegui(a.token, ctxCon(c, f))).fatti).toBe(12);
  });
});

describe('rilancia_cron', () => {
  it('cron GET: niente chiamata in anteprima, avvertenza e ultimo giro; esegue in GET', async () => {
    const f = (async (u: string, init: RequestInit) => {
      chiamate.push({ url: u, init });
      return new Response(JSON.stringify({ ok: true, actions: [1, 2], agendaFollowup: { sent: 0 } }));
    }) as unknown as typeof fetch;
    const c = clienteFinto({ eventi: [{ type: 'bot_followups_run', created_at: '2026-09-30T09:00:00Z', message: '[bot-fissatore] cron backstop: 2 azioni' }] });
    const a = await anteprima('rilancia_cron', { cron: 'bot-followups' }, ctxCon(c, f));
    expect(chiamate).toHaveLength(0);
    expect(a.avvertenza).toBe('Questo giro non ha una prova a vuoto: parte davvero.');
    expect(a.conteggio).toBeNull();
    expect(a.righe.join(' ')).toContain('cron backstop: 2 azioni');
    const e = await esegui(a.token, ctxCon(c, f));
    expect(chiamate[0].url).toBe('https://bot.example/api/cron/bot-followups');
    expect(chiamate[0].init.method).toBe('GET');
    expect((chiamate[0].init.headers as Record<string, string>).authorization).toBe('Bearer x');
    expect(e.ok).toBe(true);
    expect(e.messaggio).toContain('actions: 2 elementi');
  });
  it('riapri-mute: prova a vuoto vera in POST con il tetto del giro, poi esegui true', async () => {
    const f = finto({ no: { ok: true, candidate: 300, esempi: [{ conv: 1, lead: 'A', funnel: 'x' }], inviati: 0, falliti: 0 }, si: { ok: true, candidate: 300, inviati: 49, falliti: 1 } });
    const c = clienteFinto();
    const a = await anteprima('rilancia_cron', { cron: 'riapri-mute' }, ctxCon(c, f));
    expect(a.conteggio).toBe(300);
    expect(a.righe[0]).toBe('Questo giro ne manda al massimo 50 su 300.');
    expect(a.avvertenza).toBe('Manda messaggi WhatsApp ai lead.');
    expect(JSON.parse(String(chiamate[0].init.body))).toEqual({ esegui: false });
    const e = await esegui(a.token, ctxCon(c, f));
    expect(JSON.parse(String(chiamate.at(-1)!.init.body))).toEqual({ esegui: true });
    expect(e).toMatchObject({ ok: true, fatti: 49, falliti: 1 });
  });
  it('adotta-mai-risposti: tetto 25', async () => {
    const f = finto({ no: { ok: true, candidate: 4, esempi: [] } });
    const a = await anteprima('rilancia_cron', { cron: 'adotta-mai-risposti' }, ctxCon(clienteFinto(), f));
    expect(a.righe[0]).toBe('Questo giro ne manda al massimo 25 su 4.');
  });
  it('lancio-inizio: niente prova a vuoto, avvertenza, ultimo giro lancio_inizio_run; esegue in GET', async () => {
    const f = (async (u: string, init: RequestInit) => {
      chiamate.push({ url: u, init });
      return new Response(JSON.stringify({ ok: true, skipped: 'fuori_finestra', finestraChiusa: false, rimanenti: null }));
    }) as unknown as typeof fetch;
    const c = clienteFinto({ eventi: [{ type: 'lancio_inizio_run', created_at: '2026-10-05T18:30:00Z', message: '[lancio] inizio live: fuori dalla finestra, nessun invio' }] });
    const a = await anteprima('rilancia_cron', { cron: 'lancio-inizio' }, ctxCon(c, f));
    expect(chiamate).toHaveLength(0);
    expect(a.descrizione).toBe('Manda «la live sta iniziando» con il link Zoom a chi ha scritto dopo il benvenuto. Fuori dalla finestra 20:30-21:30 del giorno della live non manda niente. Scrive ai lead.');
    expect(a.avvertenza).toBe('Questo giro non ha una prova a vuoto: parte davvero.');
    expect(a.righe.join(' ')).toContain('fuori dalla finestra');
    await esegui(a.token, ctxCon(c, f));
    expect(chiamate[0].url).toBe('https://bot.example/api/cron/lancio-inizio');
    expect(chiamate[0].init.method).toBe('GET');
  });
  it('un timeout dice che il giro puo\' essere ancora in corso', async () => {
    const f = (async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); }) as unknown as typeof fetch;
    const c = clienteFinto();
    const a = await anteprima('rilancia_cron', { cron: 'lancio-zoom' }, ctxCon(c, f));
    const e = await esegui(a.token, ctxCon(c, f));
    expect(e.ok).toBe(false);
    expect(e.messaggio).toContain('ancora in corso');
  });
});

describe('rinvia_esito', () => {
  it('booked senza bot_outcome = APPUNTAMENTO con la data; esegui scrive admin_resend_outcome', async () => {
    const c = clienteFinto({ conv: { bot_outcome: null, bot_scheduled_at: '2026-10-02T15:00:00+02:00', ai_status: 'booked', crm_lead_id: 'L9' } });
    const a = await anteprima('rinvia_esito', { conversationId: 55 }, ctxCon(c));
    expect(a.conteggio).toBe(1);
    expect(a.avvertenza).toBeNull();
    sendOutcome.mockResolvedValue({ sent: true, status: 200 });
    const e = await esegui(a.token, ctxCon(c));
    expect(sendOutcome).toHaveBeenCalledWith(c.s, 55, { outcome: 'APPUNTAMENTO', date: '2026-10-02T15:00:00+02:00' });
    expect(e).toMatchObject({ ok: true, fatti: 1, falliti: 0 });
    expect(soloTipo(c.scritture, 'admin_resend_outcome')[0].riga).toEqual({
      type: 'admin_resend_outcome',
      payload: { conversationId: 55, outcome: 'APPUNTAMENTO', result: { sent: true, status: 200 } },
      message: '[admin] resend-outcome conv 55: APPUNTAMENTO → ok',
      level: 'info',
    });
  });
  it('RICHIAMO porta la data', async () => {
    const c = clienteFinto({ conv: { bot_outcome: 'RICHIAMO', bot_scheduled_at: '2026-10-03T11:00:00+02:00', ai_status: 'closed', crm_lead_id: 'L9' } });
    const a = await anteprima('rinvia_esito', { conversationId: 6 }, ctxCon(c));
    expect(a.conteggio).toBe(1);
    sendOutcome.mockResolvedValue({ sent: true, status: 200 });
    await esegui(a.token, ctxCon(c));
    expect(sendOutcome).toHaveBeenCalledWith(c.s, 6, { outcome: 'RICHIAMO', date: '2026-10-03T11:00:00+02:00' });
  });
  it.each([
    [{ bot_outcome: 'RICHIAMO', ai_status: 'closed' }],
    [{ bot_outcome: 'APPUNTAMENTO', ai_status: 'closed' }],
    [{ bot_outcome: null, ai_status: 'booked' }],
  ])('esito che vuole la data senza data: avvertenza, conteggio 0, esegui rifiuta (%o)', async (riga) => {
    const c = clienteFinto({ conv: { ...riga, bot_scheduled_at: null, crm_lead_id: 'L9' } });
    const a = await anteprima('rinvia_esito', { conversationId: 6 }, ctxCon(c));
    expect(a).toMatchObject({ conteggio: 0, avvertenza: 'Esito senza data: non si può rinviare' });
    await expect(esegui(a.token, ctxCon(c))).rejects.toThrow('esito_senza_data');
    expect(sendOutcome).not.toHaveBeenCalled();
  });
  it('bot_outcome senza bisogno di data: si rinvia senza data', async () => {
    const c = clienteFinto({ conv: { bot_outcome: 'DA_SCARTARE', bot_scheduled_at: null, ai_status: 'closed', crm_lead_id: 'L9' } });
    const a = await anteprima('rinvia_esito', { conversationId: 5 }, ctxCon(c));
    sendOutcome.mockResolvedValue({ sent: false, status: 403, error: 'http_403' });
    const e = await esegui(a.token, ctxCon(c));
    expect(sendOutcome).toHaveBeenCalledWith(c.s, 5, { outcome: 'DA_SCARTARE', date: undefined });
    expect(e).toMatchObject({ ok: false, fatti: 0, falliti: 1 });
    expect(soloTipo(c.scritture, 'admin_resend_outcome')[0].riga.level).toBe('error');
  });
  it('nessun esito: avvertenza, conteggio 0, e l\'esecuzione rifiuta senza inviare', async () => {
    const c = clienteFinto({ conv: { bot_outcome: null, bot_scheduled_at: null, ai_status: 'active', crm_lead_id: 'L9' } });
    const a = await anteprima('rinvia_esito', { conversationId: 5 }, ctxCon(c));
    expect(a).toMatchObject({ conteggio: 0, avvertenza: 'Nessun esito da rinviare su questa chat' });
    await expect(esegui(a.token, ctxCon(c))).rejects.toThrow('nessun_esito');
    expect(sendOutcome).not.toHaveBeenCalled();
  });
});

describe('interruttore', () => {
  it('lancio_attivo: prima → dopo, stessa riga lancio_setting_cambiata del pannello', async () => {
    const c = clienteFinto({ settings: { lancio_attivo: false } });
    const a = await anteprima('interruttore', { chiave: 'lancio_attivo', valore: true }, ctxCon(c));
    expect(a.descrizione).toContain('spento → acceso');
    expect(c.scritture).toHaveLength(0);
    const e = await esegui(a.token, ctxCon(c));
    expect(e.ok).toBe(true);
    expect(c.scritture.find((x) => x.op === 'upsert')!.riga).toMatchObject({ key: 'lancio_attivo', value: true });
    expect(soloTipo(c.scritture, 'lancio_setting_cambiata')[0].riga).toEqual({
      type: 'lancio_setting_cambiata',
      payload: { key: 'lancio_attivo', old: false, new: true, who: 'admin@fenice.com' },
      message: '[lancio] lancio_attivo: false → true (admin@fenice.com)',
      level: 'info',
    });
  });
  it('audit fallito: lancio_setting_audit_fallito e dettaglio nell\'esito', async () => {
    const c = clienteFinto({ settings: { lancio_attivo: false }, falliscoInsert: (r) => (r.type === 'lancio_setting_cambiata' ? 'rls' : null) });
    const a = await anteprima('interruttore', { chiave: 'lancio_attivo', valore: true }, ctxCon(c));
    const e = await esegui(a.token, ctxCon(c));
    expect(e.ok).toBe(true);
    expect(e.dettagli).toContain('La riga di registro lancio_setting_cambiata non è stata scritta.');
    expect(soloTipo(c.scritture, 'lancio_setting_audit_fallito')[0].riga).toMatchObject({
      level: 'warn', payload: { key: 'lancio_attivo', value: true, who: 'admin@fenice.com' },
    });
  });
  it('fenice_ai_autoreply: setAutoReply ed evento console_autoreply_cambiata', async () => {
    const c = clienteFinto({ settings: { fenice_ai_autoreply: true } });
    const a = await anteprima('interruttore', { chiave: 'fenice_ai_autoreply', valore: false }, ctxCon(c));
    expect(a.descrizione).toContain('acceso → spento');
    await esegui(a.token, ctxCon(c));
    expect(c.scritture.find((x) => x.op === 'upsert')!.riga).toMatchObject({ key: 'fenice_ai_autoreply', value: false });
    expect(soloTipo(c.scritture, 'console_autoreply_cambiata')[0].riga).toMatchObject({
      payload: { key: 'fenice_ai_autoreply', old: true, new: false, who: 'admin@fenice.com' },
    });
  });
  it('fenice_ai_autoreply non salvato (la rilettura dà il valore di prima): esito ko e riga di scrittura fallita', async () => {
    const c = clienteFinto({ settings: { fenice_ai_autoreply: true }, upsertPerso: true });
    const a = await anteprima('interruttore', { chiave: 'fenice_ai_autoreply', valore: false }, ctxCon(c));
    const e = await esegui(a.token, ctxCon(c));
    expect(e).toMatchObject({ ok: false, fatti: 0, falliti: 1, messaggio: 'Auto-risposta di Mario NON salvata: è rimasta accesa' });
    expect(soloTipo(c.scritture, 'console_autoreply_cambiata')).toHaveLength(0);
    expect(soloTipo(c.scritture, 'console_autoreply_scrittura_fallita')[0].riga).toMatchObject({
      level: 'error',
      payload: { key: 'fenice_ai_autoreply', value: false, letto: true, who: 'admin@fenice.com' },
    });
  });
  it('fenice_ai_autoreply da spento ad acceso non salvato: "è rimasta spenta"', async () => {
    const c = clienteFinto({ settings: { fenice_ai_autoreply: false }, upsertPerso: true });
    const a = await anteprima('interruttore', { chiave: 'fenice_ai_autoreply', valore: true }, ctxCon(c));
    const e = await esegui(a.token, ctxCon(c));
    expect(e).toMatchObject({ ok: false, messaggio: 'Auto-risposta di Mario NON salvata: è rimasta spenta' });
  });
});

describe('azioni su una chat nel thread', () => {
  it('console_azione_avviata e console_azione portano conversationId al primo livello', async () => {
    const c = clienteFinto({ conv: { ai_paused_at: null } });
    const a = await anteprima('pausa_mario', { conversationId: 77 }, ctxCon(c));
    await esegui(a.token, ctxCon(c));
    const avvio = soloTipo(c.scritture, 'console_azione_avviata')[0].riga.payload as Record<string, unknown>;
    const fine = soloTipo(c.scritture, 'console_azione')[0].riga.payload as Record<string, unknown>;
    expect(avvio.conversationId).toBe(77);
    expect(fine.conversationId).toBe(77);
    // Il thread filtra su payload->>conversationId: l'azione compare tra gli eventi della chat.
    expect(c.eventi.filter((e) => (e.payload as Record<string, unknown>)?.conversationId === 77).map((e) => e.type))
      .toEqual(expect.arrayContaining(['console_azione_avviata', 'console_azione', 'bot_paused']));
  });
  it('senza conversationId nei params il payload non ne ha uno', async () => {
    const c = clienteFinto({ settings: { lancio_attivo: false } });
    const a = await anteprima('interruttore', { chiave: 'lancio_attivo', valore: true }, ctxCon(c));
    await esegui(a.token, ctxCon(c));
    expect(soloTipo(c.scritture, 'console_azione')[0].riga.payload).not.toHaveProperty('conversationId');
    expect(soloTipo(c.scritture, 'console_azione_avviata')[0].riga.payload).not.toHaveProperty('conversationId');
  });
});

describe('pausa e ripresa di Mario', () => {
  it('pausa: ai_paused_at ISO ed evento bot_paused come /api/chat/pause', async () => {
    const c = clienteFinto({ conv: { ai_paused_at: null } });
    const a = await anteprima('pausa_mario', { conversationId: 77 }, ctxCon(c));
    const e = await esegui(a.token, ctxCon(c));
    expect(e.ok).toBe(true);
    const up = c.scritture.find((x) => x.op === 'update')!;
    expect(up.filtri).toEqual({ id: 77 });
    expect(up.riga.ai_paused_at).toBe(ADESSO);
    expect(soloTipo(c.scritture, 'bot_paused')[0].riga).toEqual({
      type: 'bot_paused',
      payload: { conversationId: 77, by: 'admin@fenice.com' },
      message: '[chat] bot fermato sulla conv 77 da admin@fenice.com',
      level: 'warn',
    });
  });
  it('ripresa: ai_paused_at null ed evento bot_resumed', async () => {
    const c = clienteFinto({ conv: { ai_paused_at: '2026-09-29T10:00:00Z' } });
    const a = await anteprima('riprendi_mario', { conversationId: 77 }, ctxCon(c));
    await esegui(a.token, ctxCon(c));
    expect(c.scritture.find((x) => x.op === 'update')!.riga).toEqual({ ai_paused_at: null });
    expect(soloTipo(c.scritture, 'bot_resumed')[0].riga.message).toBe('[chat] bot riattivato sulla conv 77 da admin@fenice.com');
  });
  it('audit fallito finisce nei dettagli', async () => {
    const c = clienteFinto({ conv: { ai_paused_at: null }, falliscoInsert: (r) => (r.type === 'bot_paused' ? 'rls' : null) });
    const a = await anteprima('pausa_mario', { conversationId: 77 }, ctxCon(c));
    expect((await esegui(a.token, ctxCon(c))).dettagli).toEqual(['La riga di registro bot_paused non è stata scritta.']);
  });
  it('fuori perimetro: rifiuta senza scrivere', async () => {
    perimetro.dentro = false;
    const c = clienteFinto({ conv: { ai_paused_at: null } });
    await expect(anteprima('pausa_mario', { conversationId: 77 }, ctxCon(c))).rejects.toThrow('chat_fuori_perimetro');
    expect(c.scritture).toHaveLength(0);
  });
  it('update fallito: esito ko e nessun evento bot_paused', async () => {
    const c = clienteFinto({ conv: { ai_paused_at: null }, erroreUpdate: 'rls' });
    const a = await anteprima('pausa_mario', { conversationId: 77 }, ctxCon(c));
    const e = await esegui(a.token, ctxCon(c));
    expect(e.ok).toBe(false);
    expect(c.scritture.some((x) => x.riga.type === 'bot_paused')).toBe(false);
  });
});
