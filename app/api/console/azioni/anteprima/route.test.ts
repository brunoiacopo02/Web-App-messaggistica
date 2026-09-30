import { describe, it, expect, vi, beforeEach } from 'vitest';

const stato = { fetch: [] as string[] };
vi.mock('@/lib/supabase/admin', () => ({ getSupabaseAdmin: () => ({}) }));
vi.mock('@/lib/console/guardia', () => ({ richiediAdmin: async () => ({ ok: true, email: 'admin@fenice.com' }) }));

const { POST } = await import('./route');
const post = (body: unknown) =>
  POST(new Request('https://console.example/api/console/azioni/anteprima', { method: 'POST', body: JSON.stringify(body) }));

beforeEach(() => {
  stato.fetch = [];
  process.env.CRON_SECRET = 'x';
  vi.stubGlobal('fetch', async (u: string) => { stato.fetch.push(u); return new Response('{}'); });
});

describe('POST /api/console/azioni/anteprima', () => {
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
});
