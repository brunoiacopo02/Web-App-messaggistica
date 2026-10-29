import { describe, it, expect } from 'vitest';
import {
  decidiInvio,
  decidiChiusura,
  numeroIdoneo,
  parseImpostazioni,
  sollecitoSids,
  sidPerConversazione,
  inizioGiornoRomaIso,
} from './sollecito-parcheggio';
import type { MsgLite } from './sequence';

const H = 3600_000;
const SID = 'HXsollecito';
// Martedi' 03/11/2026, ora solare (UTC+1).
const roma = (giorno: number, ora: number, min = 0) => Date.UTC(2026, 10, giorno, ora - 1, min);

const apertura = (t: number, status = 'read'): MsgLite => ({
  direction: 'out', twilio_status: status, template_sid: 'HXapertura', created_at: new Date(t).toISOString(), is_template: true,
});
const sollecito = (t: number, status = 'delivered'): MsgLite => ({
  direction: 'out', twilio_status: status, template_sid: SID, created_at: new Date(t).toISOString(), is_template: true,
});
const inbound = (t: number): MsgLite => ({
  direction: 'in', twilio_status: 'received', template_sid: null, created_at: new Date(t).toISOString(),
});

describe('decidiInvio', () => {
  const t0 = roma(3, 13);
  it('20h dopo, in fascia, apertura consegnata: si manda', () => {
    expect(decidiInvio({ nowMs: roma(4, 9), msgs: [apertura(t0)], sids: [SID] })).toEqual({ invia: true });
  });
  it('prima delle 20h: presto', () => {
    expect(decidiInvio({ nowMs: roma(4, 8, 59), msgs: [apertura(t0)], sids: [SID] })).toEqual({ invia: false, motivo: 'presto' });
  });
  it('apertura alle 07: a t0+20 e\' notte, parte alle 08:30', () => {
    const a = roma(3, 7);
    expect(decidiInvio({ nowMs: roma(4, 3), msgs: [apertura(a)], sids: [SID] })).toEqual({ invia: false, motivo: 'fuori_fascia' });
    expect(decidiInvio({ nowMs: roma(4, 8, 30), msgs: [apertura(a)], sids: [SID] })).toEqual({ invia: true });
  });
  it('oltre le 30h: tardi', () => {
    expect(decidiInvio({ nowMs: t0 + 30 * H, msgs: [apertura(t0)], sids: [SID] })).toEqual({ invia: false, motivo: 'tardi' });
  });
  it('ha risposto: mai', () => {
    expect(decidiInvio({ nowMs: roma(4, 9), msgs: [apertura(t0), inbound(t0 + H)], sids: [SID] }).invia).toBe(false);
  });
  it('gia\' inviato (anche fallito): mai un secondo', () => {
    expect(decidiInvio({ nowMs: roma(4, 10), msgs: [apertura(t0), sollecito(roma(4, 9), 'failed')], sids: [SID] }))
      .toEqual({ invia: false, motivo: 'gia_inviato' });
  });
  it('apertura mai consegnata: niente sollecito', () => {
    expect(decidiInvio({ nowMs: roma(4, 9), msgs: [apertura(t0, 'failed')], sids: [SID] }))
      .toEqual({ invia: false, motivo: 'mai_consegnato' });
  });
  it('apertura solo inviata (sent): non si sa se arrivata, niente sollecito', () => {
    expect(decidiInvio({ nowMs: roma(4, 9), msgs: [apertura(t0, 'sent')], sids: [SID] }).invia).toBe(false);
  });
});

