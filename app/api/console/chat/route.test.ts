import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const stato = {
  admin: { ok: true, email: 'admin@fenice.com' } as
    | { ok: true; email: string }
    | { ok: false; risposta: Response },
  risultato: { righe: [], prossimo: null } as { righe: unknown[]; prossimo: string | null },
  errore: null as string | null,
  chiamate: [] as Record<string, unknown>[],
};

vi.mock('@/lib/supabase/admin', () => ({ getSupabaseAdmin: () => ({}) }));
vi.mock('@/lib/console/guardia', () => ({ richiediAdmin: async () => stato.admin }));
vi.mock('@/lib/console/viste-db', () => ({
  paginaChat: async (_s: unknown, p: Record<string, unknown>) => {
    stato.chiamate.push(p);
    if (stato.errore) throw new Error(stato.errore);
    return stato.risultato;
  },
}));

const { GET } = await import('./route');
const req = (qs = '') => new NextRequest(`http://x/api/console/chat${qs}`);

beforeEach(() => {
  stato.admin = { ok: true, email: 'admin@fenice.com' };
  stato.risultato = { righe: [], prossimo: null };
  stato.errore = null;
  stato.chiamate = [];
});

describe('GET /api/console/chat', () => {
  it('401 inoltrato dalla guardia, senza leggere la pagina', async () => {
    stato.admin = { ok: false, risposta: new NextResponse('unauthorized', { status: 401 }) };
    const res = await GET(req('?vista=mario'));
    expect(res.status).toBe(401);
    expect(stato.chiamate).toHaveLength(0);
  });

  it('403 inoltrato dalla guardia', async () => {
    stato.admin = { ok: false, risposta: NextResponse.json({ error: 'solo_admin' }, { status: 403 }) };
    const res = await GET(req('?vista=mario'));
    expect(res.status).toBe(403);
  });

  it('vista mancante o non valida: 400', async () => {
    const res = await GET(req(''));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'vista_non_valida' });
    expect(stato.chiamate).toHaveLength(0);
  });

  it('vista=xyz: 400', async () => {
    const res = await GET(req('?vista=xyz'));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'vista_non_valida' });
  });

  it('200 con la forma attesa e i parametri passati a paginaChat', async () => {
    stato.risultato = { righe: [{ id: 1 }], prossimo: 'abc' };
    const res = await GET(req('?vista=mario&fase=post_pitch&solo=non_lette&q=rossi&cursore=xyz'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(stato.risultato);
    expect(stato.chiamate[0]).toMatchObject({
      vista: 'mario', fase: 'post_pitch', soloNonLette: true, q: 'rossi', cursore: 'xyz',
    });
  });

  it('una fase non riconosciuta viene ignorata invece di rompere la query', async () => {
    await GET(req('?vista=mario&fase=non_esiste'));
    expect(stato.chiamate[0].fase).toBeUndefined();
  });

  it('un errore di lettura torna 500', async () => {
    stato.errore = 'query fallita';
    const res = await GET(req('?vista=mario'));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'lettura_fallita', dettaglio: 'query fallita' });
  });
});
