import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const stato = {
  admin: { ok: true, email: 'admin@fenice.com' } as
    | { ok: true; email: string }
    | { ok: false; risposta: Response },
  righe: [] as unknown[],
  errore: null as string | null,
  chiamate: [] as string[],
};

vi.mock('@/lib/supabase/admin', () => ({ getSupabaseAdmin: () => ({}) }));
vi.mock('@/lib/console/guardia', () => ({ richiediAdmin: async () => stato.admin }));
vi.mock('@/lib/console/viste-db', () => ({
  cercaChat: async (_s: unknown, q: string) => {
    stato.chiamate.push(q);
    if (stato.errore) throw new Error(stato.errore);
    return stato.righe;
  },
}));

const { GET } = await import('./route');
const req = (qs = '') => new NextRequest(`http://x/api/console/cerca${qs}`);

beforeEach(() => {
  stato.admin = { ok: true, email: 'admin@fenice.com' };
  stato.righe = [];
  stato.errore = null;
  stato.chiamate = [];
});

describe('GET /api/console/cerca', () => {
  it('401 inoltrato dalla guardia, senza cercare', async () => {
    stato.admin = { ok: false, risposta: new NextResponse('unauthorized', { status: 401 }) };
    const res = await GET(req('?q=rossi'));
    expect(res.status).toBe(401);
    expect(stato.chiamate).toHaveLength(0);
  });

  it('senza q: 400', async () => {
    const res = await GET(req(''));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'q_non_valida' });
    expect(stato.chiamate).toHaveLength(0);
  });

  it('q di soli spazi: 400', async () => {
    const res = await GET(req('?q=%20%20'));
    expect(res.status).toBe(400);
    expect(stato.chiamate).toHaveLength(0);
  });

  it('q oltre 100 caratteri: 400', async () => {
    const res = await GET(req(`?q=${'a'.repeat(101)}`));
    expect(res.status).toBe(400);
    expect(stato.chiamate).toHaveLength(0);
  });

  it('200 con { righe } e la ricerca passata a cercaChat', async () => {
    stato.righe = [{ id: 7, nome: 'Giulia Rossi' }];
    const res = await GET(req('?q=%20rossi%20'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ righe: stato.righe });
    expect(stato.chiamate).toEqual(['rossi']);
  });

  it('un errore di lettura torna 500', async () => {
    stato.errore = 'query fallita';
    const res = await GET(req('?q=rossi'));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'lettura_fallita', dettaglio: 'query fallita' });
  });
});
