import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Finto Supabase, ridotto a quello che questa rotta chiede: la lettura delle otto
 * chiavi di `app_settings` (GET e valore "prima" dell'audit), l'upsert della chiave
 * cambiata e la riga di `event_log` che la registra.
 */
const stato = {
  /** Le righe di `app_settings` come stanno nel DB, per chiave. */
  righe: {} as Record<string, unknown>,
  /** L'utente che la sessione restituisce; null = nessuna sessione. */
  utente: null as { id: string; email: string | null } | null,
  upsert: [] as Record<string, unknown>[],
  /** Gli insert su `event_log` TENTATI, riusciti o no. */
  eventi: [] as Record<string, unknown>[],
  /** Se valorizzato, l'upsert su `app_settings` fallisce con questo messaggio. */
  upsertKo: null as string | null,
  /** I `type` di evento che `event_log` rifiuta (registro rotto, RLS, colonna assente). */
  eventLogKo: new Set<string>(),
};

function appSettings() {
  let chiave = '';
  const q: Record<string, unknown> = {
    select: () => q,
    in: () => Promise.resolve({
      data: Object.entries(stato.righe).map(([key, value]) => ({ key, value })),
      error: null,
    }),
    eq: (_col: string, v: string) => { chiave = v; return q; },
    maybeSingle: () => Promise.resolve({
      data: chiave in stato.righe ? { value: stato.righe[chiave] } : null,
      error: null,
    }),
    upsert: (row: Record<string, unknown>) => {
      if (stato.upsertKo) return Promise.resolve({ error: { message: stato.upsertKo } });
      stato.upsert.push(row);
      stato.righe[row.key as string] = row.value;
      return Promise.resolve({ error: null });
    },
  };
  return q;
}

function eventLog() {
  return {
    insert: (row: Record<string, unknown>) => {
      stato.eventi.push(row);
      return stato.eventLogKo.has(String(row.type))
        ? Promise.resolve({ error: { message: 'event_log ko' } })
        : Promise.resolve({ error: null });
    },
  };
}

vi.mock('@/lib/supabase/admin', () => ({
  getSupabaseAdmin: () => ({
    from: (table: string) => (table === 'event_log' ? eventLog() : appSettings()),
  }),
}));

vi.mock('@/lib/supabase/server', () => ({
  getSupabaseServer: () => Promise.resolve({
    auth: { getUser: () => Promise.resolve({ data: { user: stato.utente }, error: null }) },
  }),
}));

import { GET, POST } from './route';

function posta(corpo: unknown) {
  return POST(new Request('https://x/api/fenice/lancio-settings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(corpo),
  }) as never);
}

beforeEach(() => {
  stato.righe = {};
  stato.utente = { id: 'u1', email: 'bruno@esempio.it' };
  stato.upsert = [];
  stato.eventi = [];
  stato.upsertKo = null;
  stato.eventLogKo = new Set();
});

describe('GET /api/fenice/lancio-settings', () => {
  it('senza sessione risponde 401 e non legge nulla', async () => {
    stato.utente = null;
    expect((await GET()).status).toBe(401);
  });

  it('con sessione torna le impostazioni e se l\'account puo\' scriverle', async () => {
    stato.righe = { lancio_attivo: true, lancio_zoom_link: 'https://us06web.zoom.us/j/1' };
    const res = await GET();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.settings.attivo).toBe(true);
    expect(body.settings.zoomLink).toBe('https://us06web.zoom.us/j/1');
    expect(body.puoModificare).toBe(true);
  });

  it('un account confinato a un\'area legge, e sa di essere in sola lettura', async () => {
    stato.utente = { id: 'u2', email: 'fenicebot@fenice.com' };
    const body = await (await GET()).json();
    expect(body.puoModificare).toBe(false);
    expect(body.settings.attivo).toBe(false);
  });
});

describe('POST /api/fenice/lancio-settings — chi puo\' scrivere', () => {
  it('senza sessione 401, e in `app_settings` non cambia niente', async () => {
    stato.utente = null;
    const res = await posta({ key: 'lancio_attivo', value: true });
    expect(res.status).toBe(401);
    expect(stato.upsert).toHaveLength(0);
  });

  it('un account confinato a un\'area riceve 403 sola_lettura e non scrive', async () => {
    stato.utente = { id: 'u2', email: 'fenicebot@fenice.com' };
    const res = await posta({ key: 'lancio_attivo', value: true });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, error: 'sola_lettura' });
    expect(stato.upsert).toHaveLength(0);
    expect(stato.eventi).toHaveLength(0);
  });
});

describe('POST /api/fenice/lancio-settings — validazione prima della scrittura', () => {
  it('una chiave estranea non entra in app_settings', async () => {
    const res = await posta({ key: 'fenice_ai_autoreply', value: true });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: 'chiave_non_modificabile' });
    expect(stato.upsert).toHaveLength(0);
  });

  it('un link http non si salva', async () => {
    const res = await posta({ key: 'lancio_zoom_link', value: 'http://us06web.zoom.us/j/1' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: 'link_non_https' });
    expect(stato.upsert).toHaveLength(0);
  });

  it('una data senza fuso non si salva: blast e finestre ne dipendono', async () => {
    const res = await posta({ key: 'lancio_evento_at', value: '2026-10-05 21:00' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: 'data_non_valida' });
    expect(stato.upsert).toHaveLength(0);
  });

  it('un corpo senza chiave non fa esplodere la rotta', async () => {
    const res = await posta({});
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('chiave_non_modificabile');
  });
});

