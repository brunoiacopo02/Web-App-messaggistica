import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';
import { clienteFinto } from '@/lib/console/__finti__/cliente';

const stato = {
  admin: { ok: true, email: 'admin@fenice.com' } as { ok: true; email: string } | { ok: false; risposta: Response },
  cliente: clienteFinto(),
};
vi.mock('@/lib/supabase/admin', () => ({ getSupabaseAdmin: () => stato.cliente.s }));
vi.mock('@/lib/console/guardia', () => ({ richiediAdmin: async () => stato.admin }));

const { GET } = await import('./route');

beforeEach(() => {
  stato.admin = { ok: true, email: 'admin@fenice.com' };
  stato.cliente = clienteFinto({
    eventi: [
      { type: 'console_azione', created_at: '2026-09-30T09:00:00Z', message: 'a' },
      { type: 'console_azione_avviata', created_at: '2026-09-30T09:30:00Z', message: 'avvio' },
      { type: 'console_azione', created_at: '2026-09-30T10:00:00Z', message: 'b' },
    ],
  });
});

describe('GET /api/console/azioni/registro', () => {
  it('403 dalla guardia', async () => {
    stato.admin = { ok: false, risposta: NextResponse.json({ error: 'solo_admin' }, { status: 403 }) };
    expect((await GET()).status).toBe(403);
  });
  it('solo console_azione, dalla piu\' recente', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const { azioni } = await res.json();
    expect(azioni.map((r: { message: string }) => r.message)).toEqual(['b', 'a']);
  });
});
