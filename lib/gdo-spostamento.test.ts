import { describe, expect, it, vi } from 'vitest';
import {
  elencoGiorni, giorniSpostamento, motivoDataNonValida, motivoNonSpostabile, notaSpostamentoPrompt,
  spostamentoAbilitato, testoSpostamentoFatto,
} from './gdo-spostamento';
import { inviaSpostamentoAlCrm } from './gdo-spostamento-send';
import { parseMarioReply } from './mario';

// mercoledì 28/10/2026 15:00 Roma (CET, +01:00)
const MER_15 = new Date('2026-10-28T15:00:00+01:00');
const CALL = '2026-10-29T17:00:00.000Z'; // giovedì 29 alle 18
const NESSUNA_CHIUSURA: { from: string; to: string }[] = [];

describe('interruttore', () => {
  it('acceso di default, spento solo con 0', () => {
    expect(spostamentoAbilitato(undefined)).toBe(true);
    expect(spostamentoAbilitato('1')).toBe(true);
    expect(spostamentoAbilitato('0')).toBe(false);
  });
});

describe('giorni dello spostamento', () => {
  it('i prossimi 3 lavorativi, oggi escluso', () =>
    expect(giorniSpostamento(MER_15, NESSUNA_CHIUSURA)).toEqual(['2026-10-29', '2026-10-30', '2026-10-31']));
  it('la domenica salta', () =>
    expect(giorniSpostamento(new Date('2026-10-30T10:00:00+01:00'), NESSUNA_CHIUSURA)).toEqual(['2026-10-31', '2026-11-02', '2026-11-03']));
  it('un giorno di chiusura si toglie, non si sostituisce', () =>
    expect(giorniSpostamento(MER_15, [{ from: '2026-10-30', to: '2026-10-30' }])).toEqual(['2026-10-29', '2026-10-31']));
  it('elenco leggibile', () =>
    expect(elencoGiorni(['2026-10-29', '2026-10-30', '2026-10-31'])).toBe('giovedì 29, venerdì 30 e sabato 31'));
});

describe('quando la chat può offrire lo spostamento', () => {
  const base = {
    enabled: true, postino: true, botOutcome: null, appuntamentoAt: CALL, giaSpostato: false, nowMs: MER_15.getTime(),
  };
  it('lead GDO con call futura: sì', () => expect(motivoNonSpostabile(base)).toBeNull());
  it('i no', () => {
    expect(motivoNonSpostabile({ ...base, enabled: false })).toBe('spento');
    expect(motivoNonSpostabile({ ...base, postino: false })).toBe('non_postino');
    expect(motivoNonSpostabile({ ...base, botOutcome: 'APPUNTAMENTO' })).toBe('call_del_bot');
    expect(motivoNonSpostabile({ ...base, appuntamentoAt: null })).toBe('senza_data');
    expect(motivoNonSpostabile({ ...base, appuntamentoAt: '2026-10-28T14:20:00Z' })).toBe('call_vicina_o_passata');
    expect(motivoNonSpostabile({ ...base, giaSpostato: true })).toBe('gia_spostato');
    expect(motivoNonSpostabile({ ...base, presented: true })).toBe('gia_presentato');
    expect(motivoNonSpostabile({ ...base, confermeOutcome: 'confermato' })).toBe('esito_conferme');
    expect(motivoNonSpostabile({ ...base, confermeOutcome: 'da_rifissare' })).toBe('esito_conferme');
  });
});

describe('la data del tag [SPOSTA]', () => {
  const now = MER_15.getTime();
  it('buona: dentro i 3 giorni, 9-21', () => {
    expect(motivoDataNonValida('2026-10-30T18:00:00+01:00', CALL, now, NESSUNA_CHIUSURA)).toBeNull();
    expect(motivoDataNonValida('2026-10-31T09:00:00+01:00', CALL, now, NESSUNA_CHIUSURA)).toBeNull();
    expect(motivoDataNonValida('2026-10-31T21:00:00+01:00', CALL, now, NESSUNA_CHIUSURA)).toBeNull();
  });
  it('i no', () => {
    expect(motivoDataNonValida(undefined, CALL, now, NESSUNA_CHIUSURA)).toBe('assente');
    expect(motivoDataNonValida('venerdì alle 18', CALL, now, NESSUNA_CHIUSURA)).toBe('illeggibile');
    expect(motivoDataNonValida('2026-10-30T18:00:00', CALL, now, NESSUNA_CHIUSURA)).toBe('illeggibile');
    expect(motivoDataNonValida('2026-10-28T12:00:00+01:00', CALL, now, NESSUNA_CHIUSURA)).toBe('passato');
    expect(motivoDataNonValida('2026-10-29T18:00:00+01:00', CALL, now, NESSUNA_CHIUSURA)).toBe('stessa_data');
    expect(motivoDataNonValida('2026-11-01T11:00:00+01:00', CALL, now, NESSUNA_CHIUSURA)).toBe('domenica');
    expect(motivoDataNonValida('2026-10-30T11:00:00+01:00', CALL, now, [{ from: '2026-10-30', to: '2026-10-30' }])).toBe('giorno_chiuso');
    expect(motivoDataNonValida('2026-11-02T11:00:00+01:00', CALL, now, NESSUNA_CHIUSURA)).toBe('fuori_finestra');
    expect(motivoDataNonValida('2026-10-28T19:00:00+01:00', CALL, now, NESSUNA_CHIUSURA)).toBe('fuori_finestra');
    expect(motivoDataNonValida('2026-10-30T08:30:00+01:00', CALL, now, NESSUNA_CHIUSURA)).toBe('fuori_fascia');
    expect(motivoDataNonValida('2026-10-30T21:30:00+01:00', CALL, now, NESSUNA_CHIUSURA)).toBe('fuori_fascia');
  });
  it('legge l\'ora di Roma anche se il tag è in UTC', () =>
    expect(motivoDataNonValida('2026-10-30T20:30:00Z', CALL, now, NESSUNA_CHIUSURA)).toBe('fuori_fascia'));
});

