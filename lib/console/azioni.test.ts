import { describe, it, expect, vi, beforeEach } from 'vitest';

const sendOutcome = vi.fn();
vi.mock('@/lib/bot-outcome', () => ({ sendOutcome: (...a: unknown[]) => sendOutcome(...a) }));
const perimetro = { dentro: true };
vi.mock('@/lib/chat-perimetro', () => ({ isConversazioneChat: async () => perimetro.dentro }));

const { anteprima, esegui, _svuotaToken, PARAMS } = await import('./azioni');

const chiamate: { url: string; init: RequestInit }[] = [];
const finto = (risposte: Record<string, unknown>) => (async (url: string, init: RequestInit) => {
  chiamate.push({ url, init });
  const corpo = JSON.parse(String(init.body ?? '{}'));
  return new Response(JSON.stringify(risposte[corpo.esegui ? 'si' : 'no']), { status: 200 });
}) as unknown as typeof fetch;
const eventi: unknown[] = [];
const s = { from: () => ({ insert: (r: unknown) => { eventi.push(r); return Promise.resolve({ error: null }); } }) } as never;
beforeEach(() => { chiamate.length = 0; eventi.length = 0; _svuotaToken(); process.env.CRON_SECRET = 'x'; sendOutcome.mockReset(); perimetro.dentro = true; });

it('l\'anteprima non esegue', async () => {
  const f = finto({ no: { ok: true, candidate: 38, esempi: ['conv 1'] }, si: { ok: true, inviate: 38, fallite: 0 } });
  const a = await anteprima('rinvia_esiti_403', {}, { s, origin: 'https://x', email: 'admin@fenice.com', now: new Date(), fetch: f });
  expect(a.conteggio).toBe(38);
  expect(JSON.parse(String(chiamate[0].init.body)).esegui).toBe(false);
  expect(eventi).toHaveLength(0);
});
it('esegui una volta sola e registra', async () => {
  const f = finto({ no: { ok: true, candidate: 38, esempi: [] }, si: { ok: true, inviate: 36, fallite: 2 } });
  const ctx = { s, origin: 'https://x', email: 'admin@fenice.com', now: new Date(), fetch: f };
  const a = await anteprima('rinvia_esiti_403', {}, ctx);
  const e = await esegui(a.token, ctx);
  expect(e).toMatchObject({ ok: true, fatti: 36, falliti: 2 });
  expect(eventi).toHaveLength(1);
  await expect(esegui(a.token, ctx)).rejects.toThrow('gia_eseguita');
});
it('token sconosciuto', async () => {
  await expect(esegui('nope', { s, origin: 'https://x', email: 'a', now: new Date() })).rejects.toThrow('anteprima_scaduta');
});
it('conteggio cambiato oltre il 20%', async () => {
  let giro = 0;
  const f = (async (_u: string, init: RequestInit) => {
    const c = JSON.parse(String(init.body)); giro++;
    return new Response(JSON.stringify(c.esegui ? { ok: true, inviate: 1, fallite: 0 } : { ok: true, candidate: giro === 1 ? 10 : 50, esempi: [] }));
  }) as unknown as typeof fetch;
  const ctx = { s, origin: 'https://x', email: 'a', now: new Date(), fetch: f };
  const a = await anteprima('rinvia_esiti_403', {}, ctx);
  await expect(esegui(a.token, ctx)).rejects.toThrow('conteggio_cambiato');
});
it('parametri non validi', async () => {
  await expect(anteprima('rilancia_cron', { cron: 'rm -rf' }, { s, origin: 'https://x', email: 'a', now: new Date() })).rejects.toThrow();
});

// --- Oltre il brief: i contratti delle rotte vere e le altre azioni ---

type Scrittura = { tabella: string; op: 'insert' | 'upsert' | 'update'; riga: Record<string, unknown>; filtri: Record<string, unknown> };
function clienteFinto(dati: {
  conv?: Record<string, unknown> | null;
  settings?: Record<string, unknown>;
  ultimoGiro?: { created_at: string; message: string } | null;
  erroreUpdate?: string;
}) {
  const scritture: Scrittura[] = [];
  const from = (tabella: string) => {
    const filtri: Record<string, unknown> = {};
    let update: Record<string, unknown> | null = null;
    const leggi = () => {
      if (tabella === 'conversations') return dati.conv ?? null;
      if (tabella === 'app_settings') {
        const k = String(filtri.key);
        return dati.settings && k in dati.settings ? { value: dati.settings[k] } : null;
      }
      return null;
    };
    const b: Record<string, unknown> = {
      select: () => b,
      eq: (k: string, v: unknown) => { filtri[k] = v; return b; },
      order: () => b,
      limit: () => b,
      maybeSingle: async () => ({ data: leggi(), error: null }),
      insert: async (riga: Record<string, unknown>) => { scritture.push({ tabella, op: 'insert', riga, filtri }); return { error: null }; },
      upsert: async (riga: Record<string, unknown>) => {
        scritture.push({ tabella, op: 'upsert', riga, filtri });
        if (dati.settings) dati.settings[String(riga.key)] = riga.value;
        return { error: null };
      },
      update: (riga: Record<string, unknown>) => { update = riga; return b; },
      then: (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) => {
        if (update) {
          scritture.push({ tabella, op: 'update', riga: update, filtri });
          return Promise.resolve({ error: dati.erroreUpdate ? { message: dati.erroreUpdate } : null }).then(ok, ko);
        }
        const righe = tabella === 'event_log' && dati.ultimoGiro ? [dati.ultimoGiro] : [];
        return Promise.resolve({ data: righe, error: null }).then(ok, ko);
      },
    };
    return b;
  };
  return { s: { from } as never, scritture };
}
const ctxCon = (cliente: { s: never }, f?: typeof fetch) =>
  ({ s: cliente.s, origin: 'https://bot.example', email: 'admin@fenice.com', now: new Date('2026-09-30T10:00:00Z'), fetch: f });
