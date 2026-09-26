import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';

const stato = {
  admin: { ok: true, email: 'admin@fenice.com' } as
    | { ok: true; email: string }
    | { ok: false; risposta: Response },
  conteggi: {} as Record<string, number>,
  errore: null as string | null,
  lette: 0,
};

vi.mock('@/lib/supabase/admin', () => ({ getSupabaseAdmin: () => ({}) }));
vi.mock('@/lib/console/guardia', () => ({ richiediAdmin: async () => stato.admin }));
vi.mock('@/lib/console/viste-db', () => ({
  contaViste: async () => {
    stato.lette++;
    if (stato.errore) throw new Error(stato.errore);
    return stato.conteggi;
  },
}));

const { GET } = await import('./route');

beforeEach(() => {
  stato.admin = { ok: true, email: 'admin@fenice.com' };
  stato.conteggi = { serve_te: 2, non_lette: 3, lancio: 0, fissati_bot: 1, gdo: 5, mario: 4, chiuse: 0, campagne: 1, errori: 0 };
  stato.errore = null;
  stato.lette = 0;
});

describe('GET /api/console/viste', () => {
  it('401 inoltrato dalla guardia, senza leggere i conteggi', async () => {
    stato.admin = { ok: false, risposta: new NextResponse('unauthorized', { status: 401 }) };
    const res = await GET();
    expect(res.status).toBe(401);
    expect(stato.lette).toBe(0);
  });

  it('403 inoltrato dalla guardia', async () => {
    stato.admin = { ok: false, risposta: NextResponse.json({ error: 'solo_admin' }, { status: 403 }) };
    const res = await GET();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'solo_admin' });
  });

  it('200 con i conteggi e generatoAt', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.conteggi).toEqual(stato.conteggi);
    expect(typeof body.generatoAt).toBe('string');
    expect(Number.isNaN(Date.parse(body.generatoAt))).toBe(false);
  });

  it('un errore di lettura torna 500', async () => {
    stato.errore = 'db giu\'';
    const res = await GET();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'lettura_fallita', dettaglio: 'db giu\'' });
  });
});
