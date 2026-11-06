import { describe, it, expect } from 'vitest';
import { finestraApertaSuNumero, inboundSulNumero, ultimoInboundSulNumero } from './finestra-numero';

const P3199 = 'whatsapp:+393520413199';
const P0047 = 'whatsapp:+393522070047';
const ORA = Date.parse('2026-11-06T15:00:00Z');
const H = 3600_000;
const iso = (ms: number) => new Date(ms).toISOString();

describe('finestraApertaSuNumero — la finestra 24h vale per numero, non per chat (06/11/2026)', () => {
  it('il lead ha scritto 2 ore fa al 0047: aperta dal 0047', () => {
    expect(finestraApertaSuNumero({ last_inbound_at: iso(ORA - 2 * H), last_inbound_number: P0047 }, P0047, ORA)).toBe(true);
  });

  it('stesso inbound, invio dal 3199: CHIUSA (sarebbe un 63016)', () => {
    expect(finestraApertaSuNumero({ last_inbound_at: iso(ORA - 2 * H), last_inbound_number: P0047 }, P3199, ORA)).toBe(false);
  });

  it('prefisso whatsapp: o no, e lo stesso numero', () => {
    expect(finestraApertaSuNumero({ last_inbound_at: iso(ORA - 2 * H), last_inbound_number: P0047 }, '+393522070047', ORA)).toBe(true);
  });

  it('oltre le 24h: chiusa anche sul numero giusto', () => {
    expect(finestraApertaSuNumero({ last_inbound_at: iso(ORA - 24 * H), last_inbound_number: P0047 }, P0047, ORA)).toBe(false);
  });

  it('numero dell\'inbound non registrato (righe vecchie): come prima, conta solo l\'ora', () => {
    expect(finestraApertaSuNumero({ last_inbound_at: iso(ORA - 2 * H), last_inbound_number: null }, P3199, ORA)).toBe(true);
  });

  it('mai scritto: chiusa', () => {
    expect(finestraApertaSuNumero({ last_inbound_at: null, last_inbound_number: null }, P3199, ORA)).toBe(false);
  });

  it('mittente sconosciuto con inbound noto: chiusa (nel dubbio template)', () => {
    expect(finestraApertaSuNumero({ last_inbound_at: iso(ORA - 2 * H), last_inbound_number: P0047 }, undefined, ORA)).toBe(false);
  });
});

describe('ultimoInboundSulNumero / inboundSulNumero', () => {
  it("passa l'istante solo se l'inbound e' arrivato sul mittente", () => {
    expect(ultimoInboundSulNumero(iso(ORA), P0047, P0047)).toBe(iso(ORA));
    expect(ultimoInboundSulNumero(ORA, P0047, P3199)).toBeNull();
    expect(ultimoInboundSulNumero(null, P0047, P0047)).toBeNull();
  });
  it('dato assente: si', () => {
    expect(inboundSulNumero(null, P3199)).toBe(true);
  });
});
