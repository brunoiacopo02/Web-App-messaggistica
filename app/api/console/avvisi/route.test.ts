import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';

const stato = {
  admin: { ok: true, email: 'admin@fenice.com' } as { ok: true; email: string } | { ok: false; risposta: Response },
  avvisi: [] as unknown[],
  errore: null as string | null,
  inseriti: [] as unknown[],
  erroreInsert: null as string | null,
  lette: 0,
};

vi.mock('@/lib/supabase/admin', () => ({
  getSupabaseAdmin: () => ({
    from: (t: string) => ({
      insert: async (riga: unknown) => {
        stato.inseriti.push({ t, riga });
        return { error: stato.erroreInsert ? { message: stato.erroreInsert } : null };
      },
    }),
  }),
}));
vi.mock('@/lib/console/guardia', () => ({ richiediAdmin: async () => stato.admin }));
vi.mock('@/lib/console/avvisi-db', () => ({
  leggiAvvisi: async () => {
    stato.lette++;
    if (stato.errore) throw new Error(stato.errore);
    return stato.avvisi;
  },
}));

const { GET, POST } = await import('./route');
const post = (body: unknown) =>
  POST(new Request('http://x/api/console/avvisi', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }));

beforeEach(() => {
  stato.admin = { ok: true, email: 'admin@fenice.com' };
  stato.avvisi = [{ id: 'crm' }];
  stato.errore = null;
  stato.inseriti = [];
  stato.erroreInsert = null;
  stato.lette = 0;
});

describe('GET /api/console/avvisi', () => {
  it('401 dalla guardia senza leggere', async () => {
    stato.admin = { ok: false, risposta: new NextResponse('unauthorized', { status: 401 }) };
    expect((await GET()).status).toBe(401);
    expect(stato.lette).toBe(0);
  });
  it('403 dalla guardia', async () => {
    stato.admin = { ok: false, risposta: NextResponse.json({ error: 'solo_admin' }, { status: 403 }) };
    expect((await GET()).status).toBe(403);
  });
  it('200 con avvisi e generatoAt', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.avvisi).toEqual([{ id: 'crm' }]);
    expect(Number.isNaN(Date.parse(body.generatoAt))).toBe(false);
  });
  it('un errore di lettura torna 500', async () => {
    stato.errore = 'db giu';
    const res = await GET();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'lettura_fallita', dettaglio: 'db giu' });
  });
});

describe('POST /api/console/avvisi', () => {
  it('401 e 403 dalla guardia, senza scrivere', async () => {
    stato.admin = { ok: false, risposta: new NextResponse('unauthorized', { status: 401 }) };
    expect((await post({ id: 'a', firma: 'f' })).status).toBe(401);
    stato.admin = { ok: false, risposta: NextResponse.json({ error: 'solo_admin' }, { status: 403 }) };
    expect((await post({ id: 'a', firma: 'f' })).status).toBe(403);
    expect(stato.inseriti).toEqual([]);
  });
  it('400 senza id, con nota troppo lunga o con corpo non JSON', async () => {
    expect((await post({ firma: 'f' })).status).toBe(400);
    expect((await post({ id: 'a', firma: 'f', nota: 'x'.repeat(501) })).status).toBe(400);
    expect((await post('non json')).status).toBe(400);
    expect(stato.inseriti).toEqual([]);
  });
  it('ok scrive console_avviso_risolto con by = email', async () => {
    const res = await post({ id: 'gdo_agenda_error', firma: 'gdo_agenda_error:2:2026-10-05T18:40:00Z', nota: 'gestito a mano' });
    expect(res.status).toBe(200);
    expect(stato.inseriti).toHaveLength(1);
    expect(stato.inseriti[0]).toMatchObject({
      t: 'event_log',
      riga: {
        type: 'console_avviso_risolto',
        payload: { id: 'gdo_agenda_error', firma: 'gdo_agenda_error:2:2026-10-05T18:40:00Z', nota: 'gestito a mano', by: 'admin@fenice.com' },
      },
    });
  });
  it('un errore di scrittura torna 500', async () => {
    stato.erroreInsert = 'rls';
    expect((await post({ id: 'a', firma: 'f' })).status).toBe(500);
  });
});
