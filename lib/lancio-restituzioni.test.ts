import { describe, it, expect } from 'vitest';
import {
  RESTITUZIONE_ATTESA_MS, NOTA_RESTITUZIONE, FASI_RESTITUIBILI, RESTITUZIONI_MAX_DEFAULT,
  restituzioniAttive, inFasciaRestituzioni, FASCIA_RESTITUZIONI, decideRestituzione,
  esitoRestituzioneDalCrm, notaInboundDopoRestituzione, fuoriFinestraCron, type CandidataRestituzione,
} from './lancio-restituzioni';
import { batchMax } from './lancio-zoom-blast';

const H = 3600_000;
const EVENTO = new Date('2026-10-05T21:00:00+02:00');
const NOW = Date.parse('2026-10-08T10:00:00+02:00');
const c = (over: Partial<CandidataRestituzione> = {}): CandidataRestituzione => ({
  lancio_fase: 'attesa',
  lancio_followup_inviato_at: null,
  last_inbound_at: null,
  crm_lead_id: 'lead-1',
  bot_outcome: null,
  lancio_info: null,
  ancora: '2026-09-20T10:00:00Z',
  haInteragito: false,
  ...over,
});

describe('restituzioniAttive — da dopodomani compreso (7/10 per l evento del 5)', () => {
  it('6/10 23:59 Roma no (il 6 e tutto del bot), 7/10 00:00 Roma si, e segue l evento', () => {
    expect(restituzioniAttive(new Date('2026-10-06T23:59:00+02:00'), EVENTO)).toBe(false);
    expect(restituzioniAttive(new Date('2026-10-07T00:00:00+02:00'), EVENTO)).toBe(true);
    expect(restituzioniAttive(new Date('2026-10-07T23:59:00+02:00'), EVENTO)).toBe(true);
    expect(restituzioniAttive(new Date('2026-10-20T10:00:00+02:00'), EVENTO)).toBe(true);
    expect(restituzioniAttive(new Date('2026-10-08T10:00:00+02:00'), new Date('2026-10-12T21:00:00+02:00'))).toBe(false);
  });
});

describe('fuoriFinestraCron — l evento spostato fuori dalle date scritte a mano in vercel.json', () => {
  it('dentro 7/10-15/11 no; dopo il 15/11 si; prima della data delle restituzioni mai', () => {
    // Il cron di vercel.json parte dal 7: il primo giorno delle restituzioni e coperto.
    expect(fuoriFinestraCron(new Date('2026-10-07T10:00:00+02:00'), EVENTO)).toBe(false);
    expect(fuoriFinestraCron(new Date('2026-10-08T10:00:00+02:00'), EVENTO)).toBe(false);
    expect(fuoriFinestraCron(new Date('2026-11-15T10:00:00+01:00'), EVENTO)).toBe(false);
    expect(fuoriFinestraCron(new Date('2026-11-16T10:00:00+01:00'), EVENTO)).toBe(true);
    expect(fuoriFinestraCron(new Date('2026-12-01T10:00:00+01:00'), EVENTO)).toBe(true);
    // Restituzioni non ancora attive: non c'e' niente da segnalare.
    expect(fuoriFinestraCron(new Date('2026-10-06T10:00:00+02:00'), EVENTO)).toBe(false);
    // Evento spostato a fine novembre: le restituzioni partirebbero il 1/12, quando il
    // cron non gira piu'.
    expect(fuoriFinestraCron(new Date('2026-12-02T10:00:00+01:00'), new Date('2026-11-29T21:00:00+01:00'))).toBe(true);
  });
});

