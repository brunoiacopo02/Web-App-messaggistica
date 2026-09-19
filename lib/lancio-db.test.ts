import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { impostaFaseLancio, marcaCongedo, marcaNotaRestituzione, contaBenvenutiUltimaOra, leggiIngressiLancioAt } from './lancio-db';

/**
 * Finto Supabase: registra gli update su `conversations`, gli insert su `event_log` e la
 * forma della query di conteggio (colonne filtrate e opzioni della select). Le asserzioni
 * interessanti qui sono su quello che NON viene scritto.
 */
type Filtro = [string, string, unknown];

function makeSupabase(opts: {
  lancioInfo?: unknown;
  erroreLettura?: { message: string } | null;
  erroreScrittura?: { message: string } | null;
  count?: number | null;
  erroreConteggio?: { message: string } | null;
  /** La fase a DB adesso: decide se un update con `in('lancio_fase', ...)` trova la riga. */
  faseCorrente?: string;
} = {}) {
  const calls = {
    updates: [] as any[],
    updateFiltri: [] as Filtro[][],
    events: [] as any[],
    conteggi: [] as { colonne: string; opzioni: unknown; filtri: Filtro[] }[],
  };
  const supabase: any = {
    from(table: string) {
      if (table === 'conversations') {
        return {
          update(p: any) {
            calls.updates.push(p);
            const filtri: Filtro[] = [];
            calls.updateFiltri.push(filtri);
            const c: any = {
              eq: (col: string, v: unknown) => { filtri.push(['eq', col, v]); return c; },
              in: (col: string, v: unknown) => { filtri.push(['in', col, v]); return c; },
              select: () => c,
              then: (r: any) => {
                // Compare-and-set finto: con `in('lancio_fase', [...])` la riga torna solo
                // se la fase a DB e' fra quelle ammesse, come farebbe Postgres.
                const fasi = filtri.find((f) => f[0] === 'in' && f[1] === 'lancio_fase')?.[2] as string[] | undefined;
                const trovata = !fasi || (opts.faseCorrente !== undefined && fasi.includes(opts.faseCorrente));
                return r({ data: trovata ? [{ id: 1 }] : [], error: opts.erroreScrittura ?? null });
              },
            };
            return c;
          },
          select() {
            const c: any = {
              eq: () => c,
              maybeSingle: async () => ({
                data: opts.erroreLettura ? null : { lancio_info: opts.lancioInfo ?? null },
                error: opts.erroreLettura ?? null,
              }),
            };
            return c;
          },
        };
      }
      if (table === 'messages') {
        return {
          select(colonne: string, opzioni: unknown) {
            const rec = { colonne, opzioni, filtri: [] as Filtro[] };
            calls.conteggi.push(rec);
            const c: any = {
              eq: (col: string, v: unknown) => { rec.filtri.push(['eq', col, v]); return c; },
              gte: (col: string, v: unknown) => { rec.filtri.push(['gte', col, v]); return c; },
              not: (col: string, op: string, v: unknown) => { rec.filtri.push([`not.${op}`, col, v]); return c; },
              then: (r: any) => r({ count: opts.count ?? null, error: opts.erroreConteggio ?? null }),
            };
            return c;
          },
        };
      }
      return { insert(p: any) { calls.events.push(p); return Promise.resolve({}); } };
    },
  };
  return { supabase, calls };
}

const eventiDiTipo = (calls: { events: any[] }, type: string) =>
  calls.events.filter((e) => e.type === type);

