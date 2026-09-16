import { describe, it, expect } from 'vitest';
import {
  FASI_FOLLOWUP, inFinestraFollowup, finestraFollowupChiusa, ancoraLancio, inboundDopo, haInteragito,
  ultimoTestoInbound, haDettoNo, decideFollowup, lancioFollowupText, lancioStandardContextNote,
  lancioStandardDrain, NOTA_CONGEDO_FOLLOWUP, type CandidataFollowup,
} from './lancio-followup';
import type { RigaLancio } from './lancio-fase';

const EVENTO = new Date('2026-10-05T21:00:00+02:00');
const t = (iso: string) => new Date(iso);
const WELCOME = 'HX_WELCOME';
const out = (body: string, created_at: string, template_sid: string | null = null): RigaLancio => ({ direction: 'out', body, template_sid, created_at });
const inb = (body: string, created_at: string): RigaLancio => ({ direction: 'in', body, template_sid: null, created_at });

describe('inFinestraFollowup — 12:00-14:00 e 17:30-19:30 di Roma, il giorno dopo e dopodomani', () => {
  it('dentro: 12:00, 13:59, 17:30, 19:29 del 6 e del 7', () => {
    for (const iso of ['2026-10-06T12:00:00+02:00', '2026-10-06T13:59:00+02:00', '2026-10-06T17:30:00+02:00', '2026-10-06T19:29:00+02:00', '2026-10-07T12:05:00+02:00', '2026-10-07T18:00:00+02:00']) {
      expect(inFinestraFollowup(t(iso), EVENTO), iso).toBe(true);
    }
  });
  it('fuori: 11:59, 14:00, 17:29, 19:30, e le ore UTC coperte dallo schedule ma fuori fascia', () => {
    for (const iso of ['2026-10-06T11:59:00+02:00', '2026-10-06T14:00:00+02:00', '2026-10-06T17:29:00+02:00', '2026-10-06T19:30:00+02:00', '2026-10-06T17:05:00+02:00', '2026-10-06T19:45:00+02:00']) {
      expect(inFinestraFollowup(t(iso), EVENTO), iso).toBe(false);
    }
  });
  it('vale il 6 e il 7, non il 5 ne l 8, e segue l evento se si sposta', () => {
    expect(inFinestraFollowup(t('2026-10-05T12:30:00+02:00'), EVENTO)).toBe(false);
    expect(inFinestraFollowup(t('2026-10-08T12:30:00+02:00'), EVENTO)).toBe(false);
    expect(inFinestraFollowup(t('2026-10-13T12:30:00+02:00'), new Date('2026-10-12T21:00:00+02:00'))).toBe(true);
  });
  it('la finestra e chiusa solo dopo le 19:30 di dopodomani', () => {
    expect(finestraFollowupChiusa(t('2026-10-06T20:00:00+02:00'), EVENTO)).toBe(false);
    expect(finestraFollowupChiusa(t('2026-10-07T19:29:00+02:00'), EVENTO)).toBe(false);
    expect(finestraFollowupChiusa(t('2026-10-07T19:30:00+02:00'), EVENTO)).toBe(true);
    expect(finestraFollowupChiusa(t('2026-10-08T09:00:00+02:00'), EVENTO)).toBe(true);
  });
});

describe('ancoraLancio — da quando un inbound conta', () => {
  const rows = [out('vecchio giro di Mario', '2026-08-01T10:00:00Z'), out('benvenuto', '2026-09-20T10:00:00Z', WELCOME)];
  it('la colonna lancio_benvenuto_at vince su tutto', () => {
    expect(ancoraLancio({ rows, welcomeSid: WELCOME, benvenutoAt: '2026-09-20T10:00:05Z', ingressoAt: '2026-09-19T00:00:00Z' })).toBe('2026-09-20T10:00:05Z');
  });
  it('poi la riga del benvenuto in cronologia (l ultima), poi l istante dell intake', () => {
    expect(ancoraLancio({ rows, welcomeSid: WELCOME, benvenutoAt: null, ingressoAt: null })).toBe('2026-09-20T10:00:00Z');
    expect(ancoraLancio({ rows: [rows[0]], welcomeSid: WELCOME, benvenutoAt: null, ingressoAt: '2026-09-19T00:00:00Z' })).toBe('2026-09-19T00:00:00Z');
  });
  it('senza nessuno dei tre e null: ancora ignota', () => {
    expect(ancoraLancio({ rows: [rows[0]], welcomeSid: null, benvenutoAt: null, ingressoAt: null })).toBeNull();
  });
});

