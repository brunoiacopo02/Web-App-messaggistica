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

type MsgFinto = { conversation_id: number; created_at: string; direction: 'in' | 'out'; twilio_status: string | null };

/**
 * Finta tabella `messages` che interpreta i filtri usati da `idsConErrori` (eq, in, gte, gt, or
 * sullo stato, order, range), così vecchio e nuovo algoritmo si confrontano sugli stessi dati.
 */
function supaMessaggi(righe: MsgFinto[]) {
  const letture: Chiamata[][] = [];
  const s = fintoSupa({
    messages: async (calls) => {
      letture.push(calls);
      let r = [...righe];
      for (const [m, a] of calls) {
        const [c, v] = a as [keyof MsgFinto, unknown];
        if (m === 'eq') r = r.filter((x) => x[c] === v);
        if (m === 'in') r = r.filter((x) => (v as unknown[]).includes(x[c]));
        if (m === 'gte') r = r.filter((x) => String(x[c]) >= String(v));
        if (m === 'gt') r = r.filter((x) => String(x[c]) > String(v));
        if (m === 'or') {
          expect(a[0]).toBe('twilio_status.is.null,twilio_status.not.in.(failed,undelivered)');
          r = r.filter((x) => x.twilio_status === null || !['failed', 'undelivered'].includes(x.twilio_status));
        }
        if (m === 'order') {
          const asc = (a[1] as { ascending: boolean }).ascending;
          r.sort((x, y) => (asc ? 1 : -1) * String(x[c]).localeCompare(String(y[c])));
        }
      }
      const range = calls.find(([m]) => m === 'range')?.[1] as [number, number] | undefined;
      if (range) r = r.slice(range[0], range[1] + 1);
      return { data: r, error: null };
    },
  });
  return { s, letture };
}

/** Il vecchio algoritmo, come riferimento: l'ultimo `out` di ogni chat nelle 48h, se fallito. */
function riferimento(righe: MsgFinto[], now: Date): number[] {
  const da = new Date(now.getTime() - 48 * 3600_000).toISOString();
  const out = righe.filter((m) => m.direction === 'out' && m.created_at >= da).sort((a, b) => b.created_at.localeCompare(a.created_at));
  const visti = new Set<number>();
  const ko: number[] = [];
  for (const m of out) {
    if (visti.has(m.conversation_id)) continue;
    visti.add(m.conversation_id);
    if (m.twilio_status === 'failed' || m.twilio_status === 'undelivered') ko.push(m.conversation_id);
  }
  return ko;
}

const NOW = new Date('2026-10-05T19:00:00.000Z');
const ore = (h: number) => new Date(NOW.getTime() - h * 3600_000).toISOString();
const out = (conversation_id: number, h: number, twilio_status: string | null): MsgFinto => ({ conversation_id, created_at: ore(h), direction: 'out', twilio_status });
const inb = (conversation_id: number, h: number): MsgFinto => ({ conversation_id, created_at: ore(h), direction: 'in', twilio_status: null });

async function confronta(righe: MsgFinto[]) {
  const { idsConErrori } = await import('./viste-db');
  const { s, letture } = supaMessaggi(righe);
  const nuovi = await idsConErrori(s, NOW);
  expect([...nuovi].sort((a, b) => a - b)).toEqual(riferimento(righe, NOW).sort((a, b) => a - b));
  return { nuovi, letture };
}