describe('POST /api/fenice/lancio-settings — la scrittura e la sua traccia', () => {
  it('l\'interruttore si salva come booleano, come lo scrive il freno automatico', async () => {
    const res = await posta({ key: 'lancio_attivo', value: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, key: 'lancio_attivo', value: true });
    expect(stato.upsert[0]).toMatchObject({ key: 'lancio_attivo', value: true });
  });

  it('un link vuoto azzera: stringa vuota, che parseLancioSettings rilegge come null', async () => {
    stato.righe = { lancio_video_live_link: 'https://corso.feniceacademy.it/vecchio' };
    const res = await posta({ key: 'lancio_video_live_link', value: '' });
    expect(res.status).toBe(200);
    expect(stato.upsert[0]).toMatchObject({ key: 'lancio_video_live_link', value: '' });
  });

  it('ogni cambio lascia in event_log chi, quando, da cosa a cosa', async () => {
    stato.righe = { lancio_sender: 'principale' };
    await posta({ key: 'lancio_sender', value: 'secondario' });
    expect(stato.eventi).toHaveLength(1);
    const e = stato.eventi[0];
    expect(e.type).toBe('lancio_setting_cambiata');
    expect(e.payload).toEqual({
      key: 'lancio_sender',
      old: 'principale',
      new: 'secondario',
      who: 'bruno@esempio.it',
    });
    expect(String(e.message)).toContain('lancio_sender');
    expect(String(e.message)).toContain('bruno@esempio.it');
  });

  it('il "prima" di una chiave mai scritta e\' null, non un errore', async () => {
    await posta({ key: 'lancio_pulsante_attivo', value: '1' });
    expect((stato.eventi[0].payload as Record<string, unknown>).old).toBeNull();
    expect((stato.eventi[0].payload as Record<string, unknown>).new).toBe(true);
  });

  it('senza email in sessione la traccia porta comunque un\'identita\' (l\'id)', async () => {
    stato.utente = { id: 'u-senza-mail', email: null };
    await posta({ key: 'lancio_blast_perimetro', value: 'risposto' });
    expect((stato.eventi[0].payload as Record<string, unknown>).who).toBe('u-senza-mail');
  });

  it('un salvataggio riuscito lo dice anche del registro', async () => {
    const body = await (await posta({ key: 'lancio_attivo', value: true })).json();
    expect(body).toEqual({ ok: true, key: 'lancio_attivo', value: true, audit: true });
  });
});

describe('POST /api/fenice/lancio-settings — quando il DB dice di no', () => {
  // Il pannello e' la manopola d'emergenza della sera del 5: un 200 su una scrittura
  // mai avvenuta farebbe credere a chi guarda lo schermo che il lancio e' spento
  // mentre i messaggi continuano a partire. Meglio un errore in faccia.
  it('se l\'upsert fallisce la rotta risponde 500 e non dice "salvato"', async () => {
    stato.upsertKo = 'permission denied for table app_settings';
    const res = await posta({ key: 'lancio_attivo', value: false });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, errore: 'scrittura_fallita' });
  });

  it('una scrittura fallita non lascia in registro una riga che la da\' per fatta', async () => {
    stato.upsertKo = 'permission denied for table app_settings';
    await posta({ key: 'lancio_attivo', value: false });
    expect(stato.eventi.some((e) => e.type === 'lancio_setting_cambiata')).toBe(false);
  });

  // Il contrario: il registro rotto non deve bloccare la manopola. La scrittura vale,
  // ma chi guarda deve sapere che di quel cambio non resta traccia.
  it('se l\'audit fallisce la scrittura resta valida: 200 con audit false', async () => {
    stato.eventLogKo = new Set(['lancio_setting_cambiata']);
    const res = await posta({ key: 'lancio_attivo', value: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, key: 'lancio_attivo', value: true, audit: false });
    expect(stato.upsert[0]).toMatchObject({ key: 'lancio_attivo', value: true });
  });

  it('un audit fallito prova comunque a lasciare un avviso', async () => {
    stato.eventLogKo = new Set(['lancio_setting_cambiata']);
    await posta({ key: 'lancio_attivo', value: true });
    const avviso = stato.eventi.find((e) => e.type === 'lancio_setting_audit_fallito');
    expect(avviso).toBeDefined();
    expect(avviso?.level).toBe('warn');
    expect((avviso?.payload as Record<string, unknown>).key).toBe('lancio_attivo');
  });

  it('anche con event_log rotto del tutto la rotta risponde, non esplode', async () => {
    stato.eventLogKo = new Set(['lancio_setting_cambiata', 'lancio_setting_audit_fallito']);
    const res = await posta({ key: 'lancio_sender', value: 'secondario' });
    expect(res.status).toBe(200);
    expect((await res.json()).audit).toBe(false);
  });
});
