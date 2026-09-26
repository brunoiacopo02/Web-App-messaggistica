import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

type Riga = { id: number; created_at: string };

const stato = {
  admin: { ok: true, email: 'admin@fenice.com' } as
    | { ok: true; email: string }
    | { ok: false; risposta: Response },
  nelPerimetro: true,
  righe: [] as Riga[],
  query: [] as { filtri: [string, string, unknown][]; ordini: [string, boolean][]; limite?: number }[],
};

/** Query builder finto che applica davvero filtri `eq`/`gt`, ordini e limite alle righe. */
function builder() {
  const q = { filtri: [] as [string, string, unknown][], ordini: [] as [string, boolean][], limite: undefined as number | undefined };
  stato.query.push(q);
  const esegui = () => {
    let r = stato.righe.filter((x) =>
      q.filtri.every(([op, c, v]) => (op === 'gt' ? (x as Record<string, unknown>)[c] as number > (v as number) : true)),
    );
    r = [...r].sort((a, b) => {
      for (const [c, asc] of q.ordini) {
        const va = (a as Record<string, unknown>)[c] as string | number;
        const vb = (b as Record<string, unknown>)[c] as string | number;
        if (va !== vb) return (va < vb ? -1 : 1) * (asc ? 1 : -1);
      }
      return 0;
    });
    if (q.limite != null) r = r.slice(0, q.limite);
    return { data: r, error: null };
  };
  const b: Record<string, unknown> = {
    select: () => b,
    eq: (c: string, v: unknown) => (q.filtri.push(['eq', c, v]), b),
    gt: (c: string, v: unknown) => (q.filtri.push(['gt', c, v]), b),
    order: (c: string, o: { ascending: boolean }) => (q.ordini.push([c, o.ascending]), b),
    limit: (n: number) => ((q.limite = n), b),
    then: (ok: (x: unknown) => unknown) => Promise.resolve(esegui()).then(ok),
  };
  return b;
}

vi.mock('@/lib/supabase/admin', () => ({ getSupabaseAdmin: () => ({ from: builder }) }));
vi.mock('@/lib/console/guardia', () => ({ richiediAdmin: async () => stato.admin }));
vi.mock('@/lib/chat-perimetro', () => ({ isConversazioneChat: async () => stato.nelPerimetro }));

const { GET } = await import('./route');
const chiama = (id: string, qs = '') =>
  GET(new NextRequest(`http://x/api/console/chat/${id}/messaggi${qs}`), { params: Promise.resolve({ id }) });

const ts = (i: number) => new Date(Date.UTC(2026, 8, 1) + i * 60_000).toISOString();

beforeEach(() => {
  stato.admin = { ok: true, email: 'admin@fenice.com' };
  stato.nelPerimetro = true;
  stato.righe = Array.from({ length: 620 }, (_, i) => ({ id: i + 1, created_at: ts(i) }));
  stato.query = [];
});

describe('GET /api/console/chat/[id]/messaggi', () => {
  it('401 e 403 inoltrati dalla guardia, senza leggere', async () => {
    stato.admin = { ok: false, risposta: new NextResponse('unauthorized', { status: 401 }) };
    expect((await chiama('42')).status).toBe(401);
    stato.admin = { ok: false, risposta: NextResponse.json({ error: 'solo_admin' }, { status: 403 }) };
    expect((await chiama('42')).status).toBe(403);
    expect(stato.query).toHaveLength(0);
  });

  it('400 su id o dopo non numerici', async () => {
    expect((await chiama('abc')).status).toBe(400);
    const r = await chiama('42', '?dopo=x1');
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: 'dopo_non_valido' });
  });

  it('404 fuori perimetro', async () => {
    stato.nelPerimetro = false;
    const r = await chiama('42');
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: 'chat_non_trovata' });
  });

  it('gli ULTIMI 500, in ordine crescente', async () => {
    const j = await (await chiama('42')).json();
    const ids = (j.messaggi as Riga[]).map((m) => m.id);
    expect(ids).toHaveLength(500);
    expect(ids[0]).toBe(121);
    expect(ids[499]).toBe(620);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(stato.query[0].filtri).toContainEqual(['eq', 'conversation_id', 42]);
  });

  it('dopo=<id>: solo i più nuovi, crescenti', async () => {
    const j = await (await chiama('42', '?dopo=615')).json();
    expect((j.messaggi as Riga[]).map((m) => m.id)).toEqual([616, 617, 618, 619, 620]);
  });
});
