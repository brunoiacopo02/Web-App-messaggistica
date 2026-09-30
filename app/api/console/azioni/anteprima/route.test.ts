import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';
import { clienteFinto } from '@/lib/console/__finti__/cliente';

const stato = {
  admin: { ok: true, email: 'admin@fenice.com' } as { ok: true; email: string } | { ok: false; risposta: Response },
  cliente: clienteFinto(),
  fetch: [] as string[],
};
vi.mock('@/lib/supabase/admin', () => ({ getSupabaseAdmin: () => stato.cliente.s }));
vi.mock('@/lib/console/guardia', () => ({ richiediAdmin: async () => stato.admin }));

const { POST } = await import('./route');
const post = (body: unknown) =>
  POST(new Request('https://console.example/api/console/azioni/anteprima', { method: 'POST', body: JSON.stringify(body) }));

beforeEach(() => {
  stato.admin = { ok: true, email: 'admin@fenice.com' };
  stato.cliente = clienteFinto({ settings: { lancio_attivo: false } });
  stato.fetch = [];
  process.env.CRON_SECRET = 'x';
  vi.stubGlobal('fetch', async (u: string) => { stato.fetch.push(u); return new Response('{}'); });
});

describe('POST /api/console/azioni/anteprima', () => {
  it('403 dalla guardia, senza chiamare niente', async () => {
    stato.admin = { ok: false, risposta: NextResponse.json({ error: 'solo_admin' }, { status: 403 }) };
    expect((await post({ azione: 'rinvia_esiti_403', params: {} })).status).toBe(403);
    expect(stato.fetch).toHaveLength(0);
  });
  it('400 su azione sconosciuta', async () => {
    const res = await post({ azione: 'cancella_tutto', params: {} });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ errore: 'azione_sconosciuta' });
  });
  it('400 su parametri non validi, senza chiamare niente', async () => {
    const res = await post({ azione: 'rilancia_cron', params: { cron: 'rm -rf' } });
    expect(res.status).toBe(400);
    expect((await res.json()).errore).toBe('parametri_non_validi');
    expect(stato.fetch).toHaveLength(0);
  });
  it('200 con token firmato e nessuna scrittura', async () => {
    const res = await post({ azione: 'interruttore', params: { chiave: 'lancio_attivo', valore: true } });
    expect(res.status).toBe(200);
    const a = await res.json();
    expect(a.token.split('.')).toHaveLength(2);
    expect(a.descrizione).toBe('lancio_attivo: spento → acceso');
    expect(stato.cliente.scritture).toHaveLength(0);
  });
  it('409 azione_in_corso', async () => {
    stato.cliente.eventi.push({
      id: 1, created_at: new Date().toISOString(), type: 'console_azione_avviata',
      payload: { nonce: 'n', azione: 'interruttore', params: { valore: true, chiave: 'lancio_attivo' } },
    });
    const res = await post({ azione: 'interruttore', params: { chiave: 'lancio_attivo', valore: true } });
    expect(res.status).toBe(409);
    expect((await res.json()).messaggio).toContain('già in corso');
  });
});
