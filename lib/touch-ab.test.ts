import { describe, it, expect } from 'vitest';
import type { StatoQualita } from './qualita-numeri';
import { parseConfigTouchAb, braccioTouchAb, nelTestTouchAb, idoneaTouchAb, decidiStopTouchAb } from './touch-ab';

const ok = { attivo: true, numero: '+393522018718', dal: '2026-11-14', fino: '2026-12-05', braccio_touch: 'dispari', fermato: null };
const H = 3600_000;

describe('parseConfigTouchAb', () => {
  it('config valida', () => {
    expect(parseConfigTouchAb(ok).config).toEqual({ numero: '+393522018718', dal: '2026-11-14', fino: '2026-12-05', braccioTouch: 'dispari' });
  });
  it('spento: attivo false, riga assente, fermato, numeri esclusi, date rotte', () => {
    expect(parseConfigTouchAb({ ...ok, attivo: false }).config).toBeNull();
    expect(parseConfigTouchAb(null).config).toBeNull();
    const f = parseConfigTouchAb({ ...ok, fermato: { giorno: '2026-11-20', at: 'x', motivo: 'sotto_high' } });
    expect(f.config).toBeNull();
    expect(f.fermato?.motivo).toBe('sotto_high');
    expect(parseConfigTouchAb({ ...ok, numero: 'whatsapp:+393522070047' }).config).toBeNull();
    expect(parseConfigTouchAb({ ...ok, numero: '+393520413199' }).config).toBeNull();
    expect(parseConfigTouchAb({ ...ok, fino: '2026-11-01' }).config).toBeNull();
  });
});

describe('braccioTouchAb', () => {
  it('pari/dispari stabile', () => {
    expect(braccioTouchAb(101, 'dispari')).toBe('touch');
    expect(braccioTouchAb(102, 'dispari')).toBe('controllo');
    expect(braccioTouchAb(102, 'pari')).toBe('touch');
  });
});

describe('nelTestTouchAb', () => {
  const config = parseConfigTouchAb(ok).config!;
  it('solo numero del test e arruolate in [dal, fino)', () => {
    expect(nelTestTouchAb(config, { wa_number: 'whatsapp:+393522018718', ai_started_at: '2026-11-14T08:00:00Z' })).toBe(true);
    expect(nelTestTouchAb(config, { wa_number: 'whatsapp:+393522622245', ai_started_at: '2026-11-14T08:00:00Z' })).toBe(false);
    expect(nelTestTouchAb(config, { wa_number: 'whatsapp:+393522018718', ai_started_at: '2026-11-13T21:00:00Z' })).toBe(false);
    expect(nelTestTouchAb(config, { wa_number: 'whatsapp:+393522018718', ai_started_at: '2026-12-05T08:00:00Z' })).toBe(false);
  });
});

describe('idoneaTouchAb', () => {
  const ap = { direction: 'out', twilio_status: 'read', template_sid: 'HXa', created_at: new Date(0).toISOString() };
  it('mai risposto, consegnata, >= 20h', () => {
    expect(idoneaTouchAb([ap], 21 * H)).toBe(true);
    expect(idoneaTouchAb([ap], 19 * H)).toBe(false);
    expect(idoneaTouchAb([{ ...ap, twilio_status: 'undelivered' }], 21 * H)).toBe(false);
    expect(idoneaTouchAb([ap, { direction: 'in', twilio_status: null, template_sid: null, created_at: new Date(H).toISOString() }], 21 * H)).toBe(false);
  });
});

describe('decidiStopTouchAb — stop a scatto', () => {
  const config = parseConfigTouchAb(ok).config!;
  const oggi = '2026-11-20';
  const st = (q?: string): StatoQualita => ({ storico: { '+393522018718': (q ? { [oggi]: q } : {}) as Record<string, 'HIGH'> }, pause: {} });
  it('HIGH: si invia', () => {
    expect(decidiStopTouchAb({ config, stato: st('HIGH'), tetti: null, oggi })).toEqual({ stop: false, puoInviare: true });
  });
  it('MEDIUM: stop (anche solo MEDIUM)', () => {
    expect(decidiStopTouchAb({ config, stato: st('MEDIUM'), tetti: null, oggi })).toMatchObject({ stop: true, motivo: 'sotto_high', qualita: 'MEDIUM' });
  });
  it('in pausa o tetto 0: stop', () => {
    expect(decidiStopTouchAb({ config, stato: { storico: {}, pause: { '+393522018718': { fino: 'x', tettoPrima: 1, dal: 'x' } } }, tetti: null, oggi })).toMatchObject({ stop: true, motivo: 'in_pausa' });
    expect(decidiStopTouchAb({ config, stato: st('HIGH'), tetti: { 'whatsapp:+393522018718': 0 }, oggi })).toMatchObject({ stop: true, motivo: 'tetto_zero' });
  });
  it('nessuna lettura: niente stop ma niente invio', () => {
    expect(decidiStopTouchAb({ config, stato: st(), tetti: null, oggi })).toEqual({ stop: false, puoInviare: false });
  });
});
