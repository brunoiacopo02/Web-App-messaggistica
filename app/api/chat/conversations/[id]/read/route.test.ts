import { describe, it, expect, vi, beforeEach } from 'vitest';

/** Finto Supabase: la lettura di `ai_owner` e i due update della marcatura. */
const stato = {
  utente: { id: 'u1', email: 'fenice@academy.com' } as { id: string; email: string } | null,
  nelPerimetro: true,
  aiOwner: 'mario' as string | null,
  update: [] as { tabella: string; valori: Record<string, unknown> }[],
};

function catena(tabella: string) {
  const q: Record<string, unknown> = {
    select: () => q,
    eq: () => q,
    is: () => q,
    maybeSingle: () => Promise.resolve({ data: { ai_owner: stato.aiOwner }, error: null }),
    update: (valori: Record<string, unknown>) => {
      stato.update.push({ tabella, valori });
      const u: Record<string, unknown> = {
        eq: () => u,
        is: () => u,
        then: (ok: (v: unknown) => unknown) => ok({ error: null }),
      };
      return u;
    },
  };
  return q;
}

vi.mock('@/lib/supabase/server', () => ({
  getSupabaseServer: () => Promise.resolve({
    auth: { getUser: () => Promise.resolve({ data: { user: stato.utente }, error: null }) },
    from: (t: string) => catena(t),
  }),
}));

vi.mock('@/lib/chat-perimetro', () => ({
  isConversazioneChat: () => Promise.resolve(stato.nelPerimetro),
}));

import { POST } from './route';

const chiama = (id = '42') => POST(new Request('http://x/api/chat/conversations/42/read', { method: 'POST' }), {
  params: Promise.resolve({ id }),
});

beforeEach(() => {
  stato.utente = { id: 'u1', email: 'fenice@academy.com' };
  stato.nelPerimetro = true;
  stato.aiOwner = 'mario';
  stato.update = [];
});

describe('POST /api/chat/conversations/[id]/read', () => {
  it('chat governata dal bot: azzera unread_count e segna letti i messaggi', async () => {
    const res = await chiama();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, marked: true });
    expect(stato.update.map((u) => u.tabella)).toEqual(['messages', 'conversations']);
    expect(stato.update[1].valori).toEqual({ unread_count: 0 });
  });

  it('chat di campagna (non del bot): non tocca il contatore di /campagne-chat', async () => {
    stato.aiOwner = null;
    const res = await chiama();
    expect(await res.json()).toEqual({ ok: true, marked: false });
    expect(stato.update).toEqual([]);
  });

  it('fuori perimetro: 404 senza scritture', async () => {
    stato.nelPerimetro = false;
    const res = await chiama();
    expect(res.status).toBe(404);
    expect(stato.update).toEqual([]);
  });

  it('senza sessione: 401', async () => {
    stato.utente = null;
    expect((await chiama()).status).toBe(401);
  });

  it('id non numerico: 400', async () => {
    expect((await chiama('abc')).status).toBe(400);
  });
});
