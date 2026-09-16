import { describe, it, expect } from 'vitest';
import { adessoLancio } from './lancio-orologio';

const FAKE = '2026-10-05T22:40:00+02:00';
const vicinoAdOra = (d: Date) => Math.abs(d.getTime() - Date.now()) < 5_000;

describe('adessoLancio — l orologio del turno', () => {
  it('senza LANCIO_FAKE_NOW è l ora vera', () => {
    expect(vicinoAdOra(adessoLancio({}))).toBe(true);
  });

  it('fuori produzione la finta vale', () => {
    expect(adessoLancio({ NODE_ENV: 'test', LANCIO_FAKE_NOW: FAKE }).toISOString()).toBe('2026-10-05T20:40:00.000Z');
  });

  it('in produzione la finta vale SOLO se armata col segreto del cron', () => {
    expect(vicinoAdOra(adessoLancio({ NODE_ENV: 'production', LANCIO_FAKE_NOW: FAKE }))).toBe(true);
    expect(vicinoAdOra(adessoLancio({ NODE_ENV: 'production', LANCIO_FAKE_NOW: FAKE, CRON_SECRET: 's', LANCIO_FAKE_NOW_ARMED: 'altro' }))).toBe(true);
    expect(adessoLancio({ NODE_ENV: 'production', LANCIO_FAKE_NOW: FAKE, CRON_SECRET: 's', LANCIO_FAKE_NOW_ARMED: 's' }).toISOString()).toBe('2026-10-05T20:40:00.000Z');
  });

  it('senza CRON_SECRET non c è niente con cui armarla', () => {
    expect(vicinoAdOra(adessoLancio({ NODE_ENV: 'production', LANCIO_FAKE_NOW: FAKE, LANCIO_FAKE_NOW_ARMED: '' }))).toBe(true);
  });

  it('una finta illeggibile non ferma niente: ora vera', () => {
    expect(vicinoAdOra(adessoLancio({ NODE_ENV: 'test', LANCIO_FAKE_NOW: 'ieri sera' }))).toBe(true);
  });

  it('spazi intorno alla finta non la invalidano; una finta vuota è come assente', () => {
    expect(adessoLancio({ NODE_ENV: 'test', LANCIO_FAKE_NOW: `  ${FAKE}  ` }).toISOString()).toBe('2026-10-05T20:40:00.000Z');
    expect(vicinoAdOra(adessoLancio({ NODE_ENV: 'test', LANCIO_FAKE_NOW: '   ' }))).toBe(true);
  });
});