describe('testi', () => {
  it('prompt: giorni, fascia, una volta sola, tag', () => {
    const t = notaSpostamentoPrompt({ giorni: ['2026-10-29', '2026-10-30', '2026-10-31'], callAt: new Date(CALL) });
    expect(t).toContain('giovedì 29, venerdì 30 e sabato 31');
    expect(t).toContain('dalle 10:00 alle 21:00');
    expect(t).toContain('Si può spostare una volta sola');
    expect(t).toContain('[SPOSTA|');
    expect(t).toContain('[ESITO:RICHIAMO|');
    expect(t).toContain('giovedì 29 alle 18:00');
  });
  it('conferma: data nuova, Noemi, domanda sul video col link', () => {
    const t = testoSpostamentoFatto({
      nome: 'Luca Rossi', call: new Date('2026-10-30T18:00:00+01:00'), fissatoIl: MER_15, videoVisto: false, videoLink: 'https://x.it/v',
    });
    expect(t.split('\n')[0]).toBe('Fatto Luca, la tua videochiamata ora è *venerdì 30 alle 18:00*.');
    expect(t).toContain('una volta sola');
    expect(t).toContain('*Ti chiama Noemi, una nostra collega, venerdì 30, qualche ora prima*');
    expect(t).toContain("Il video l'hai già visto? Se no, guardalo prima della videochiamata 👉 https://x.it/v");
  });
  it('conferma: video già visto → niente riga del video', () => {
    const t = testoSpostamentoFatto({ nome: null, call: new Date('2026-10-30T11:00:00+01:00'), fissatoIl: MER_15, videoVisto: true, videoLink: 'https://x.it/v' });
    expect(t.startsWith('Fatto, ')).toBe(true);
    expect(t).not.toContain("Il video");
    expect(t).toContain('venerdì 30 in mattinata dalle 9');
  });
});

describe('parse del tag', () => {
  it('[SPOSTA|...] esce da spostaAt e mai in chat', () => {
    const r = parseMarioReply('[SPOSTA|2026-10-30T18:00:00+01:00]');
    expect(r.spostaAt).toBe('2026-10-30T18:00:00+01:00');
    expect(r.visibleReply).toBe('');
    expect(r.outcome).toBeUndefined();
  });
  it('senza tag niente spostaAt', () => expect(parseMarioReply('ciao').spostaAt).toBeUndefined());
});

describe('invio al CRM', () => {
  it('ok solo con rescheduled:true', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ ok: true, rescheduled: true }), { status: 200 }));
    expect(await inviaSpostamentoAlCrm('L1', '2026-10-30T18:00:00+01:00', 's', f as unknown as typeof fetch)).toEqual({ ok: true });
    const body = JSON.parse((f.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body).toEqual({ leadId: 'L1', outcome: 'SPOSTAMENTO', date: '2026-10-30T18:00:00+01:00' });
  });
  it('409 col motivo del CRM', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ error: 'spostamento_rifiutato', motivo: 'confermato' }), { status: 409 }));
    expect(await inviaSpostamentoAlCrm('L1', '2026-10-30T18:00:00+01:00', 's', f as unknown as typeof fetch)).toEqual({ ok: false, status: 409, motivo: 'confermato' });
  });
  it('rete giù: ok false, non lancia', async () => {
    const f = vi.fn(async () => { throw new Error('boom'); });
    expect(await inviaSpostamentoAlCrm('L1', '2026-10-30T18:00:00+01:00', 's', f as unknown as typeof fetch)).toEqual({ ok: false, motivo: 'boom' });
  });
});
