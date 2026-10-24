import { describe, expect, it } from 'vitest';
import { pianoNoemi, giornoLavorativoPrima } from './noemi-quando';
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
