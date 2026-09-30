import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Finto client Supabase: ogni `.from(tabella)` apre una catena che registra i metodi
 * chiamati e si risolve secondo l'handler configurato per quella tabella. `.then` la
 * rende awaitable esattamente come una query supabase-js vera, senza eseguire nulla
 * finché non viene attesa.
 */
type Chiamata = [string, unknown[]];
function fintoSupa(handlers: Partial<Record<string, (calls: Chiamata[]) => Promise<Record<string, unknown>>>>) {
  const fromCalls: string[] = [];
  const metodi = ['select', 'eq', 'gte', 'lte', 'gt', 'lt', 'order', 'range', 'or', 'is', 'not', 'in', 'limit'];
  const s = {
    fromCalls,
    from(table: string) {
      fromCalls.push(table);
      const calls: Chiamata[] = [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const q: any = {};
      for (const m of metodi) q[m] = (...args: unknown[]) => { calls.push([m, args]); return q; };
      q.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
        const handler = handlers[table];
        const p = handler ? handler(calls) : Promise.resolve({ data: [], error: null });
        return p.then(resolve, reject);
      };
      return q;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  return s;
}

beforeEach(() => {
  vi.resetModules();
});

describe('idsConErrori', () => {
  it('conta solo l\'ultimo messaggio out di ogni chat nelle ultime 48h', async () => {
    const { idsConErrori } = await import('./viste-db');
    const s = fintoSupa({
      messages: async (calls) => {
        const range = calls.find(([m]) => m === 'range')?.[1] as [number, number] | undefined;
        if (range && range[0] > 0) return { data: [], error: null };
        return {
          data: [
            { conversation_id: 1, twilio_status: 'delivered' },
            { conversation_id: 1, twilio_status: 'failed' },
            { conversation_id: 2, twilio_status: 'undelivered' },
          ],
          error: null,
        };
      },
    });
    const ids = await idsConErrori(s, new Date('2026-10-05T19:00:00.000Z'));
    expect(ids).toEqual([2]);
  });
});

describe('codificaCursore / leggiCursore', () => {
  it('vanno e tornano', async () => {
    const { codificaCursore, leggiCursore } = await import('./viste-db');
    const c = codificaCursore('2026-10-05T19:00:00.000Z', 42);
    expect(leggiCursore(c)).toEqual({ at: '2026-10-05T19:00:00.000Z', id: 42 });
  });

  it('un cursore illeggibile torna null', async () => {
    const { leggiCursore } = await import('./viste-db');
    expect(leggiCursore('spazzatura')).toBeNull();
  });
});

describe('paginaChat', () => {
  it('vista "errori" senza errori: vuoto, senza toccare conversations', async () => {
    const { paginaChat } = await import('./viste-db');
    const s = fintoSupa({
      messages: async () => ({ data: [], error: null }),
      campagne: async () => ({ data: [], error: null }),
    });
    const now = new Date('2026-10-05T19:00:00.000Z');
    const res = await paginaChat(s, { vista: 'errori', now });
    expect(res).toEqual({ righe: [], prossimo: null });
    expect(s.fromCalls).not.toContain('conversations');
  });

  it('ricerca senza lead trovati: vuoto', async () => {
    const { paginaChat } = await import('./viste-db');
    const s = fintoSupa({
      leads: async () => ({ data: [], error: null }),
    });
    const now = new Date('2026-10-05T19:00:00.000Z');
    const res = await paginaChat(s, { vista: 'lancio', q: 'nessuno', now });
    expect(res).toEqual({ righe: [], prossimo: null });
    expect(s.fromCalls).not.toContain('conversations');
  });

  it('pagina piena: torna un cursore per la pagina successiva', async () => {
    const { paginaChat, codificaCursore } = await import('./viste-db');
    const PER_PAGINA = 50;
    const righeFinte = Array.from({ length: PER_PAGINA + 1 }, (_, i) => ({
      id: i + 1,
      ai_owner: 'mario', ai_status: 'active', ai_paused_at: null,
      bot_outcome: null, gdo_agenda_at: null, gdo_video_sent_at: null,
      campaign_id: null, lancio_slug: null, lancio_fase: null,
      last_inbound_at: null, unread_count: 0,
      last_message_at: `2026-10-0${(9 - i) % 9 || 1}T10:00:00.000Z`,
      last_message_preview: 'ciao',
      lead: { first_name: 'Mario', last_name: 'Rossi', phone_e164: '+391234' },
    }));
    const s = fintoSupa({
      messages: async () => ({ data: [], error: null }),
      campaigns: async () => ({ data: [], error: null }),
      conversations: async () => ({ data: righeFinte, error: null }),
    });
    const now = new Date('2026-10-05T19:00:00.000Z');
    const res = await paginaChat(s, { vista: 'mario', now });
    expect(res.righe).toHaveLength(PER_PAGINA);
    expect(res.righe[0].nome).toBe('Mario Rossi');
    expect(res.righe[0].telefono).toBe('+391234');
    expect(res.prossimo).toBe(
      codificaCursore(righeFinte[PER_PAGINA - 1].last_message_at, righeFinte[PER_PAGINA - 1].id),
    );
  });
});

describe('cercaChat', () => {
  it('q senza lead: [] senza toccare conversations', async () => {
    const { cercaChat } = await import('./viste-db');
    const s = fintoSupa({ leads: async () => ({ data: [], error: null }) });
    const res = await cercaChat(s, 'nessuno', new Date('2026-10-05T19:00:00.000Z'));
    expect(res).toEqual([]);
    expect(s.fromCalls).not.toContain('conversations');
  });

  it('q vuota: [] senza leggere nulla', async () => {
    const { cercaChat } = await import('./viste-db');
    const s = fintoSupa({});
    expect(await cercaChat(s, '   ', new Date('2026-10-05T19:00:00.000Z'))).toEqual([]);
    expect(s.fromCalls).toEqual([]);
  });

  it('con lead: al massimo 10 chat, piu recenti prima, filtrate sui lead trovati', async () => {
    const { cercaChat } = await import('./viste-db');
    let chiamateConv: Chiamata[] = [];
    const s = fintoSupa({
      leads: async () => ({ data: [{ id: 7 }], error: null }),
      messages: async () => ({ data: [], error: null }),
      campaigns: async () => ({ data: [], error: null }),
      conversations: async (calls) => {
        chiamateConv = calls;
        return {
          data: [{
            id: 3, ai_owner: 'mario', ai_status: 'active', ai_paused_at: null, bot_outcome: null,
            gdo_agenda_at: null, gdo_video_sent_at: null, campaign_id: null, lancio_slug: null, lancio_fase: null,
            last_inbound_at: null, unread_count: 0, last_message_at: '2026-10-05T18:00:00.000Z',
            last_message_preview: 'ciao', lead: { first_name: 'Anna', last_name: 'Bianchi', phone_e164: '+39333' },
          }],
          error: null,
        };
      },
    });
    const res = await cercaChat(s, 'anna', new Date('2026-10-05T19:00:00.000Z'));
    expect(res.map((r) => r.nome)).toEqual(['Anna Bianchi']);
    expect(chiamateConv).toContainEqual(['in', ['lead_id', [7]]]);
    expect(chiamateConv).toContainEqual(['order', ['last_message_at', { ascending: false }]]);
    expect(chiamateConv).toContainEqual(['limit', [10]]);
  });
});