describe('impostaFaseLancio — la guardia sulla fase di partenza', () => {
  // Il blast del link (B4) e il turno dell'attesa (B1) possono girare insieme sulla
  // stessa chat: senza guardia il blast riportava a `link_inviato` una chat gia'
  // avanzata, col link ormai partito.
  it('con soloDaFasi la fase gia avanzata NON si riscrive, e resta la traccia', async () => {
    const { supabase, calls } = makeSupabase({ faseCorrente: 'post_pitch' });
    const esito = await impostaFaseLancio(supabase, 42, 'link_inviato', { lancio_link_inviato_at: 'T1' }, { soloDaFasi: ['attesa', 'posto_bloccato'] });
    // Il risultato torna a chi chiama: il cron delle restituzioni deve poter dire
    // "la chat era gia' oltre" invece di proseguire come se avesse scritto.
    expect(esito).toBe('non_cambiata');
    expect(calls.updateFiltri[0]).toContainEqual(['in', 'lancio_fase', ['attesa', 'posto_bloccato']]);
    const traccia = eventiDiTipo(calls, 'lancio_fase_non_cambiata');
    expect(traccia).toHaveLength(1);
    expect(traccia[0].payload).toMatchObject({ conversationId: 42, fase: 'link_inviato', soloDaFasi: ['attesa', 'posto_bloccato'] });
    expect(eventiDiTipo(calls, 'lancio_fase_cambiata')).toHaveLength(0);
  });

  it('con soloDaFasi e la fase ancora in attesa: si scrive come sempre', async () => {
    const { supabase, calls } = makeSupabase({ faseCorrente: 'attesa' });
    expect(await impostaFaseLancio(supabase, 42, 'link_inviato', { lancio_link_inviato_at: 'T1' }, { soloDaFasi: ['attesa', 'posto_bloccato'] })).toBe('cambiata');
    expect(eventiDiTipo(calls, 'lancio_fase_cambiata')).toHaveLength(1);
  });

  it('senza soloDaFasi niente guardia: update secco, come prima', async () => {
    const { supabase, calls } = makeSupabase();
    expect(await impostaFaseLancio(supabase, 42, 'chiuso')).toBe('cambiata');
    expect(calls.updates[0]).toEqual({ lancio_fase: 'chiuso' });
    expect(calls.updateFiltri[0].some((f) => f[0] === 'in')).toBe(false);
    expect(eventiDiTipo(calls, 'lancio_fase_cambiata')).toHaveLength(1);
  });

  it('errore del DB: resta lancio_fase_non_scritta, a livello error', async () => {
    const { supabase, calls } = makeSupabase({ faseCorrente: 'attesa', erroreScrittura: { message: 'connessione persa' } });
    expect(await impostaFaseLancio(supabase, 42, 'link_inviato', {}, { soloDaFasi: ['attesa'] })).toBe('errore');
    const traccia = eventiDiTipo(calls, 'lancio_fase_non_scritta');
    expect(traccia).toHaveLength(1);
    expect(traccia[0]).toMatchObject({ level: 'error' });
  });
});

describe('marcaCongedo', () => {
  it('merge sulle chiavi gia’ presenti: il congedo si aggiunge, non sostituisce', async () => {
    const { supabase, calls } = makeSupabase({ lancioInfo: { risposta_riscaldamento: 'si' } });
    await marcaCongedo(supabase, 42, '2026-10-01T10:00:00.000Z');
    expect(calls.updates[0].lancio_info).toEqual({
      risposta_riscaldamento: 'si',
      congedo_at: '2026-10-01T10:00:00.000Z',
    });
  });

  // Il bug: con `data` a null per un ERRORE di lettura, il vecchio fallback a `{}`
  // scriveva un `lancio_info` fatto del solo `congedo_at` e buttava via le chiavi di B4.
  // Un marcatore in piu' non vale quello che c'era.
  it('lettura fallita: non scrive NIENTE e lascia la traccia', async () => {
    const { supabase, calls } = makeSupabase({
      lancioInfo: { risposta_riscaldamento: 'si' },
      erroreLettura: { message: 'connessione persa' },
    });
    await marcaCongedo(supabase, 42, '2026-10-01T10:00:00.000Z');

    expect(calls.updates).toHaveLength(0);
    const traccia = eventiDiTipo(calls, 'lancio_congedo_non_marcato');
    expect(traccia).toHaveLength(1);
    expect(traccia[0]).toMatchObject({ level: 'warn' });
    expect(traccia[0].payload).toMatchObject({ conversationId: 42, fase: 'lettura', errore: 'connessione persa' });
  });

  it('riga senza lancio_info (lettura riuscita): si scrive il solo congedo', async () => {
    const { supabase, calls } = makeSupabase({ lancioInfo: null });
    await marcaCongedo(supabase, 42, '2026-10-01T10:00:00.000Z');
    expect(calls.updates[0].lancio_info).toEqual({ congedo_at: '2026-10-01T10:00:00.000Z' });
    expect(eventiDiTipo(calls, 'lancio_congedo_non_marcato')).toHaveLength(0);
  });

  it('scrittura fallita: traccia distinta, e non lancia (il turno non muore qui)', async () => {
    const { supabase, calls } = makeSupabase({ erroreScrittura: { message: 'update ko' } });
    await expect(marcaCongedo(supabase, 42)).resolves.toBeUndefined();
    expect(eventiDiTipo(calls, 'lancio_congedo_non_marcato')[0].payload).toMatchObject({ fase: 'scrittura' });
  });
});

