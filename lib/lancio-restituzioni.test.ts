import { describe, it, expect } from 'vitest';
import {
  RESTITUZIONE_ATTESA_MS, NOTA_RESTITUZIONE, FASI_RESTITUIBILI, restituzioniAttive, decideRestituzione,
  esitoRestituzioneDalCrm, notaInboundDopoRestituzione, type CandidataRestituzione,
} from './lancio-restituzioni';

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

describe('restituzioniAttive — dal giorno dopo dopodomani (8/10 per l evento del 5)', () => {
  it('7/10 23:59 Roma no, 8/10 00:00 Roma si, e segue l evento', () => {
    expect(restituzioniAttive(new Date('2026-10-07T23:59:00+02:00'), EVENTO)).toBe(false);
    expect(restituzioniAttive(new Date('2026-10-08T00:00:00+02:00'), EVENTO)).toBe(true);
    expect(restituzioniAttive(new Date('2026-10-20T10:00:00+02:00'), EVENTO)).toBe(true);
    expect(restituzioniAttive(new Date('2026-10-08T10:00:00+02:00'), new Date('2026-10-12T21:00:00+02:00'))).toBe(false);
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
    expect(decideRestituzione(c({ lancio_fase: 'post_pitch', bot_outcome: 'APPUNTAMENTO' }), NOW)).toEqual({ kind: 'niente', motivo: 'fase' });
  });
  it('post_pitch, scelta_fatta, chiuso, restituito, null: mai', () => {
    for (const f of ['post_pitch', 'scelta_fatta', 'chiuso', 'restituito', null]) {
      expect(decideRestituzione(c({ lancio_fase: f }), NOW)).toEqual({ kind: 'niente', motivo: 'fase' });
    }
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
  it('followup_inviato: silenzio dopo 48h → silenzio_dopo_followup; prima no; con risposta no', () => {
    const fu = new Date(NOW - RESTITUZIONE_ATTESA_MS - H).toISOString();
    expect(decideRestituzione(c({ lancio_fase: 'followup_inviato', haInteragito: true, lancio_followup_inviato_at: fu, last_inbound_at: '2026-10-05T20:00:00Z' }), NOW)).toEqual({ kind: 'restituisci', motivo: 'silenzio_dopo_followup' });
    const recente = new Date(NOW - RESTITUZIONE_ATTESA_MS + H).toISOString();
    expect(decideRestituzione(c({ lancio_fase: 'followup_inviato', haInteragito: true, lancio_followup_inviato_at: recente }), NOW)).toEqual({ kind: 'niente', motivo: 'attesa_48h' });
    expect(decideRestituzione(c({ lancio_fase: 'followup_inviato', haInteragito: true, lancio_followup_inviato_at: fu, last_inbound_at: new Date(NOW - H).toISOString() }), NOW)).toEqual({ kind: 'niente', motivo: 'ha_risposto' });
    expect(decideRestituzione(c({ lancio_fase: 'followup_inviato', haInteragito: true }), NOW)).toEqual({ kind: 'niente', motivo: 'incoerente' });
  });
  it('le note al CRM sono esattamente quelle che il CRM riconosce', () => {
    expect(NOTA_RESTITUZIONE).toEqual({
      mai_risposto: 'Lancio: mai risposto',
      silenzio_dopo_followup: 'Lancio: silenzio dopo il follow-up',
      followup_non_inviato: 'Lancio: follow-up non inviato',
    });
    expect([...FASI_RESTITUIBILI]).toEqual(['attesa', 'posto_bloccato', 'link_inviato', 'followup_inviato']);
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
