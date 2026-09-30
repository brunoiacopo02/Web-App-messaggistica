import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';
import { clienteFinto, type Riga } from '@/lib/console/__finti__/cliente';

const stato = {
  admin: { ok: true, email: 'admin@fenice.com' } as { ok: true; email: string } | { ok: false; risposta: Response },
  cliente: clienteFinto(),
};
vi.mock('@/lib/supabase/admin', () => ({ getSupabaseAdmin: () => stato.cliente.s }));
vi.mock('@/lib/console/guardia', () => ({ richiediAdmin: async () => stato.admin }));

const { GET } = await import('./route');
const get = (qs = '') => GET(new Request(`http://x/api/console/log${qs}`));

const MINUTO = 60_000;
/** Un evento `minutiFa` minuti fa, con `created_at` nel formato di `toISOString` (come il cursore). */
function evento(minutiFa: number, extra: Riga = {}): Riga {
  return { type: 'bot_reply', level: 'info', message: `e${minutiFa}`, created_at: new Date(Date.now() - minutiFa * MINUTO).toISOString(), ...extra };
}

type Risposta = { righe: { message: string; level: string; created_at: string }[]; prossimo: string | null };

beforeEach(() => {
  stato.admin = { ok: true, email: 'admin@fenice.com' };
  stato.cliente = clienteFinto({
    eventi: [
      evento(1),
      evento(2, { level: 'error', type: 'twilio_errore' }),
      evento(3, { level: 'warn' }),
      evento(4, { level: 'error', type: 'cron_errore', payload: { conversationId: 42 } }),
      evento(5, { payload: { conversationId: 42 } }),
    ],
  });
});

describe('GET /api/console/log', () => {
  it('401 senza sessione', async () => {
    stato.admin = { ok: false, risposta: new NextResponse('unauthorized', { status: 401 }) };
    expect((await get()).status).toBe(401);
  });

  it('403 per chi non è admin', async () => {
    stato.admin = { ok: false, risposta: NextResponse.json({ error: 'solo_admin' }, { status: 403 }) };
    expect((await get()).status).toBe(403);
  });

  it('senza filtri: tutti, dal più recente', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    const { righe } = (await res.json()) as Risposta;
    expect(righe.map((r) => r.message)).toEqual(['e1', 'e2', 'e3', 'e4', 'e5']);
  });

  it('livello=error filtra', async () => {
    const { righe } = (await (await get('?livello=error')).json()) as Risposta;
    expect(righe.map((r) => r.message)).toEqual(['e2', 'e4']);
  });

  it('tipo e conv filtrano', async () => {
    expect(((await (await get('?tipo=cron_errore')).json()) as Risposta).righe.map((r) => r.message)).toEqual(['e4']);
    expect(((await (await get('?conv=42')).json()) as Risposta).righe.map((r) => r.message)).toEqual(['e4', 'e5']);
  });

  it('prima=<iso> pagina: solo gli eventi precedenti (esclusivo)', async () => {
    const prima = String(stato.cliente.eventi.find((e) => e.message === 'e3')!.created_at);
    const res = await get(`?prima=${encodeURIComponent(prima)}`);
    expect(res.status).toBe(200);
    const { righe } = (await res.json()) as Risposta;
    expect(righe.map((r) => r.message)).toEqual(['e4', 'e5']);
  });

  it('limite 100, e il cursore della pagina dopo è il created_at dell\'ultima riga', async () => {
    stato.cliente = clienteFinto({ eventi: Array.from({ length: 150 }, (_, i) => evento(i + 1)) });
    const { righe, prossimo } = (await (await get()).json()) as Risposta;
    expect(righe).toHaveLength(100);
    expect(righe[0].message).toBe('e1');
    expect(prossimo).toBe(righe[99].created_at);

    const seconda = (await (await get(`?prima=${encodeURIComponent(prossimo!)}`)).json()) as Risposta;
    expect(seconda.righe).toHaveLength(50);
    expect(seconda.righe[0].message).toBe('e101');
  });

  it('parametri non validi: 400', async () => {
    expect((await get('?livello=grave')).status).toBe(400);
    expect((await get('?conv=abc')).status).toBe(400);
    expect((await get('?prima=ieri')).status).toBe(400);
    expect((await get('?tipo=' + encodeURIComponent("x'; drop"))).status).toBe(400);
  });
});