describe('decidiChiusura', () => {
  const t0 = roma(3, 13);
  it('spento (puoRicevere false): chiude a 24h come oggi', () => {
    expect(decidiChiusura({ nowMs: t0 + 24 * H, msgs: [apertura(t0)], sids: [SID], puoRicevere: false })).toBe('chiudi');
  });
  it('numero idoneo, sollecito non ancora partito: aspetta fino a 30h', () => {
    expect(decidiChiusura({ nowMs: t0 + 25 * H, msgs: [apertura(t0)], sids: [SID], puoRicevere: true })).toBe('aspetta');
    expect(decidiChiusura({ nowMs: t0 + 30 * H, msgs: [apertura(t0)], sids: [SID], puoRicevere: true })).toBe('chiudi');
  });
  it('sollecito partito: 24h di attesa dal sollecito, anche se il numero nel frattempo non e\' piu\' idoneo', () => {
    const s = t0 + 21 * H;
    const msgs = [apertura(t0), sollecito(s)];
    expect(decidiChiusura({ nowMs: s + 23 * H, msgs, sids: [SID], puoRicevere: false })).toBe('aspetta');
    expect(decidiChiusura({ nowMs: s + 24 * H, msgs, sids: [SID], puoRicevere: false })).toBe('chiudi');
  });
  it('sollecito fallito: chiude subito', () => {
    const msgs = [apertura(t0), sollecito(t0 + 21 * H, 'failed')];
    expect(decidiChiusura({ nowMs: t0 + 25 * H, msgs, sids: [SID], puoRicevere: true })).toBe('chiudi');
  });
  it('apertura mai consegnata: chiude subito', () => {
    expect(decidiChiusura({ nowMs: t0 + 25 * H, msgs: [apertura(t0, 'undelivered')], sids: [SID], puoRicevere: true })).toBe('chiudi');
  });
});

describe('numeroIdoneo', () => {
  const P = 'whatsapp:+393520413199';
  const A = 'whatsapp:+393520158061';
  const base = {
    numero: A,
    primario: P,
    tetti: new Map([['+393520158061', 100000], ['+393520413199', 100000]]),
    stato: { storico: { '+393520158061': { '2026-11-03': 'HIGH' as const } }, pause: {} },
    oggi: '2026-11-03',
    inviatiOggi: 0,
    tettoGiorno: 30,
  };
  it('secondario HIGH sotto il tetto: ok', () => expect(numeroIdoneo(base)).toEqual({ ok: true }));
  it('mai dal 3199, anche se HIGH e in giro', () =>
    expect(numeroIdoneo({ ...base, numero: P, stato: { storico: { '+393520413199': { '2026-11-03': 'HIGH' } }, pause: {} } }))
      .toEqual({ ok: false, motivo: 'primario' }));
  it('tetto aperture 0: no', () =>
    expect(numeroIdoneo({ ...base, tetti: new Map([['+393520158061', 0]]) })).toEqual({ ok: false, motivo: 'tetto_numeri_zero' }));
  it('tetti illeggibili: no', () => expect(numeroIdoneo({ ...base, tetti: null }).ok).toBe(false));
  it('in pausa per qualita\': no', () =>
    expect(numeroIdoneo({ ...base, stato: { ...base.stato, pause: { '+393520158061': { fino: '2026-11-05', tettoPrima: 100000, dal: '2026-11-02' } } } }))
      .toEqual({ ok: false, motivo: 'in_pausa_qualita' }));
  it('MEDIUM oggi o nessuna lettura oggi: no', () => {
    expect(numeroIdoneo({ ...base, stato: { storico: { '+393520158061': { '2026-11-03': 'MEDIUM' } }, pause: {} } }).ok).toBe(false);
    expect(numeroIdoneo({ ...base, oggi: '2026-11-04' })).toEqual({ ok: false, motivo: 'non_high_oggi' });
  });
  it('tetto dei solleciti raggiunto: no', () =>
    expect(numeroIdoneo({ ...base, inviatiOggi: 30 })).toEqual({ ok: false, motivo: 'tetto_solleciti' }));
});

describe('impostazioni e SID', () => {
  it('fallisce chiuso', () => {
    expect(parseImpostazioni(null).attivo).toBe(false);
    expect(parseImpostazioni({ attivo: 'true', tetto_giorno_numero: 30 }).attivo).toBe(false);
    expect(parseImpostazioni({ attivo: true }).attivo).toBe(false);
    expect(parseImpostazioni({ attivo: true, tetto_giorno_numero: 0 }).attivo).toBe(false);
    expect(parseImpostazioni({ attivo: true, tetto_giorno_numero: 30 })).toEqual({ attivo: true, tettoGiornoNumero: 30 });
  });
  it('SID separati da virgola, variante stabile per conversazione', () => {
    expect(sollecitoSids({ SOLLECITO_PARCHEGGIO_SID: ' HXa, HXb ,' })).toEqual(['HXa', 'HXb']);
    expect(sollecitoSids({})).toEqual([]);
    expect(sidPerConversazione(['HXa', 'HXb'], 7)).toBe('HXb');
    expect(sidPerConversazione([], 7)).toBeNull();
  });
  it('mezzanotte di Roma', () => {
    expect(inizioGiornoRomaIso(roma(3, 0, 30))).toBe('2026-11-03T00:00:00+01:00');
  });
});