describe('idsConErrori', () => {
  it("conta solo l'ultimo messaggio out di ogni chat nelle ultime 48h", async () => {
    const { nuovi } = await confronta([out(1, 5, 'failed'), out(1, 2, 'delivered'), out(2, 3, 'undelivered')]);
    expect(nuovi).toEqual([2]);
  });

  it('solo fallito: errore', async () => {
    const { nuovi } = await confronta([out(1, 3, 'failed'), inb(1, 1)]);
    expect(nuovi).toEqual([1]);
  });

  it('fallito e poi consegnato (anche sent, read, queued o senza stato): non è errore', async () => {
    for (const stato of ['delivered', 'read', 'sent', 'queued', 'accepted', null]) {
      vi.resetModules();
      const { nuovi } = await confronta([out(1, 3, 'failed'), out(1, 2, stato)]);
      expect(nuovi).toEqual([]);
    }
  });

  it('consegnato e poi fallito: errore', async () => {
    const { nuovi } = await confronta([out(1, 3, 'delivered'), out(1, 2, 'undelivered')]);
    expect(nuovi).toEqual([1]);
  });

  it('più chat, fallimenti ripetuti e messaggi fuori finestra', async () => {
    await confronta([
      out(1, 10, 'failed'), out(1, 8, 'failed'), out(1, 6, 'read'),
      out(2, 9, 'read'), out(2, 7, 'failed'), out(2, 4, 'undelivered'),
      out(3, 60, 'failed'), out(3, 50, 'read'),
      out(4, 60, 'read'), out(4, 20, 'failed'), inb(4, 1),
      out(5, 30, 'sent'),
      out(6, 47, 'failed'), out(6, 2, 'sent'),
    ]);
  });

  it('dati casuali: stesso risultato del vecchio algoritmo', async () => {
    let seme = 7;
    const caso = () => (seme = (seme * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const stati = ['failed', 'undelivered', 'delivered', 'read', 'sent', 'queued', null];
    for (let giro = 0; giro < 20; giro++) {
      vi.resetModules();
      const righe: MsgFinto[] = [];
      for (let i = 0; i < 300; i++) {
        const conv = 1 + Math.floor(caso() * 40);
        // Istanti tutti distinti: a parità di created_at il vecchio ordine non era definito.
        const h = Math.floor(caso() * 60 * 60) / 60 + i / 1e5;
        righe.push(caso() < 0.2 ? inb(conv, h) : out(conv, h, stati[Math.floor(caso() * stati.length)]));
      }
      await confronta(righe);
    }
  });

  it('prima lettura: solo i falliti in uscita delle 48h; poi i non falliti delle candidate', async () => {
    const { letture } = await confronta([out(1, 3, 'failed'), out(1, 2, 'read')]);
    const prima = letture[0];
    expect(prima).toContainEqual(['eq', ['direction', 'out']]);
    expect(prima).toContainEqual(['in', ['twilio_status', ['failed', 'undelivered']]]);
    expect(prima).toContainEqual(['select', ['conversation_id, created_at']]);
    const seconda = letture[1];
    expect(seconda).toContainEqual(['in', ['conversation_id', [1]]]);
    expect(seconda).toContainEqual(['gt', ['created_at', ore(3)]]);
  });

  it('ordine: prima le chat con il fallimento più recente', async () => {
    const { nuovi } = await confronta([out(1, 30, 'failed'), out(2, 2, 'failed'), out(3, 10, 'undelivered'), out(1, 40, 'read')]);
    expect(nuovi).toEqual([2, 3, 1]);
  });

  it('senza falliti non fa la seconda lettura (mai in.() vuoto)', async () => {
    const { letture } = await confronta([out(1, 3, 'read')]);
    expect(letture).toHaveLength(1);
  });

  it('candidate a blocchi da 200', async () => {
    const righe = Array.from({ length: 450 }, (_, i) => out(i + 1, 5, 'failed'));
    righe.push(out(7, 1, 'read'), out(420, 1, 'delivered'));
    const { nuovi, letture } = await confronta(righe);
    expect(nuovi).toHaveLength(448);
    const blocchi = letture.slice(1).map((c) => ((c.find(([m, a]) => m === 'in' && a[0] === 'conversation_id')![1] as [string, number[]])[1]).length);
    expect(blocchi).toEqual([200, 200, 50]);
  });

  it('cache di 15 s: la seconda chiamata non rilegge', async () => {
    const { idsConErrori } = await import('./viste-db');
    const { s, letture } = supaMessaggi([out(1, 3, 'failed')]);
    await idsConErrori(s, NOW);
    const n = letture.length;
    await idsConErrori(s, new Date(NOW.getTime() + 10_000));
    expect(letture.length).toBe(n);
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