describe('decideRestituzione', () => {
  it('senza lead CRM: niente', () => {
    expect(decideRestituzione(c({ crm_lead_id: null }), NOW)).toEqual({ kind: 'niente', motivo: 'senza_crm' });
  });
  it('C2: congedo uscito e fase non chiusa → ritenta lo scarto, in qualunque fase', () => {
    for (const f of ['attesa', 'link_inviato', 'post_pitch']) {
      expect(decideRestituzione(c({ lancio_fase: f, lancio_info: { congedo_at: '2026-10-05T23:00:00Z' }, haInteragito: true }), NOW)).toEqual({ kind: 'ritenta_scarto' });
    }
    expect(decideRestituzione(c({ lancio_fase: 'chiuso', lancio_info: { congedo_at: '2026-10-05T23:00:00Z' } }), NOW)).toEqual({ kind: 'niente', motivo: 'fase' });
  });
  it('un esito gia dato non si sovrascrive; su una fase fuori perimetro conta prima la fase', () => {
    expect(decideRestituzione(c({ bot_outcome: 'APPUNTAMENTO' }), NOW)).toEqual({ kind: 'niente', motivo: 'esito_presente' });
    expect(decideRestituzione(c({ lancio_fase: 'scelta_fatta', bot_outcome: 'APPUNTAMENTO' }), NOW)).toEqual({ kind: 'niente', motivo: 'fase' });
  });
  it('scelta_fatta, chiuso, restituito, null: mai (la scelta e del CRM, non del bot)', () => {
    for (const f of ['scelta_fatta', 'chiuso', 'restituito', null]) {
      expect(decideRestituzione(c({ lancio_fase: f }), NOW)).toEqual({ kind: 'niente', motivo: 'fase' });
    }
  });
  // Un `post_pitch` rimasto a meta' non ha piu' nessuno che lo guardi: il follow-up del 6
  // e' l'ultima occasione, e dall'8 torna al pool come tutti gli altri.
  it('post_pitch: chi ha interagito e non ha avuto il follow-up torna al pool (followup_non_inviato)', () => {
    expect(decideRestituzione(c({ lancio_fase: 'post_pitch', haInteragito: true }), NOW)).toEqual({ kind: 'restituisci', motivo: 'followup_non_inviato' });
  });
  it('post_pitch senza nessun inbound dopo l ancora: mai_risposto', () => {
    expect(decideRestituzione(c({ lancio_fase: 'post_pitch' }), NOW)).toEqual({ kind: 'restituisci', motivo: 'mai_risposto' });
  });
  it('post_pitch col timbro del follow-up: valgono le 24 ore, come per followup_inviato', () => {
    const fu = new Date(NOW - RESTITUZIONE_ATTESA_MS - H).toISOString();
    expect(decideRestituzione(c({ lancio_fase: 'post_pitch', haInteragito: true, lancio_followup_inviato_at: fu }), NOW)).toEqual({ kind: 'restituisci', motivo: 'silenzio_dopo_followup' });
    const recente = new Date(NOW - RESTITUZIONE_ATTESA_MS + H).toISOString();
    expect(decideRestituzione(c({ lancio_fase: 'post_pitch', haInteragito: true, lancio_followup_inviato_at: recente }), NOW)).toEqual({ kind: 'niente', motivo: 'attesa_24h' });
  });
  it('ancora ignota: si lascia a una persona', () => {
    expect(decideRestituzione(c({ ancora: null }), NOW)).toEqual({ kind: 'niente', motivo: 'ancora_ignota' });
  });
  it('attesa/posto_bloccato/link_inviato senza interazione → mai_risposto', () => {
    for (const f of ['attesa', 'posto_bloccato', 'link_inviato']) {
      expect(decideRestituzione(c({ lancio_fase: f }), NOW)).toEqual({ kind: 'restituisci', motivo: 'mai_risposto' });
    }
  });
  it('R2: ha interagito ma il follow-up non e mai partito → followup_non_inviato', () => {
    expect(decideRestituzione(c({ lancio_fase: 'link_inviato', haInteragito: true }), NOW)).toEqual({ kind: 'restituisci', motivo: 'followup_non_inviato' });
    expect(decideRestituzione(c({ lancio_fase: 'posto_bloccato', haInteragito: true }), NOW)).toEqual({ kind: 'restituisci', motivo: 'followup_non_inviato' });
  });
  it('timbro del follow-up presente con fase indietro (esito incerto): valgono le regole del followup_inviato', () => {
    const fu = new Date(NOW - RESTITUZIONE_ATTESA_MS - H).toISOString();
    expect(decideRestituzione(c({ lancio_fase: 'link_inviato', haInteragito: true, lancio_followup_inviato_at: fu }), NOW)).toEqual({ kind: 'restituisci', motivo: 'silenzio_dopo_followup' });
  });
  it('followup_inviato: silenzio dopo 24h → silenzio_dopo_followup; prima no; con risposta fresca no', () => {
    const fu = new Date(NOW - RESTITUZIONE_ATTESA_MS - H).toISOString();
    expect(decideRestituzione(c({ lancio_fase: 'followup_inviato', haInteragito: true, lancio_followup_inviato_at: fu, last_inbound_at: '2026-10-05T20:00:00Z' }), NOW)).toEqual({ kind: 'restituisci', motivo: 'silenzio_dopo_followup' });
    const recente = new Date(NOW - RESTITUZIONE_ATTESA_MS + H).toISOString();
    expect(decideRestituzione(c({ lancio_fase: 'followup_inviato', haInteragito: true, lancio_followup_inviato_at: recente }), NOW)).toEqual({ kind: 'niente', motivo: 'attesa_24h' });
    expect(decideRestituzione(c({ lancio_fase: 'followup_inviato', haInteragito: true, lancio_followup_inviato_at: fu, last_inbound_at: new Date(NOW - H).toISOString() }), NOW)).toEqual({ kind: 'niente', motivo: 'ha_risposto' });
    expect(decideRestituzione(c({ lancio_fase: 'followup_inviato', haInteragito: true }), NOW)).toEqual({ kind: 'niente', motivo: 'incoerente' });
  });
  // Regola PO 19/09: l'attesa si misura sull'ULTIMO messaggio in qualunque direzione.
  // Chi risponde resta al bot finche' la chat e' viva, poi torna al pool "man mano".
  it('chi ha risposto e poi e sparito da 24h torna al pool; se la risposta e fresca no', () => {
    const fu = new Date(NOW - 5 * 24 * H).toISOString();
    const rispostaVecchia = new Date(NOW - 25 * H).toISOString();
    expect(decideRestituzione(c({ lancio_fase: 'followup_inviato', haInteragito: true, lancio_followup_inviato_at: fu, last_inbound_at: rispostaVecchia }), NOW))
      .toEqual({ kind: 'restituisci', motivo: 'silenzio_dopo_followup' });
    const rispostaFresca = new Date(NOW - 23 * H).toISOString();
    expect(decideRestituzione(c({ lancio_fase: 'followup_inviato', haInteragito: true, lancio_followup_inviato_at: fu, last_inbound_at: rispostaFresca }), NOW))
      .toEqual({ kind: 'niente', motivo: 'ha_risposto' });
  });
  it('la soglia e 24 ore, non piu 48', () => {
    expect(RESTITUZIONE_ATTESA_MS).toBe(24 * H);
  });
  it('le note al CRM sono esattamente quelle che il CRM riconosce', () => {
    expect(NOTA_RESTITUZIONE).toEqual({
      mai_risposto: 'Lancio: mai risposto',
      silenzio_dopo_followup: 'Lancio: silenzio dopo il follow-up',
      followup_non_inviato: 'Lancio: follow-up non inviato',
    });
    expect([...FASI_RESTITUIBILI]).toEqual(['attesa', 'posto_bloccato', 'link_inviato', 'post_pitch', 'followup_inviato']);
  });
  it('il tetto delle restituzioni e suo: 100 l ora di default (PO 25/09), e non lo decide LANCIO_BATCH_MAX', () => {
    expect(RESTITUZIONI_MAX_DEFAULT).toBe(100);
    expect(batchMax(undefined, RESTITUZIONI_MAX_DEFAULT)).toBe(100);
    expect(batchMax('', RESTITUZIONI_MAX_DEFAULT)).toBe(100);
    expect(batchMax('0', RESTITUZIONI_MAX_DEFAULT)).toBe(100);
    expect(batchMax('boh', RESTITUZIONI_MAX_DEFAULT)).toBe(100);
    expect(batchMax('120', RESTITUZIONI_MAX_DEFAULT)).toBe(120);
  });
});

