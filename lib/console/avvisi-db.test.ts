import { describe, it, expect, vi, beforeEach } from 'vitest';

type Riga = Record<string, unknown>;
const stato = { risolti: [] as Riga[], sistema: [] as Riga[], followups: null as string | null };

vi.mock('@/lib/lancio-monitor-db', () => ({
  fotografia: async () => ({
    settings: {}, chats: [], eventiAvviso: [], statiTwilio: [], ultimiRun: {}, colonnaInizio: true,
  }),
}));
vi.mock('@/lib/lancio-monitor', async (orig) => ({
  ...(await orig<typeof import('@/lib/lancio-monitor')>()),
  calcolaAvvisi: () => [],
}));

function client() {
  return {
    from: () => {
      const f: { tipo?: string; tipi?: string[] } = {};
      const q = {
        select: () => q,
        in: (_c: string, v: string[]) => { f.tipi = v; return q; },
        eq: (_c: string, v: string) => { f.tipo = v; return q; },
        gte: () => q,
        order: () => q,
        limit: () => Promise.resolve({ data: stato.followups ? [{ created_at: stato.followups }] : [], error: null }),
        range: () => Promise.resolve({ data: f.tipo === 'console_avviso_risolto' ? stato.risolti : stato.sistema, error: null }),
      };
      return q;
    },
  };
}

const { leggiAvvisi } = await import('./avvisi-db');
const now = new Date('2026-10-05T19:00:00Z');
const evento = (type: string, conv: number, at: string): Riga => ({ id: conv, type, created_at: at, level: 'error', message: '', payload: { conversationId: conv } });

beforeEach(() => {
  stato.risolti = [];
  stato.sistema = [evento('gdo_agenda_error', 1, '2026-10-05T18:40:00Z')];
  stato.followups = '2026-10-05T18:30:00Z';
});

describe('leggiAvvisi', () => {
  it('senza risolti mostra l\'avviso di sistema', async () => {
    const a = await leggiAvvisi(client() as never, now);
    expect(a.map((x) => x.id)).toEqual(['gdo_agenda_error']);
  });
  it('un risolto con la stessa firma lo nasconde', async () => {
    stato.risolti = [{ payload: { id: 'gdo_agenda_error', firma: 'gdo_agenda_error:2026-10-05T18:40:00Z' } }];
    expect(await leggiAvvisi(client() as never, now)).toEqual([]);
  });
  it('vince il risolto piu\' recente (righe dal piu\' recente)', async () => {
    stato.risolti = [
      { payload: { id: 'gdo_agenda_error', firma: 'vecchia-diversa' } },
      { payload: { id: 'gdo_agenda_error', firma: 'gdo_agenda_error:2026-10-05T18:40:00Z' } },
    ];
    expect((await leggiAvvisi(client() as never, now)).map((x) => x.id)).toEqual(['gdo_agenda_error']);
    stato.risolti = [
      { payload: { id: 'gdo_agenda_error', firma: 'gdo_agenda_error:2026-10-05T18:40:00Z' } },
      { payload: { id: 'gdo_agenda_error', firma: 'vecchia-diversa' } },
    ];
    expect(await leggiAvvisi(client() as never, now)).toEqual([]);
  });
  it('ignora payload malformati', async () => {
    stato.risolti = [{ payload: null }, { payload: { id: 5, firma: 'x' } }, { payload: { id: 'gdo_agenda_error' } }];
    expect((await leggiAvvisi(client() as never, now)).map((x) => x.id)).toEqual(['gdo_agenda_error']);
  });
  it('nessun bot_followups_run scritto = cron fermo', async () => {
    stato.followups = null;
    stato.sistema = [];
    expect((await leggiAvvisi(client() as never, now)).map((x) => x.id)).toEqual(['cron_bot-followups']);
  });
});
