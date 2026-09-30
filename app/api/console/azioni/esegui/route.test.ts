import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';

const stato = {
  admin: { ok: true, email: 'admin@fenice.com' } as { ok: true; email: string } | { ok: false; risposta: Response },
  usati: new Set<string>(),
  chiamate: [] as { token: string; email: string; origin: string }[],
};

vi.mock('@/lib/supabase/admin', () => ({ getSupabaseAdmin: () => ({}) }));
vi.mock('@/lib/console/guardia', () => ({ richiediAdmin: async () => stato.admin }));
vi.mock('@/lib/console/azioni', async (importOriginal) => {
  const vero = await importOriginal<typeof import('@/lib/console/azioni')>();
  return {
    ...vero,
    esegui: async (token: string, ctx: { email: string; origin: string }) => {
      stato.chiamate.push({ token, email: ctx.email, origin: ctx.origin });
      if (token === 'cambiato') {
        throw new vero.ErroreAzione('conteggio_cambiato', { token: 'nuovo', conteggio: 50 } as never);
      }
      if (token === 'senza-segreto') throw new vero.ErroreAzione('cron_secret_mancante');
      if (stato.usati.has(token)) throw new vero.ErroreAzione('gia_eseguita');
      stato.usati.add(token);
      return { ok: true, fatti: 36, falliti: 2, dettagli: [], messaggio: '36 rinviati al CRM, 2 falliti su 38 candidati' };
    },
  };
});

const { POST } = await import('./route');
const post = (body: unknown) =>
  POST(new Request('https://console.example/api/console/azioni/esegui', {
    method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body),
  }));

beforeEach(() => {
  stato.admin = { ok: true, email: 'admin@fenice.com' };
  stato.usati.clear();
  stato.chiamate = [];
});

describe('POST /api/console/azioni/esegui', () => {
  it('la guardia decide prima di tutto', async () => {
    stato.admin = { ok: false, risposta: NextResponse.json({ error: 'solo_admin' }, { status: 403 }) };
    expect((await post({ token: 't', conferma: true })).status).toBe(403);
    expect(stato.chiamate).toHaveLength(0);
  });
  it('400 senza conferma: true, senza eseguire', async () => {
    expect((await post({ token: 't' })).status).toBe(400);
    expect((await post({ token: 't', conferma: 'true' })).status).toBe(400);
    expect((await post('non json')).status).toBe(400);
    expect((await post({ conferma: true })).status).toBe(400);
    expect(stato.chiamate).toHaveLength(0);
  });
  it('200 con esito, origin dalla richiesta ed email della sessione', async () => {
    const res = await post({ token: 't', conferma: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, fatti: 36, falliti: 2 });
    expect(stato.chiamate[0]).toEqual({ token: 't', email: 'admin@fenice.com', origin: 'https://console.example' });
  });
  it('409 sul token gia\' usato', async () => {
    await post({ token: 't', conferma: true });
    const res = await post({ token: 't', conferma: true });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ errore: 'gia_eseguita' });
  });
  it('409 con la nuova anteprima se il conteggio e\' cambiato', async () => {
    const res = await post({ token: 'cambiato', conferma: true });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ errore: 'conteggio_cambiato', nuovaAnteprima: { token: 'nuovo', conteggio: 50 } });
  });
  it('503 se manca CRON_SECRET', async () => {
    expect((await post({ token: 'senza-segreto', conferma: true })).status).toBe(503);
  });
});
