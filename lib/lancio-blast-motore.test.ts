import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';
import {
  leggiParametriCron, eRifiutoDiPolicy, eseguiLotti, nuovoStatoRun, timbroUpdate, timbroCampi, PASSO_FRENO,
  inviaTemplateTimbrato,
  type EsitoInvio,
} from './lancio-blast-motore';

// Twilio e la scrittura della fase hanno i loro test: qui interessa solo che il motore
// non perda il blocco di invii quando la costruzione del messaggio di UNO esplode.
const sendTemplate = vi.fn(async () => ({ sid: 'SMtest', status: 'queued' }));
vi.mock('./twilio', () => ({ sendTemplate: (...a: unknown[]) => sendTemplate(...(a as [])) }));
vi.mock('./lancio-db', () => ({ impostaFaseLancio: async () => {} }));

type Chiamata = { table: string; op: 'insert' | 'update' | 'select'; arg: unknown };
const chiamate: Chiamata[] = [];
/** Il claim (`update` su `conversations`) deve restituire una riga, o nessun invio parte. */
const risultato = (rec: Chiamata) =>
  rec.table === 'conversations' && rec.op === 'update' ? { data: [{ id: 1 }], error: null } : { data: [], error: null };

function builder(table: string, op: Chiamata['op'], arg: unknown) {
  const rec: Chiamata = { table, op, arg };
  chiamate.push(rec);
  const q: Record<string, unknown> = {};
  for (const m of ['eq', 'is', 'in', 'not', 'select', 'order', 'range']) q[m] = () => q;
  q.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) =>
    Promise.resolve().then(() => risultato(rec)).then(ok, ko);
  return q;
}
const supabase = {
  from: (table: string) => ({
    select: (r: unknown) => builder(table, 'select', r),
    insert: (r: unknown) => builder(table, 'insert', r),
    update: (r: unknown) => builder(table, 'update', r),
  }),
} as never;

const req = (qs: string) => ({ nextUrl: new URL(`https://x/api/cron/x?${qs}`), headers: new Headers() }) as unknown as NextRequest;

describe('leggiParametriCron', () => {
  it('forza=1 senza solo è un errore, con solo passa', () => {
    expect(leggiParametriCron(req('forza=1'), { nowRichiedeSolo: false })).toEqual({ ok: false, errore: 'forza=1 richiede solo=<conversationId>' });
    const r = leggiParametriCron(req('forza=1&solo=7'), { nowRichiedeSolo: false });
    expect(r).toMatchObject({ ok: true, forza: true, solo: 7, dry: false });
  });
  it('now= sposta l orologio; con nowRichiedeSolo vale solo insieme a solo=', () => {
    const libero = leggiParametriCron(req('now=2026-10-06T12:10:00%2B02:00'), { nowRichiedeSolo: false });
    expect(libero.ok && libero.now.toISOString()).toBe('2026-10-06T10:10:00.000Z');
    expect(leggiParametriCron(req('now=2026-10-06T12:10:00%2B02:00'), { nowRichiedeSolo: true })).toEqual({ ok: false, errore: 'now=<iso> richiede solo=<conversationId>' });
    const conSolo = leggiParametriCron(req('now=2026-10-06T12:10:00%2B02:00&solo=3'), { nowRichiedeSolo: true });
    expect(conSolo.ok && conSolo.now.toISOString()).toBe('2026-10-06T10:10:00.000Z');
  });
  it('now illeggibile = ora vera; dry=1 letto', () => {
    const r = leggiParametriCron(req('now=ieri&dry=1'), { nowRichiedeSolo: false });
    expect(r.ok && Math.abs(r.now.getTime() - Date.now()) < 5_000).toBe(true);
    expect(r.ok && r.dry).toBe(true);
  });
});

describe('eRifiutoDiPolicy', () => {
  it('riconosce il presidio UTILITY_ONLY, non un codice Twilio', () => {
    expect(eRifiutoDiPolicy(new Error('template HX1 bloccato: categoria MARKETING con UTILITY_ONLY attivo'))).toBe(true);
    expect(eRifiutoDiPolicy(new Error('categoria del template HX1 non verificabile (HTTP 500)'))).toBe(true);
    expect(eRifiutoDiPolicy(Object.assign(new Error('giu'), { code: 21211 }))).toBe(false);
    expect(eRifiutoDiPolicy(new Error('socket hang up'))).toBe(false);
  });
});

describe('timbroUpdate', () => {
  it('produce l oggetto con la sola colonna chiesta', () => {
    expect(timbroUpdate('lancio_link_inviato_at', 'T')).toEqual({ lancio_link_inviato_at: 'T' });
    expect(timbroUpdate('lancio_followup_inviato_at', null)).toEqual({ lancio_followup_inviato_at: null });
    expect(timbroCampi('lancio_followup_inviato_at', 'T')).toEqual({ lancio_followup_inviato_at: 'T' });
  });
});

