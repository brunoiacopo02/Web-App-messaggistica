import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const stato = { utente: null as { id: string; email: string | null } | null, lette: 0 };

vi.mock('@/lib/supabase/server', () => ({
  getSupabaseServer: async () => ({ auth: { getUser: async () => ({ data: { user: stato.utente } }) } }),
}));
vi.mock('@/lib/supabase/admin', () => ({ getSupabaseAdmin: () => ({}) }));
vi.mock('@/lib/lancio-monitor-db', () => ({
  fotografia: async () => {
    stato.lette++;
    return {
      generatoAt: '2026-10-05T19:00:00.000Z',
      settings: { attivo: true, pulsanteAttivo: true, eventoAt: '2026-10-05T21:00:00+02:00', blastPerimetro: 'tutti', videoLiveLink: null, zoomLink: 'z', sender: 'principale', quotaSecondario: 0, offertaDelMeseLink: null },
      colonnaInizio: false,
      chats: [{ id: 1, nome: 'Mario', telefono: '+39333', slug: 'webdev-2026-10', fase: 'post_pitch', ingresso: 'lista', benvenutoAt: null, linkAt: null, followupAt: null, lastInboundAt: null, lastMessageAt: null, congedoAt: null, aiStatus: 'active' }],
      eventiContatori: [], eventiAvviso: [], statiTwilio: [], ultimiRun: {}, pulsante: new Set([1]),
    };
  },
  consegne: async () => { throw new Error('messages lento'); },
  arricchisciPagina: async () => ({ anteprime: new Map([[1, 'ciao']]), ultimoBot: new Map() }),
}));

const { GET } = await import('./route');
const req = (qs = '') => new NextRequest(`http://x/api/fenice/lancio-monitor${qs}`);

beforeEach(() => { stato.utente = null; stato.lette = 0; });

describe('GET /api/fenice/lancio-monitor', () => {
  it('senza sessione: 401, senza leggere niente', async () => {
    expect((await GET(req())).status).toBe(401);
    expect(stato.lette).toBe(0);
  });

  it('account confinato a /fenice (il bot): 403', async () => {
    stato.utente = { id: 'b', email: 'fenicebot@fenice.com' };
    expect((await GET(req())).status).toBe(403);
    expect(stato.lette).toBe(0);
  });

  it('admin: contatori, avvisi e lista; le consegne fallite non fanno cadere la pagina', async () => {
    stato.utente = { id: 'a', email: 'brunoiacopo02@gmail.com' };
    const r = await GET(req('?pulsante=1'));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.erroreConsegne).toBe('messages lento');
    expect(j.contatori.benvenutiConsegnati).toBeNull();
    expect(j.contatori.messaggio21Inviati).toBeNull();
    expect(j.lista.totale).toBe(1);
    expect(j.lista.righe[0]).toMatchObject({ id: 1, anteprima: 'ciao', pulsante: true, problemi: false });
    expect(Array.isArray(j.avvisi)).toBe(true);
  });
});
