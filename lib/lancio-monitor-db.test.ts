import { describe, it, expect, beforeEach } from 'vitest';
import { _svuotaCacheMonitor, colonnaAssente, consegne, fotografia, leggiDettaglio, sidDalleEnv, nomeTemplateDaEnv } from './lancio-monitor-db';

/**
 * Finto PostgREST: ogni `from(tabella)` registra la catena di chiamate e, quando la si
 * attende, chiede la risposta a `rispondi`. Nessuna scrittura e' prevista: se il codice
 * chiamasse insert/update/upsert/delete il builder non li avrebbe e il test esploderebbe.
 */
type Chiamata = { tabella: string; passi: [string, unknown[]][] };
let chiamate: Chiamata[] = [];
let rispondi: (c: Chiamata) => { data: unknown; error: { message: string; code?: string } | null } = () => ({ data: [], error: null });

function builder(tabella: string) {
  const c: Chiamata = { tabella, passi: [] };
  chiamate.push(c);
  const b: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'in', 'gte', 'not', 'is', 'or', 'order', 'range', 'limit', 'maybeSingle']) {
    b[m] = (...args: unknown[]) => { c.passi.push([m, args]); return b; };
  }
  b.then = (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) => Promise.resolve(rispondi(c)).then(ok, ko);
  return b;
}
const supa = { from: (t: string) => builder(t) } as never;

const passo = (c: Chiamata, m: string) => c.passi.find(([n]) => n === m)?.[1];
const selectDi = (c: Chiamata) => String(passo(c, 'select')?.[0] ?? '');

const rigaChat = (id: number, extra: Record<string, unknown> = {}) => ({
  id, lancio_slug: 'webdev-2026-10', lancio_fase: 'attesa', lancio_ingresso: 'lista',
  lancio_benvenuto_at: '2026-10-01T10:00:00Z', lancio_link_inviato_at: null, lancio_followup_inviato_at: null,
  last_inbound_at: null, last_message_at: '2026-10-01T10:00:00Z', ai_status: 'active', congedo_at: null,
  leads: { first_name: 'Mario', last_name: 'Rossi', phone_e164: '+393331112233' }, ...extra,
});

beforeEach(() => {
  chiamate = [];
  _svuotaCacheMonitor();
});

describe('fotografia', () => {
  it('senza la colonna del messaggio delle 21 degrada: niente errore, colonnaInizio=false', async () => {
    rispondi = (c) => {
      if (c.tabella === 'conversations' && selectDi(c).includes('lancio_inizio_inviato_at')) {
        return { data: null, error: { message: 'column conversations.lancio_inizio_inviato_at does not exist', code: '42703' } };
      }
      if (c.tabella === 'conversations') return { data: [rigaChat(1)], error: null };
      return { data: [], error: null };
    };
    const f = await fotografia(supa, new Date('2026-10-05T19:00:00Z'));
    expect(f.colonnaInizio).toBe(false);
    expect(f.chats).toHaveLength(1);
    expect(f.chats[0].inizioAt).toBeUndefined();
    expect(f.chats[0].nome).toBe('Mario Rossi');
  });

  it('con la colonna la legge', async () => {
    rispondi = (c) => (c.tabella === 'conversations'
      ? { data: [rigaChat(1, { lancio_inizio_inviato_at: '2026-10-05T18:40:00Z' })], error: null }
      : { data: [], error: null });
    const f = await fotografia(supa, new Date('2026-10-05T19:00:00Z'));
    expect(f.colonnaInizio).toBe(true);
    expect(f.chats[0].inizioAt).toBe('2026-10-05T18:40:00Z');
  });

  it('un altro errore del DB non viene scambiato per la colonna mancante', async () => {
    rispondi = (c) => (c.tabella === 'conversations' ? { data: null, error: { message: 'timeout' } } : { data: [], error: null });
    await expect(fotografia(supa, new Date())).rejects.toThrow('timeout');
  });

  it('aggiunge le chat orfane del pulsante (fuori dal lancio) e resta in cache 20 secondi', async () => {
    rispondi = (c) => {
      if (c.tabella === 'event_log' && JSON.stringify(passo(c, 'in') ?? null).includes('lancio_pulsante')
        && JSON.stringify(passo(c, 'in') ?? null).includes('lancio_posto_bloccato')) {
        return { data: [{ id: 1, type: 'lancio_pulsante', created_at: '2026-10-05T19:10:00Z', level: 'warn', message: null, payload: { conversationId: 77, orfano: true } }], error: null };
      }
      if (c.tabella === 'conversations' && passo(c, 'in')) return { data: [rigaChat(77, { lancio_slug: null, lancio_fase: null })], error: null };
      if (c.tabella === 'conversations') return { data: [rigaChat(1)], error: null };
      return { data: [], error: null };
    };
    const t = new Date('2026-10-05T19:15:00Z');
    const f = await fotografia(supa, t);
    expect(f.chats.map((c) => c.id)).toEqual([1, 77]);
    expect(f.pulsante.has(77)).toBe(true);
    const n = chiamate.length;
    await fotografia(supa, new Date(t.getTime() + 10_000));
    expect(chiamate.length).toBe(n);
  });

  it('legge gli stati Twilio solo a livello warn e dell\'ultima ora', async () => {
    rispondi = () => ({ data: [], error: null });
    const now = new Date('2026-10-05T19:00:00Z');
    await fotografia(supa, now);
    const tw = chiamate.find((c) => c.tabella === 'event_log' && JSON.stringify(passo(c, 'in') ?? null) === JSON.stringify(['type', ['twilio_status']]))!;
    expect(passo(tw, 'eq')).toEqual(['level', 'warn']);
    expect(passo(tw, 'gte')).toEqual(['created_at', '2026-10-05T18:00:00.000Z']);
  });
});

