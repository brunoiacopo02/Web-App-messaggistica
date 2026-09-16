import { describe, it, expect, vi, afterEach } from 'vitest';
import type { NextRequest } from 'next/server';
import {
  leggiParametriCron, eRifiutoDiPolicy, eseguiLotti, nuovoStatoRun, timbroUpdate, timbroCampi, PASSO_FRENO,
  type EsitoInvio,
} from './lancio-blast-motore';

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