describe('marcaNotaRestituzione', () => {
  it('merge come il congedo: il marcatore si aggiunge, le altre chiavi restano', async () => {
    const { supabase, calls } = makeSupabase({ lancioInfo: { congedo_at: '2026-10-08T09:00:00.000Z' } });
    await marcaNotaRestituzione(supabase, 42, '2026-10-09T10:00:00.000Z');
    expect(calls.updates[0].lancio_info).toEqual({
      congedo_at: '2026-10-08T09:00:00.000Z',
      restituito_nota_at: '2026-10-09T10:00:00.000Z',
    });
  });

  it('lettura fallita: non scrive NIENTE e lascia la traccia', async () => {
    const { supabase, calls } = makeSupabase({
      lancioInfo: { congedo_at: '2026-10-08T09:00:00.000Z' },
      erroreLettura: { message: 'connessione persa' },
    });
    await marcaNotaRestituzione(supabase, 42, '2026-10-09T10:00:00.000Z');
    expect(calls.updates).toHaveLength(0);
    const traccia = eventiDiTipo(calls, 'lancio_nota_restituzione_non_marcata');
    expect(traccia).toHaveLength(1);
    expect(traccia[0]).toMatchObject({ level: 'warn' });
    expect(traccia[0].payload).toMatchObject({ conversationId: 42, fase: 'lettura', errore: 'connessione persa' });
  });

  it('scrittura fallita: traccia distinta, e non lancia', async () => {
    const { supabase, calls } = makeSupabase({ erroreScrittura: { message: 'update ko' } });
    await expect(marcaNotaRestituzione(supabase, 42)).resolves.toBeUndefined();
    expect(eventiDiTipo(calls, 'lancio_nota_restituzione_non_marcata')[0].payload).toMatchObject({ fase: 'scrittura' });
  });
});

describe('contaBenvenutiUltimaOra', () => {
  const ADESSO = Date.parse('2026-10-01T12:00:00.000Z');

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(ADESSO);
  });
  afterEach(() => vi.useRealTimers());

  it('una sola query di conteggio, senza righe, sull’ultima ora e sul SID del benvenuto', async () => {
    const { supabase, calls } = makeSupabase({ count: 137 });
    const n = await contaBenvenutiUltimaOra(supabase, 'HX_W');
    expect(n).toBe(137);
    expect(calls.conteggi).toHaveLength(1);
    expect(calls.conteggi[0].opzioni).toEqual({ head: true, count: 'exact' });
    expect(calls.conteggi[0].filtri).toEqual([
      ['eq', 'direction', 'out'],
      ['eq', 'template_sid', 'HX_W'],
      ['gte', 'created_at', '2026-10-01T11:00:00.000Z'],
      ['not.in', 'twilio_status', '(failed,undelivered)'],
    ]);
  });

  it('conta su tutte le conversazioni: nessun filtro per chat (il numero WhatsApp e’ uno)', async () => {
    const { supabase, calls } = makeSupabase({ count: 3 });
    await contaBenvenutiUltimaOra(supabase, 'HX_W');
    expect(calls.conteggi[0].filtri.some(([, col]) => col === 'conversation_id')).toBe(false);
  });

  it('query riuscita senza count → 0: l’ora è vuota, non illeggibile', async () => {
    const { supabase } = makeSupabase({ count: null });
    expect(await contaBenvenutiUltimaOra(supabase, 'HX_W')).toBe(0);
  });

  // Fail CLOSED: `null` non è `0`. Chi chiama lo tratta come tetto raggiunto e differisce,
  // perché il cron ripassa ogni 15 minuti (il prezzo è un ritardo) mentre lasciar passare
  // alla cieca mentre il DB è in affanno è il modo di ripetere il 15/09.
  it('query fallita → null (non 0) con la traccia a voce alta', async () => {
    const { supabase, calls } = makeSupabase({ erroreConteggio: { message: 'timeout' } });
    expect(await contaBenvenutiUltimaOra(supabase, 'HX_W')).toBeNull();
    expect(eventiDiTipo(calls, 'lancio_tetto_non_letto')[0]).toMatchObject({ level: 'warn' });
  });

  it('l’istante si puo’ passare da fuori (il cron usa il suo `now`)', async () => {
    const { supabase, calls } = makeSupabase({ count: 1 });
    await contaBenvenutiUltimaOra(supabase, 'HX_W', Date.parse('2026-10-05T20:30:00.000Z'));
    expect(calls.conteggi[0].filtri).toContainEqual(['gte', 'created_at', '2026-10-05T19:30:00.000Z']);
  });
});