describe('haInteragito / ultimoTestoInbound', () => {
  const ancora = '2026-09-20T10:00:00Z';
  it('un inbound prima dell ancora non conta, uno dopo si', () => {
    expect(haInteragito([inb('ciao', '2026-09-01T10:00:00Z')], ancora)).toBe(false);
    expect(haInteragito([inb('ciao', '2026-09-01T10:00:00Z'), inb('ok', '2026-09-20T10:30:00Z')], ancora)).toBe(true);
    expect(inboundDopo([inb('ciao', '2026-09-01T10:00:00Z'), inb('ok', '2026-09-20T10:30:00Z')], ancora)).toHaveLength(1);
  });
  it('ancora ignota: mai interagito (si sbaglia verso il silenzio)', () => {
    expect(haInteragito([inb('ok', '2026-09-20T10:30:00Z')], null)).toBe(false);
  });
  it('l ultimo testo e l ultimo inbound leggibile dopo l ancora: i media si saltano', () => {
    const rows = [inb('si', '2026-09-20T10:30:00Z'), out('perfetto', '2026-09-20T10:31:00Z'), inb('no grazie', '2026-10-06T00:30:00Z'), inb('', '2026-10-06T00:31:00Z')];
    expect(ultimoTestoInbound(rows, ancora)).toBe('no grazie');
    expect(ultimoTestoInbound([inb('', '2026-09-20T10:30:00Z')], ancora)).toBe('');
  });
});

describe('haDettoNo — solo il rifiuto esplicito (congedoEsplicito), mai il no secco', () => {
  it('le frasi di rifiuto sono un no', () => {
    for (const s of ['No grazie', 'non mi interessa', 'toglimi dalla lista', 'non scrivetemi più', 'basta messaggi', 'numero sbagliato']) expect(haDettoNo(s), s).toBe(true);
  });
  it('un no secco, "certo che no" e tutto il resto NON sono un congedo: in assistenza il no risponde a una domanda del bot', () => {
    for (const s of ['no', 'certo che no', 'si', 'ok', 'quanto costa?', 'no ma sono interessato', 'nessun problema, ci sono', '']) expect(haDettoNo(s), s).toBe(false);
  });
});

