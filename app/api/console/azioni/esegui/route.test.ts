import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';
import { clienteFinto } from '@/lib/console/__finti__/cliente';

// Logica vera di lib/console/azioni: finti solo la guardia e il client Supabase.
const stato = {
  admin: { ok: true, email: 'admin@fenice.com' } as { ok: true; email: string } | { ok: false; risposta: Response },
  cliente: clienteFinto(),
};
vi.mock('@/lib/supabase/admin', () => ({ getSupabaseAdmin: () => stato.cliente.s }));
vi.mock('@/lib/console/guardia', () => ({ richiediAdmin: async () => stato.admin }));

const { POST } = await import('./route');
const { anteprima } = await import('@/lib/console/azioni');
const post = (body: unknown) =>
  POST(new Request('https://console.example/api/console/azioni/esegui', {
    method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body),
  }));
const nuovoToken = async () =>
  (await anteprima('interruttore', { chiave: 'lancio_attivo', valore: true }, {
    s: stato.cliente.s, origin: 'https://console.example', email: 'admin@fenice.com', now: new Date(),
  })).token;

beforeEach(() => {
  stato.admin = { ok: true, email: 'admin@fenice.com' };
  stato.cliente = clienteFinto({ settings: { lancio_attivo: false } });
  process.env.CRON_SECRET = 'x';
});

describe('POST /api/console/azioni/esegui', () => {
  it('la guardia decide prima di tutto', async () => {
    stato.admin = { ok: false, risposta: NextResponse.json({ error: 'solo_admin' }, { status: 403 }) };
    expect((await post({ token: await nuovoToken(), conferma: true })).status).toBe(403);
    expect(stato.cliente.scritture).toHaveLength(0);
  });
  it('400 senza conferma: true, senza eseguire', async () => {
    const token = await nuovoToken();
    expect((await post({ token })).status).toBe(400);
    expect((await post({ token, conferma: 'true' })).status).toBe(400);
    expect((await post('non json')).status).toBe(400);
    expect((await post({ conferma: true })).status).toBe(400);
    expect(stato.cliente.scritture).toHaveLength(0);
  });
  it('200 con esito, poi 409 gia_eseguita sullo stesso token', async () => {
    const token = await nuovoToken();
    const res = await post({ token, conferma: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, fatti: 1, messaggio: 'lancio_attivo: spento → acceso' });
    const ancora = await post({ token, conferma: true });
    expect(ancora.status).toBe(409);
    expect(await ancora.json()).toEqual({ errore: 'gia_eseguita' });
    expect(stato.cliente.scritture.filter((x) => x.op === 'upsert')).toHaveLength(1);
  });
  it('409 anteprima_scaduta su un token alterato', async () => {
    const res = await post({ token: `${await nuovoToken()}x`, conferma: true });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ errore: 'anteprima_scaduta' });
  });
  it('409 azione_in_corso con il messaggio per l\'admin', async () => {
    const token = await nuovoToken();
    stato.cliente.eventi.push({
      id: 99, created_at: new Date().toISOString(), type: 'console_azione_avviata',
      payload: { nonce: 'altro', azione: 'interruttore', params: { chiave: 'lancio_attivo', valore: true } },
    });
    const res = await post({ token, conferma: true });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.errore).toBe('azione_in_corso');
    expect(body.messaggio).toMatch(/^Questa azione è già in corso da \d\d:\d\d\. Aspetta che finisca\.$/);
  });
  it('503 se manca CRON_SECRET', async () => {
    const token = await nuovoToken();
    delete process.env.CRON_SECRET;
    expect((await post({ token, conferma: true })).status).toBe(503);
  });
});
