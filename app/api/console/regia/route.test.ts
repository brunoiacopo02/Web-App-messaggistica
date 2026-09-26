import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';

const chat = (id: number, fase: string, linkAt: string | null = null) => ({
  id, nome: null, telefono: null, slug: 'webdev-2026-10', fase, ingresso: null, benvenutoAt: null, linkAt,
  followupAt: null, lastInboundAt: null, lastMessageAt: null, congedoAt: null, aiStatus: null,
});

const stato = {
  admin: { ok: true, email: 'admin@fenice.com' } as { ok: true; email: string } | { ok: false; risposta: Response },
  attivo: true,
  eventoAt: '2026-10-05T21:00:00+02:00' as string | null,
  consegneRotte: false,
  fotoLette: 0,
  messaggiLetti: 0,
};

vi.mock('@/lib/supabase/admin', () => ({ getSupabaseAdmin: () => ({}) }));
vi.mock('@/lib/console/guardia', () => ({ richiediAdmin: async () => stato.admin }));
vi.mock('@/lib/lancio-monitor-db', () => ({
  fotografia: async () => {
    stato.fotoLette++;
    return {
      settings: { attivo: stato.attivo, eventoAt: stato.eventoAt },
      colonnaInizio: true,
      chats: [chat(1, 'attesa'), chat(2, 'posto_bloccato'), chat(3, 'link_inviato', '2026-10-05T18:55:00Z')],
      eventiContatori: [],
    };
  },
  consegne: async () => {
    if (stato.consegneRotte) throw new Error('twilio giu');
    return { at: '', consegne: null };
  },
}));
vi.mock('@/lib/supabase/paginate', () => ({
  fetchAllRows: async () => {
    stato.messaggiLetti++;
    return [
      { created_at: new Date().toISOString(), twilio_status: 'delivered' },
      { created_at: new Date().toISOString(), twilio_status: 'failed' },
    ];
  },
}));

const { GET } = await import('./route');

beforeEach(() => {
  stato.admin = { ok: true, email: 'admin@fenice.com' };
  stato.attivo = true;
  stato.eventoAt = '2026-10-05T21:00:00+02:00';
  stato.consegneRotte = false;
  stato.fotoLette = 0;
  stato.messaggiLetti = 0;
});

describe('GET /api/console/regia', () => {
  it('401 inoltrato dalla guardia, senza leggere nulla', async () => {
    stato.admin = { ok: false, risposta: new NextResponse('unauthorized', { status: 401 }) };
    const res = await GET();
    expect(res.status).toBe(401);
    expect(stato.fotoLette).toBe(0);
  });

  it('403 inoltrato dalla guardia', async () => {
    stato.admin = { ok: false, risposta: NextResponse.json({ error: 'solo_admin' }, { status: 403 }) };
    const res = await GET();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'solo_admin' });
  });

  it('lancio spento: attivo false, niente scaletta e niente lettura dei messaggi', async () => {
    stato.attivo = false;
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.attivo).toBe(false);
    expect(body.stato).toEqual({ stato: 'nessuno', secondi: 0 });
    expect(body.scaletta).toEqual([]);
    expect(body.perOra).toHaveLength(24);
    expect(stato.messaggiLetti).toBe(0);
  });

  it('lancio acceso: numeri, fasi e consegne di oggi, anche se le consegne per template cadono', async () => {
    stato.consegneRotte = true;
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.attivo).toBe(true);
    expect(body.scaletta.map((v: { voce: string }) => v.voce)).toEqual(['link', 'inizio', 'pitch', 'chiusura']);
    expect(body.numeri).toEqual({ iscritti: 3, postoBloccato: 1, linkInviati: 1, consegnatiOggi: 1, fallitiOggi: 1 });
    expect(body.perFase).toMatchObject({ attesa: 1, posto_bloccato: 1, link_inviato: 1 });
    expect(body.perOra).toHaveLength(24);
    expect(typeof body.generatoAt).toBe('string');
  });
});