describe('decideFollowup', () => {
  const ancora = '2026-09-20T10:00:00Z';
  const c = (over: Partial<CandidataFollowup> = {}): CandidataFollowup => ({
    lancio_fase: 'attesa',
    lancio_followup_inviato_at: null,
    lancio_info: null,
    rows: [out('benvenuto', ancora, WELCOME), inb('si', '2026-09-20T10:30:00Z')],
    ancora,
    ...over,
  });
  it('attesa/posto_bloccato/link_inviato con un inbound dopo l ancora: si manda', () => {
    for (const f of FASI_FOLLOWUP) expect(decideFollowup(c({ lancio_fase: f }))).toEqual({ kind: 'invia' });
  });
  it('fasi fuori perimetro: post_pitch, scelta_fatta, followup_inviato, chiuso, restituito, null', () => {
    for (const f of ['post_pitch', 'scelta_fatta', 'followup_inviato', 'chiuso', 'restituito', null]) {
      expect(decideFollowup(c({ lancio_fase: f }))).toEqual({ kind: 'salta', motivo: 'fase' });
    }
  });
  it('gia inviato (timbro presente, anche con fase indietro = esito incerto): non si rimanda', () => {
    expect(decideFollowup(c({ lancio_followup_inviato_at: '2026-10-06T10:00:00Z' }))).toEqual({ kind: 'salta', motivo: 'gia_inviato' });
  });
  it('congedato (lancio_info.congedo_at) vince su tutto, in qualunque fase', () => {
    expect(decideFollowup(c({ lancio_info: { congedo_at: '2026-10-05T23:00:00Z' } }))).toEqual({ kind: 'salta', motivo: 'congedato' });
  });
  it('ancora ignota o nessun inbound dopo l ancora: mai scritto', () => {
    expect(decideFollowup(c({ ancora: null }))).toEqual({ kind: 'salta', motivo: 'ancora_ignota' });
    expect(decideFollowup(c({ rows: [out('benvenuto', ancora, WELCOME), inb('ciao', '2026-08-01T10:00:00Z')] }))).toEqual({ kind: 'salta', motivo: 'mai_scritto' });
  });
  it('l ultimo inbound e un no netto: si congeda con le sue parole, non si manda', () => {
    const rows = [out('benvenuto', ancora, WELCOME), inb('si', '2026-09-20T10:30:00Z'), out('link', '2026-10-05T19:40:00Z', 'HX_ZOOM'), inb('No grazie, non mi interessa', '2026-10-06T00:30:00Z')];
    expect(decideFollowup(c({ lancio_fase: 'link_inviato', rows }))).toEqual({ kind: 'congeda', leadWords: 'No grazie, non mi interessa' });
  });
  it('un rifiuto seguito da un si non e un no: conta l ultimo', () => {
    const rows = [out('benvenuto', ancora, WELCOME), inb('non mi interessa', '2026-09-20T10:30:00Z'), inb('anzi si, mi interessa', '2026-09-20T10:35:00Z')];
    expect(decideFollowup(c({ rows }))).toEqual({ kind: 'invia' });
  });
  it('un no secco come ultimo inbound NON congeda: si manda (il no era la risposta a una domanda)', () => {
    const rows = [out('benvenuto', ancora, WELCOME), inb('si', '2026-09-20T10:30:00Z'), out('hai gia l app Zoom?', '2026-10-05T20:00:00Z'), inb('no', '2026-10-05T20:05:00Z')];
    expect(decideFollowup(c({ lancio_fase: 'link_inviato', rows }))).toEqual({ kind: 'invia' });
  });
});

describe('lancioStandardDrain — quando il drain deve usare il contesto della live', () => {
  it('vero solo per una chat del lancio in fase chiuso', () => {
    expect(lancioStandardDrain({ lancio_slug: 'webdev-2026-10', lancio_fase: 'chiuso' })).toBe(true);
    for (const f of ['attesa', 'posto_bloccato', 'link_inviato', 'post_pitch', 'scelta_fatta', 'followup_inviato', 'restituito', null]) {
      expect(lancioStandardDrain({ lancio_slug: 'webdev-2026-10', lancio_fase: f })).toBe(false);
    }
    expect(lancioStandardDrain({ lancio_slug: null, lancio_fase: 'chiuso' })).toBe(false);
    expect(lancioStandardDrain({})).toBe(false);
  });
});

describe('testi', () => {
  it('il follow-up e il template approvato (spec §7.3) col nome proprio', () => {
    expect(lancioFollowupText('Anna Verdi')).toBe(
      'Ciao Anna, ieri sera alla live abbiamo presentato il percorso Web Developer AI. Ti va di parlarne insieme? Rispondimi qui e ti mando anche il video riassuntivo della live.',
    );
  });
  it('la nota del congedo dal follow-up dice cosa e successo', () => {
    expect(NOTA_CONGEDO_FOLLOWUP).toBe('Lancio Web Dev AI: aveva detto di no prima del follow-up del giorno dopo la live, non gli abbiamo scritto.');
  });
  it('la nota di contesto porta il link della live e sostituisce i quattro video; senza link e null', () => {
    const nota = lancioStandardContextNote('https://corso.feniceacademy.it/live-webdev-2026');
    expect(nota).toContain('https://corso.feniceacademy.it/live-webdev-2026');
    expect(nota).toContain('conferenza-*');
    expect(nota).not.toMatch(/prezz|€|euro|sconto/i);
    expect(lancioStandardContextNote(null)).toBeNull();
    expect(lancioStandardContextNote('  ')).toBeNull();
  });
});