const soloConsole = (sc: Scrittura[]) => sc.filter((x) => x.riga.type === 'console_azione');

describe('PARAMS', () => {
  it('accetta solo le chiavi dichiarate', () => {
    expect(PARAMS.interruttore.safeParse({ chiave: 'lancio_zoom_link', valore: true }).success).toBe(false);
    expect(PARAMS.interruttore.safeParse({ chiave: 'lancio_attivo', valore: 'si' }).success).toBe(false);
    expect(PARAMS.pausa_mario.safeParse({ conversationId: 12 }).success).toBe(true);
    expect(PARAMS.rinvia_esito.safeParse({ conversationId: '12' }).success).toBe(false);
  });
});

describe('arretrati', () => {
  it('manda Bearer, cosa e max 1000 all\'endpoint vero; righe dagli esempi oggetto', async () => {
    const f = finto({ no: { ok: true, candidate: 2, esempi: [{ conv: 7, lead: 'L1', status: 'delivered' }] }, si: { ok: true, avvisate: 2, fallite: 0 } });
    const c = clienteFinto({});
    const a = await anteprima('recupera_agende_consegnate', {}, ctxCon(c, f));
    expect(chiamate[0].url).toBe('https://bot.example/api/cron/arretrati');
    expect(chiamate[0].init.method).toBe('POST');
    expect((chiamate[0].init.headers as Record<string, string>).authorization).toBe('Bearer x');
    expect(JSON.parse(String(chiamate[0].init.body))).toEqual({ cosa: 'agenda-delivery', esegui: false, max: 1000 });
    expect(a.righe).toEqual(['conv 7 · lead L1 · status delivered']);
    const e = await esegui(a.token, ctxCon(c, f));
    expect(e).toMatchObject({ ok: true, fatti: 2, falliti: 0 });
    expect(JSON.parse(String(chiamate.at(-1)!.init.body))).toEqual({ cosa: 'agenda-delivery', esegui: true, max: 1000 });
    const [log] = soloConsole(c.scritture);
    expect(log.riga).toMatchObject({
      type: 'console_azione', level: 'info',
      payload: { azione: 'recupera_agende_consegnate', params: {}, anteprima: { conteggio: 2 }, by: 'admin@fenice.com' },
    });
    expect(String(log.riga.message)).toMatch(/^\[console\] recupera_agende_consegnate da admin@fenice.com: /);
  });
  it('senza CRON_SECRET non parte niente', async () => {
    delete process.env.CRON_SECRET;
    const f = finto({ no: { ok: true, candidate: 1, esempi: [] } });
    await expect(anteprima('rinvia_esiti_403', {}, ctxCon(clienteFinto({}), f))).rejects.toThrow('cron_secret_mancante');
    expect(chiamate).toHaveLength(0);
  });
  it('un HTTP non 2xx in esecuzione e\' un esito fallito registrato come errore', async () => {
    const c = clienteFinto({});
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
    expect(soloConsole(c.scritture)[0].riga.level).toBe('error');
  });
  it('token scaduto dopo 5 minuti', async () => {
    const f = finto({ no: { ok: true, candidate: 1, esempi: [] } });
    const c = clienteFinto({});
    const a = await anteprima('rinvia_esiti_403', {}, ctxCon(c, f));
    const dopo = { ...ctxCon(c, f), now: new Date(Date.parse('2026-09-30T10:05:01Z')) };
    await expect(esegui(a.token, dopo)).rejects.toThrow('anteprima_scaduta');
  });
  it('conteggio_cambiato porta la nuova anteprima e non esegue', async () => {
    let giro = 0;
    const f = (async (_u: string, init: RequestInit) => {
      chiamate.push({ url: _u, init });
      giro++;
      return new Response(JSON.stringify({ ok: true, candidate: giro === 1 ? 10 : 13, esempi: [] }));
    }) as unknown as typeof fetch;
    const c = clienteFinto({});
    const a = await anteprima('rinvia_esiti_403', {}, ctxCon(c, f));
    const err = await esegui(a.token, ctxCon(c, f)).catch((e) => e);
    expect(err.message).toBe('conteggio_cambiato');
    expect(err.nuovaAnteprima.conteggio).toBe(13);
    expect(err.nuovaAnteprima.token).not.toBe(a.token);
    expect(chiamate.every((x) => JSON.parse(String(x.init.body)).esegui === false)).toBe(true);
    expect(soloConsole(c.scritture)).toHaveLength(0);
  });
  it('entro il 20% esegue', async () => {
    let giro = 0;
    const f = (async (_u: string, init: RequestInit) => {
      const corpo = JSON.parse(String(init.body)); giro++;
      return new Response(JSON.stringify(corpo.esegui ? { ok: true, inviate: 12, fallite: 0 } : { ok: true, candidate: giro === 1 ? 10 : 12, esempi: [] }));
    }) as unknown as typeof fetch;
    const c = clienteFinto({});
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
    const c = clienteFinto({ ultimoGiro: { created_at: '2026-09-30T09:00:00Z', message: '[bot-fissatore] cron backstop: 2 azioni' } });
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
  it('riapri-mute: prova a vuoto vera in POST, poi esegui true', async () => {
    const f = finto({ no: { ok: true, candidate: 4, esempi: [{ conv: 1, lead: 'A', funnel: 'x' }], inviati: 0, falliti: 0 }, si: { ok: true, candidate: 4, inviati: 3, falliti: 1 } });
    const c = clienteFinto({});
    const a = await anteprima('rilancia_cron', { cron: 'riapri-mute' }, ctxCon(c, f));
    expect(a.conteggio).toBe(4);
    expect(a.avvertenza).toBe('Manda messaggi WhatsApp ai lead.');
    expect(JSON.parse(String(chiamate[0].init.body))).toEqual({ esegui: false });
    const e = await esegui(a.token, ctxCon(c, f));
    expect(JSON.parse(String(chiamate.at(-1)!.init.body))).toEqual({ esegui: true });
    expect(e).toMatchObject({ ok: true, fatti: 3, falliti: 1 });
  });
  it('un timeout dice che il giro puo\' essere ancora in corso', async () => {
    const f = (async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); }) as unknown as typeof fetch;
    const c = clienteFinto({});
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
    const resend = c.scritture.find((x) => x.riga.type === 'admin_resend_outcome')!;
    expect(resend.riga).toEqual({
      type: 'admin_resend_outcome',
      payload: { conversationId: 55, outcome: 'APPUNTAMENTO', result: { sent: true, status: 200 } },
      message: '[admin] resend-outcome conv 55: APPUNTAMENTO → ok',
      level: 'info',
    });
  });
  it('bot_outcome presente: si rinvia quello, senza data', async () => {
    const c = clienteFinto({ conv: { bot_outcome: 'DA_SCARTARE', bot_scheduled_at: null, ai_status: 'closed', crm_lead_id: 'L9' } });
    const a = await anteprima('rinvia_esito', { conversationId: 5 }, ctxCon(c));
    sendOutcome.mockResolvedValue({ sent: false, status: 403, error: 'http_403' });
    const e = await esegui(a.token, ctxCon(c));
    expect(sendOutcome).toHaveBeenCalledWith(c.s, 5, { outcome: 'DA_SCARTARE', date: undefined });
    expect(e).toMatchObject({ ok: false, fatti: 0, falliti: 1 });
    expect(c.scritture.find((x) => x.riga.type === 'admin_resend_outcome')!.riga.level).toBe('error');
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
    expect(c.scritture.find((x) => x.riga.type === 'lancio_setting_cambiata')!.riga).toEqual({
      type: 'lancio_setting_cambiata',
      payload: { key: 'lancio_attivo', old: false, new: true, who: 'admin@fenice.com' },
      message: '[lancio] lancio_attivo: false → true (admin@fenice.com)',
      level: 'info',
    });
  });
  it('fenice_ai_autoreply: setAutoReply ed evento console_autoreply_cambiata', async () => {
    const c = clienteFinto({ settings: { fenice_ai_autoreply: true } });
    const a = await anteprima('interruttore', { chiave: 'fenice_ai_autoreply', valore: false }, ctxCon(c));
    expect(a.descrizione).toContain('acceso → spento');
    await esegui(a.token, ctxCon(c));
    expect(c.scritture.find((x) => x.op === 'upsert')!.riga).toMatchObject({ key: 'fenice_ai_autoreply', value: false });
    expect(c.scritture.find((x) => x.riga.type === 'console_autoreply_cambiata')!.riga).toMatchObject({
      payload: { key: 'fenice_ai_autoreply', old: true, new: false, who: 'admin@fenice.com' },
    });
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
    expect(up.riga.ai_paused_at).toBe('2026-09-30T10:00:00.000Z');
    expect(c.scritture.find((x) => x.riga.type === 'bot_paused')!.riga).toEqual({
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
    expect(c.scritture.find((x) => x.riga.type === 'bot_resumed')!.riga.message).toBe('[chat] bot riattivato sulla conv 77 da admin@fenice.com');
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