describe('esitoRestituzioneDalCrm — si legge il corpo, non solo lo status', () => {
  it('returnedToPool true → restituito; already_returned → gia_restituito', () => {
    expect(esitoRestituzioneDalCrm({ sent: true, status: 200, corpo: { ok: true, returnedToPool: true, motivo: 'mai_risposto' } })).toEqual({ esito: 'restituito', skipped: null });
    expect(esitoRestituzioneDalCrm({ sent: true, status: 200, corpo: { ok: true, returnedToPool: false, skipped: 'already_returned' } })).toEqual({ esito: 'gia_restituito', skipped: 'already_returned' });
  });
  it('un 200 che dice "non l ho restituito" e un rifiuto, con il suo motivo', () => {
    for (const skipped of ['locked_appointment', 'scelta_fatta', 'already_rejected', 'not_bot', 'lead_not_found']) {
      expect(esitoRestituzioneDalCrm({ sent: true, status: 200, corpo: { ok: true, returnedToPool: false, skipped } })).toEqual({ esito: 'rifiutato_dal_crm', skipped });
    }
  });
  it('un 2xx senza corpo leggibile non e una conferma', () => {
    expect(esitoRestituzioneDalCrm({ sent: true, status: 200 })).toEqual({ esito: 'non_confermato', skipped: null });
    expect(esitoRestituzioneDalCrm({ sent: true, status: 200, corpo: { ok: true } })).toEqual({ esito: 'non_confermato', skipped: null });
  });
  it('403 e 404 sono terminali; rete e 5xx si ritentano', () => {
    expect(esitoRestituzioneDalCrm({ sent: false, status: 403 })).toEqual({ esito: 'terminale', skipped: null });
    expect(esitoRestituzioneDalCrm({ sent: false, status: 404 })).toEqual({ esito: 'terminale', skipped: null });
    expect(esitoRestituzioneDalCrm({ sent: false, status: 500 })).toEqual({ esito: 'ritenta', skipped: null });
    expect(esitoRestituzioneDalCrm({ sent: false })).toEqual({ esito: 'ritenta', skipped: null });
  });
});