describe('eseguiLotti', () => {
  afterEach(() => vi.useRealTimers());
  const lotto = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

  it('conta gli esiti e non chiama il freno se va tutto bene', async () => {
    const stato = nuovoStatoRun();
    const suFreno = vi.fn();
    const conti = await eseguiLotti(lotto(30), stato, {
      concorrenza: 5, t0: Date.now(), suFreno,
      inviaUno: async (id): Promise<EsitoInvio> => { stato.tentati++; return id % 10 === 0 ? 'capped' : 'sent'; },
    });
    expect(conti).toMatchObject({ inviati: 27, capped: 3, falliti: 0, incerti: 0, saltati: 0, errori: 0, riparati: 0 });
    expect(conti.report).toHaveLength(30);
    expect(suFreno).not.toHaveBeenCalled();
    expect(stato.fermo).toBeNull();
  });

  it('si ferma al primo blocco se non arriva niente: il denominatore sono i tentativi', async () => {
    const stato = nuovoStatoRun();
    const suFreno = vi.fn(async () => {});
    const conti = await eseguiLotti(lotto(60), stato, {
      concorrenza: 5, t0: Date.now(), suFreno,
      inviaUno: async (): Promise<EsitoInvio> => { stato.tentati++; stato.codici.push(21211); return 'failed'; },
    });
    expect(conti.falliti).toBe(PASSO_FRENO);
    expect(conti.report).toHaveLength(PASSO_FRENO);
    expect(stato.fermo).toBe('freno');
    expect(suFreno).toHaveBeenCalledTimes(1);
  });

  it('gli incerti pesano come falliti nel freno', async () => {
    const stato = nuovoStatoRun();
    const conti = await eseguiLotti(lotto(60), stato, {
      concorrenza: 5, t0: Date.now(), suFreno: async () => {},
      inviaUno: async (): Promise<EsitoInvio> => { stato.tentati++; return 'incerto'; },
    });
    expect(conti.incerti).toBe(PASSO_FRENO);
    expect(stato.fermo).toBe('freno');
  });

  it('un fermo messo dal worker (template bloccato) interrompe il ciclo senza freno', async () => {
    const stato = nuovoStatoRun();
    const suFreno = vi.fn();
    const conti = await eseguiLotti(lotto(60), stato, {
      concorrenza: 1, t0: Date.now(), suFreno,
      inviaUno: async (): Promise<EsitoInvio> => { if (stato.fermo) return 'skip'; stato.fermo = 'template_bloccato'; return 'bloccato'; },
    });
    expect(conti.report.length).toBe(PASSO_FRENO);
    // `bloccato` finisce fra i saltati come nel cron Zoom di oggi (e' il ramo `else` dei
    // conti): il blocco e' 1 bloccato + 24 skip, e i conti del riepilogo devono tornare
    // (candidati = inviati + riparati + falliti + cap + saltati + residui).
    expect(conti.report[0]).toBe('bloccato');
    expect(conti.saltati).toBe(PASSO_FRENO);
    expect(stato.fermo).toBe('template_bloccato');
    expect(suFreno).not.toHaveBeenCalled();
  });

  it('la sveglia dei 240s ferma il ciclo con fermo=tempo', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-06T10:00:00Z'));
    const stato = nuovoStatoRun();
    const t0 = Date.now();
    const conti = await eseguiLotti(lotto(60), stato, {
      concorrenza: 5, t0, suFreno: async () => {},
      inviaUno: async (): Promise<EsitoInvio> => { vi.setSystemTime(Date.now() + 20_000); stato.tentati++; return 'sent'; },
    });
    expect(stato.fermo).toBe('tempo');
    expect(conti.inviati).toBe(PASSO_FRENO);
  });
});

describe('inviaTemplateTimbrato: la costruzione del messaggio sta DENTRO il try/catch', () => {
  beforeEach(() => {
    chiamate.length = 0;
    sendTemplate.mockClear();
  });

  it('un costruisci che esplode e di un destinatario solo: gli altri 24 partono lo stesso', async () => {
    // Prima la `costruisci` la chiamava il cron, fuori dal motore: un'eccezione li'
    // rifiutava il `Promise.all` di `runPool` e portava via l'intero blocco di 25 —
    // compresi gli invii gia' partiti su WhatsApp, che nessuno avrebbe piu' registrato.
    const stato = nuovoStatoRun();
    const conti = await eseguiLotti(Array.from({ length: PASSO_FRENO }, (_, i) => i + 1), stato, {
      concorrenza: 5,
      t0: Date.now(),
      suFreno: async () => {},
      inviaUno: (n) =>
        inviaTemplateTimbrato(supabase, stato, {
          conv: { id: n, crm_lead_id: `crm-${n}`, phone: `+3933300000${n}`, nome: 'mario rossi' },
          colonna: 'lancio_link_inviato_at',
          faseDopo: 'link_inviato',
          sid: 'HX1',
          from: 'whatsapp:+390000000000',
          costruisci: () => {
            if (n === 7) throw new Error('nome illeggibile');
            return { vars: { '1': 'Mario', '2': 'https://zoom' }, body: 'Ciao Mario' };
          },
          giaSpedito: false,
          soloDaFasi: ['attesa', 'posto_bloccato'],
          prefisso: 'lancio_zoom',
          etichetta: 'link Zoom',
        }),
    });

    expect(conti.inviati).toBe(PASSO_FRENO - 1);
    expect(conti.saltati).toBe(1);
    expect(conti.report).toHaveLength(PASSO_FRENO);
    expect(stato.fermo).toBeNull();
    expect(sendTemplate).toHaveBeenCalledTimes(PASSO_FRENO - 1);
    // Il timbro non e' stato nemmeno preso per chi e' saltato: si riprova al run dopo.
    const claim = chiamate.filter(
      (c) => c.table === 'conversations' && c.op === 'update' && (c.arg as Record<string, unknown>).lancio_link_inviato_at !== undefined,
    );
    expect(claim).toHaveLength(PASSO_FRENO - 1);
    const eventi = chiamate.filter((c) => c.table === 'event_log').map((c) => (c.arg as { type: string }).type);
    expect(eventi).toContain('lancio_zoom_messaggio_non_costruito');
  });
});
