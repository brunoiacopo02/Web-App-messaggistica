import { describe, expect, it } from 'vitest';
import { pianoNoemi, giornoLavorativoPrima, fissatoIlDi } from './noemi-quando';
import { romeDayKey } from './rome-time';

const lun = new Date('2026-10-26T11:00:00+01:00');

describe('pianoNoemi: quando chiama Noemi (PO 24/10/2026)', () => {
  it('dalle 15 in poi: lo stesso giorno, qualche ora prima', () => {
    expect(pianoNoemi(new Date('2026-10-27T15:00:00+01:00'), lun).caso).toBe('pomeriggio');
    expect(pianoNoemi(new Date('2026-10-30T18:00:00+01:00'), lun).caso).toBe('pomeriggio');
  });

  it('mattina di domani fissata oggi: la mattina stessa', () => {
    expect(pianoNoemi(new Date('2026-10-27T10:00:00+01:00'), lun).caso).toBe('mattina-stessa');
    expect(pianoNoemi(new Date('2026-10-27T14:00:00+01:00'), lun).caso).toBe('mattina-stessa');
  });

  it('mattina fissata con anticipo: il giorno prima, poi la mattina stessa', () => {
    const p = pianoNoemi(new Date('2026-10-28T11:00:00+01:00'), lun);
    expect(p.caso).toBe('giorno-prima-poi-mattina');
    expect(romeDayKey(p.giornoPrima)).toBe('2026-10-27');
  });

  it('le 9: sempre il giorno prima', () => {
    expect(pianoNoemi(new Date('2026-10-27T09:00:00+01:00'), lun).caso).toBe('giorno-prima');
    expect(pianoNoemi(new Date('2026-10-29T09:00:00+01:00'), lun).caso).toBe('giorno-prima');
  });

  it('fissato sabato per lunedì mattina: lunedì è il giorno lavorativo dopo, quindi la mattina stessa', () => {
    const sab = new Date('2026-10-24T16:00:00+02:00');
    expect(pianoNoemi(new Date('2026-10-26T10:00:00+01:00'), sab).caso).toBe('mattina-stessa');
  });

  it('fissato venerdì per lunedì mattina: il giorno prima (sabato), poi la mattina stessa', () => {
    const ven = new Date('2026-10-23T16:00:00+02:00');
    const p = pianoNoemi(new Date('2026-10-26T10:00:00+01:00'), ven);
    expect(p.caso).toBe('giorno-prima-poi-mattina');
    expect(romeDayKey(p.giornoPrima)).toBe('2026-10-24');
  });

  it('il giorno lavorativo prima di un lunedì è il sabato', () => {
    expect(romeDayKey(giornoLavorativoPrima(new Date('2026-10-26T10:00:00+01:00')))).toBe('2026-10-24');
    expect(romeDayKey(giornoLavorativoPrima(new Date('2026-10-28T10:00:00+01:00')))).toBe('2026-10-27');
  });
});

describe('pianoNoemi: call alle 9 fissata troppo tardi per il giorno prima (PO 24/10/2026)', () => {
  const ven9 = new Date('2026-10-30T09:00:00+01:00');
  const lun9 = new Date('2026-11-02T09:00:00+01:00');

  it('fissata dopo le 19 del giorno prima: alle 9 in punto', () => {
    expect(pianoNoemi(ven9, new Date('2026-10-29T20:30:00+01:00')).caso).toBe('nove-in-punto');
    expect(pianoNoemi(ven9, new Date('2026-10-29T19:00:00+01:00')).caso).toBe('nove-in-punto');
  });

  it('fissata prima delle 19 del giorno prima: il giorno prima', () => {
    expect(pianoNoemi(ven9, new Date('2026-10-29T18:59:00+01:00')).caso).toBe('giorno-prima');
  });

  it('call del lunedì: il giorno prima è il sabato, la domenica non conta', () => {
    expect(pianoNoemi(lun9, new Date('2026-10-31T19:00:00+01:00')).caso).toBe('nove-in-punto');
    expect(pianoNoemi(lun9, new Date('2026-11-01T10:00:00+01:00')).caso).toBe('nove-in-punto');
    expect(pianoNoemi(lun9, new Date('2026-10-30T12:00:00+01:00')).caso).toBe('giorno-prima');
  });
});

describe('fissatoIlDi: l ultimo gesto del GDO sulla call', () => {
  it('prende il più recente fra agenda e data della call', () => {
    expect(fissatoIlDi({ gdo_agenda_at: '2026-10-20T10:00:00Z', gdo_appuntamento_set_at: '2026-10-23T18:00:00Z' })?.toISOString())
      .toBe('2026-10-23T18:00:00.000Z');
    expect(fissatoIlDi({ gdo_agenda_at: '2026-10-23T10:00:00Z', gdo_appuntamento_set_at: '2026-10-20T18:00:00Z' })?.toISOString())
      .toBe('2026-10-23T10:00:00.000Z');
  });
  it('con uno solo valido usa quello; senza nessuno, undefined', () => {
    expect(fissatoIlDi({ gdo_agenda_at: '2026-10-20T10:00:00Z', gdo_appuntamento_set_at: null })?.toISOString()).toBe('2026-10-20T10:00:00.000Z');
    expect(fissatoIlDi({ gdo_agenda_at: 'boh', gdo_appuntamento_set_at: '2026-10-21T10:00:00Z' })?.toISOString()).toBe('2026-10-21T10:00:00.000Z');
    expect(fissatoIlDi({ gdo_agenda_at: null, gdo_appuntamento_set_at: null })).toBeUndefined();
    expect(fissatoIlDi({})).toBeUndefined();
  });
});