describe('consegne', () => {
  it('spezza gli id a blocchi da 200 e conta le consegne', async () => {
    const righe = Array.from({ length: 450 }, (_, i) => rigaChat(i + 1));
    rispondi = (c) => {
      if (c.tabella === 'conversations') return { data: righe, error: null };
      if (c.tabella === 'messages') {
        const ids = (passo(c, 'in')?.[1] ?? []) as number[];
        return { data: ids.slice(0, 1).map((id) => ({ conversation_id: id, created_at: '2026-10-01T10:00:02Z', template_sid: 'HX?', is_template: true, twilio_status: 'delivered', twilio_error_code: null })), error: null };
      }
      return { data: [], error: null };
    };
    const now = new Date('2026-10-05T19:00:00Z');
    const f = await fotografia(supa, now);
    const r = await consegne(supa, f, now);
    const blocchi = chiamate.filter((c) => c.tabella === 'messages');
    expect(blocchi).toHaveLength(3);
    expect(blocchi.every((c) => ((passo(c, 'in')?.[1] ?? []) as number[]).length <= 200)).toBe(true);
    expect(r.consegne.perTipo.benvenuto.consegnati).toBe(3);
  });
});

describe('leggiDettaglio', () => {
  it('cerca gli eventi per conversationId come testo, dentro un elenco chiuso di tipi', async () => {
    rispondi = (c) => (c.tabella === 'conversations' ? { data: [rigaChat(5)], error: null } : { data: [], error: null });
    const d = await leggiDettaglio(supa, 5);
    expect(d.chat?.id).toBe(5);
    const ev = chiamate.find((c) => c.tabella === 'event_log')!;
    expect(passo(ev, 'eq')).toEqual(['payload->>conversationId', '5']);
    expect(((passo(ev, 'in')?.[1] ?? []) as string[])).toContain('lancio_scelta_pulsante_tap');
  });

  it('chat inesistente: null, senza leggere messaggi', async () => {
    rispondi = () => ({ data: [], error: null });
    const d = await leggiDettaglio(supa, 9);
    expect(d.chat).toBeNull();
    expect(chiamate.some((c) => c.tabella === 'messages')).toBe(false);
  });
});

describe('utilita\'', () => {
  it('colonnaAssente', () => {
    expect(colonnaAssente({ code: '42703' }, 'x')).toBe(true);
    expect(colonnaAssente({ message: 'column conversations.x does not exist' }, 'x')).toBe(true);
    expect(colonnaAssente({ message: 'timeout' }, 'x')).toBe(false);
    expect(colonnaAssente(null, 'x')).toBe(false);
  });
  it('SID e nomi dalle env', () => {
    const env = { LANCIO_WELCOME_TEMPLATE_SID: 'HXw', LANCIO_SCELTA_NOTTE_TEMPLATE_SID: 'HXn' };
    expect(sidDalleEnv(env)).toMatchObject({ benvenuto: ['HXw'], scelta: ['HXn'], zoom: [] });
    expect(nomeTemplateDaEnv('HXn', env)).toBe('scelta con pulsanti (notte)');
    expect(nomeTemplateDaEnv('HXboh', env)).toBeNull();
  });
});
