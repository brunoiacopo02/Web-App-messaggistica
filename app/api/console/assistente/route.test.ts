import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';

const create = vi.hoisted(() => vi.fn());
const stato = vi.hoisted(() => ({
  admin: { ok: true, email: 'admin@fenice.com' } as { ok: true; email: string } | { ok: false; risposta: Response },
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create };
  },
}));
vi.mock('@/lib/console/guardia', () => ({ richiediAdmin: async () => stato.admin }));
vi.mock('@/lib/supabase/admin', () => ({ getSupabaseAdmin: () => ({}) }));
vi.mock('@/lib/lancio-settings', () => ({ getLancioSettings: async () => ({ attivo: true, eventoAt: '2026-10-05T21:00:00+02:00' }) }));
vi.mock('@/lib/console/viste-db', () => ({
  cercaChat: async () => [],
  contaViste: async () => ({ serve_te: 2, non_lette: 0, lancio: 0, fissati_bot: 0, gdo: 0, mario: 0, chiuse: 0, campagne: 0, errori: 0 }),
}));

const { POST, maxDuration } = await import('./route');

const richiesta = (body: unknown) =>
  new Request('http://localhost/api/console/assistente', { method: 'POST', body: JSON.stringify(body) });
const domanda = { messaggi: [{ ruolo: 'utente', testo: 'Quante chat servono a me?' }] };

/** Gli eventi SSE della risposta, nell'ordine. */
async function eventi(res: Response): Promise<{ tipo: string; [k: string]: unknown }[]> {
  const testo = await res.text();
  return testo
    .split('\n')
    .filter((r) => r.startsWith('data: '))
    .map((r) => JSON.parse(r.slice(6)));
}

beforeEach(() => {
  create.mockReset();
  stato.admin = { ok: true, email: 'admin@fenice.com' };
});

describe('POST /api/console/assistente', () => {
  it('uno strumento e poi la risposta: strumento, testo, fine nell\'ordine', async () => {
    create
      .mockResolvedValueOnce({
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'tu_1', name: 'conta_viste', input: {} }],
      })
      .mockResolvedValueOnce({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Due chat aspettano te.' }],
      });

    const res = await POST(richiesta(domanda));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const ev = await eventi(res);
    expect(ev.map((e) => e.tipo)).toEqual(['strumento', 'testo', 'fine']);
    expect(ev[0]).toMatchObject({ tipo: 'strumento', nome: 'conta_viste' });
    expect(ev[1]).toEqual({ tipo: 'testo', testo: 'Due chat aspettano te.' });

    // Il secondo giro riceve il tool_result dello strumento.
    const secondo = create.mock.calls[1][0];
    expect(secondo.model).toBe('claude-sonnet-5');
    const ultimo = secondo.messages.at(-1);
    expect(ultimo.role).toBe('user');
    expect(ultimo.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'tu_1' });
    expect(ultimo.content[0].content).toContain('Serve te: 2');
  });

  it('una proposta emette l\'evento proposta dopo lo strumento', async () => {
    create
      .mockResolvedValueOnce({
        stop_reason: 'tool_use',
        content: [{
          type: 'tool_use', id: 'tu_1', name: 'proponi_azione',
          input: { azione: 'pausa_mario', params: { conversationId: 4 }, motivo: 'Fermare Mario' },
        }],
      })
      .mockResolvedValueOnce({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Ti ho proposto la pausa.' }] });
    const ev = await eventi(await POST(richiesta(domanda)));
    expect(ev.map((e) => e.tipo)).toEqual(['strumento', 'proposta', 'testo', 'citazioni', 'fine']);
    expect(ev[1]).toEqual({ tipo: 'proposta', proposta: { azione: 'pausa_mario', params: { conversationId: 4 }, etichetta: 'Fermare Mario' } });
  });

  it('401 e 403 dalla guardia, senza chiamare il modello', async () => {
    stato.admin = { ok: false, risposta: new NextResponse('unauthorized', { status: 401 }) };
    expect((await POST(richiesta(domanda))).status).toBe(401);
    stato.admin = { ok: false, risposta: NextResponse.json({ error: 'solo_admin' }, { status: 403 }) };
    expect((await POST(richiesta(domanda))).status).toBe(403);
    expect(create).not.toHaveBeenCalled();
  });

  it('400 con messaggi vuoti, troppi o troppo lunghi', async () => {
    expect((await POST(richiesta({ messaggi: [] }))).status).toBe(400);
    const tanti = Array.from({ length: 21 }, () => ({ ruolo: 'utente', testo: 'x' }));
    expect((await POST(richiesta({ messaggi: tanti }))).status).toBe(400);
    expect((await POST(richiesta({ messaggi: [{ ruolo: 'utente', testo: 'x'.repeat(4001) }] }))).status).toBe(400);
    expect((await POST(new Request('http://localhost/api/console/assistente', { method: 'POST', body: 'non json' }))).status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it('eccezione dell\'SDK: evento errore in italiano', async () => {
    create.mockRejectedValueOnce(Object.assign(new Error('rate limited'), { status: 429 }));
    const ev = await eventi(await POST(richiesta(domanda)));
    expect(ev).toHaveLength(1);
    expect(ev[0].tipo).toBe('errore');
    expect(ev[0].messaggio).toMatch(/riprova/i);
  });

  it('oltre 8 giri senza risposta: errore', async () => {
    create.mockResolvedValue({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu', name: 'conta_viste', input: {} }] });
    const ev = await eventi(await POST(richiesta(domanda)));
    expect(create).toHaveBeenCalledTimes(8);
    expect(ev.at(-1)?.tipo).toBe('errore');
  });

  it('oltre 90 secondi: errore che dice di riprovare', async () => {
    vi.useFakeTimers();
    try {
      create.mockImplementation(() => new Promise(() => {}));
      const res = await POST(richiesta(domanda));
      const letti = eventi(res);
      await vi.advanceTimersByTimeAsync(90_000);
      const ev = await letti;
      expect(ev).toEqual([{ tipo: 'errore', messaggio: expect.stringContaining('90 secondi') }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('maxDuration è 120', () => {
    expect(maxDuration).toBe(120);
  });
});