describe("leggiIngressiLancioAt — da quando la chat e' nel giro corrente del lancio", () => {
  /** Finto `event_log` che registra i filtri: qui la forma della query e' meta' del test. */
  function makeEventLog(righe: { created_at: string; payload: unknown }[]) {
    const filtri: Filtro[] = [];
    let colonne = '';
    const supabase: any = {
      from: () => ({
        select: (c: string) => {
          colonne = c;
          const q: any = {
            eq: (col: string, v: unknown) => { filtri.push(['eq', col, v]); return q; },
            in: (col: string, v: unknown) => { filtri.push(['in', col, v]); return q; },
            order: () => Promise.resolve({ data: righe, error: null }),
          };
          return q;
        },
      }),
    };
    return { supabase, filtri, colonne: () => colonne };
  }

  const riga = (id: number, at: string) => ({ created_at: at, payload: { conversationId: id } });

  it("tiene l'ingresso piu' recente: e' quello del giro corrente", async () => {
    // Ordine discendente come lo chiede la query: la ripartenza di oggi viene prima
    // dell'ingresso di settembre, ed e' quella che deve vincere.
    const { supabase } = makeEventLog([
      riga(3292, '2026-09-19T12:49:53Z'),
      riga(3292, '2026-09-14T09:00:00Z'),
    ]);
    const m = await leggiIngressiLancioAt(supabase, [3292]);
    expect(m.get(3292)).toBe('2026-09-19T12:49:53Z');
  });

  it('una conversazione senza evento non compare: chi legge conta su tutta la cronologia', async () => {
    const { supabase } = makeEventLog([riga(3292, '2026-09-19T12:49:53Z')]);
    const m = await leggiIngressiLancioAt(supabase, [3292, 4000]);
    expect(m.has(4000)).toBe(false);
    expect(m.size).toBe(1);
  });

  it('lotto vuoto: nessuna query', async () => {
    const { supabase, filtri } = makeEventLog([]);
    expect((await leggiIngressiLancioAt(supabase, [])).size).toBe(0);
    expect(filtri).toHaveLength(0);
  });

  it('payload senza conversationId leggibile: riga ignorata, non una chiave NaN', async () => {
    const { supabase } = makeEventLog([
      { created_at: '2026-09-19T12:00:00Z', payload: { phone: '+39333' } },
      { created_at: '2026-09-19T12:49:53Z', payload: null },
      riga(3292, '2026-09-19T12:49:53Z'),
    ]);
    const m = await leggiIngressiLancioAt(supabase, [3292]);
    expect([...m.keys()]).toEqual([3292]);
  });

  it("chiede solo gli intake del lancio e solo le conversazioni del lotto", async () => {
    const { supabase, filtri } = makeEventLog([]);
    await leggiIngressiLancioAt(supabase, [1, 2]);
    expect(filtri).toContainEqual(['eq', 'type', 'lancio_intake']);
    expect(filtri).toContainEqual(['in', 'payload->>conversationId', ['1', '2']]);
  });
});