describe('notaInboundDopoRestituzione', () => {
  it('dice che ha riscritto, quando (ora di Roma) e cosa, e che il bot tace', () => {
    const n = notaInboundDopoRestituzione('ci sono ancora?', '2026-10-09T08:15:00Z');
    expect(n).toContain('dopo il ritorno nel pool');
    expect(n).toContain('alle 10:15');
    expect(n).toContain('"ci sono ancora?"');
    // La frase e' a inizio periodo nella nota, quindi il confronto e' sul senso, non sulla maiuscola.
    expect(n.toLowerCase()).toContain('il bot non risponde');
  });
});

describe('inFasciaRestituzioni — mai di notte, a scaglioni di giorno (PO 25/09)', () => {
  const r = (iso: string) => inFasciaRestituzioni(new Date(iso));
  it('lun-sab dalle 09:00 al run delle 18:00 compreso', () => {
    expect(FASCIA_RESTITUZIONI).toEqual({ daOra: 9, aOra: 18 });
    expect(r('2026-10-07T08:59:00+02:00')).toBe(false); // mercoledi
    expect(r('2026-10-07T09:00:00+02:00')).toBe(true);
    expect(r('2026-10-07T18:00:00+02:00')).toBe(true);
    expect(r('2026-10-07T19:00:00+02:00')).toBe(false);
    expect(r('2026-10-08T03:00:00+02:00')).toBe(false);
    expect(r('2026-10-10T12:00:00+02:00')).toBe(true); // sabato
  });
  it('domenica mai, nemmeno a mezzogiorno', () => {
    expect(r('2026-10-11T12:00:00+02:00')).toBe(false);
  });
  it('dopo il cambio dell ora (25/10) la fascia resta in ora di Roma', () => {
    expect(r('2026-10-26T09:00:00+01:00')).toBe(true);
    expect(r('2026-10-26T08:00:00+01:00')).toBe(false);
  });
});

describe('lo schedule di vercel.json copre la fascia, e solo di giorno', () => {
  it('ogni ora 07-17 UTC, 7-31/10 e 1-15/11: con e senza ora legale copre le 09-18 di Roma', async () => {
    const { readFileSync } = await import('node:fs');
    const { crons } = JSON.parse(readFileSync('vercel.json', 'utf8')) as { crons: { path: string; schedule: string }[] };
    const voci = crons.filter((c) => c.path === '/api/cron/lancio-restituzioni').map((c) => c.schedule);
    expect(voci).toEqual(['0 7-17 7-31 10 *', '0 7-17 1-15 11 *']);
    // Ogni ora della fascia di Roma cade in un'ora UTC del cron, prima e dopo il 25/10.
    for (const giorno of ['2026-10-07', '2026-10-27']) {
      for (let ora = FASCIA_RESTITUZIONI.daOra; ora <= FASCIA_RESTITUZIONI.aOra; ora++) {
        const offset = giorno < '2026-10-25' ? '+02:00' : '+01:00';
        const utc = new Date(`${giorno}T${String(ora).padStart(2, '0')}:00:00${offset}`).getUTCHours();
        expect(utc).toBeGreaterThanOrEqual(7);
        expect(utc).toBeLessThanOrEqual(17);
      }
    }
  });
});
