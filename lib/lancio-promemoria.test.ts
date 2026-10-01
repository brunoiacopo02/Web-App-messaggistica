import { describe, it, expect } from 'vitest';
import {
  inFinestraPromemoria, finestraPromemoriaChiusa, runRimastiPromemoria, idoneoAlPromemoria, scegliLottoPromemoria, promemoriaBody,
} from './lancio-promemoria';

const EVENTO = new Date('2026-10-05T21:00:00+02:00');
const alle = (hhmm: string) => new Date(`2026-10-05T${hhmm}:00+02:00`);

describe('finestra del promemoria (10:00-12:00 del giorno della live)', () => {
  it('aperta dalle 10 alle 12, con la tolleranza del cron', () => {
    expect(inFinestraPromemoria(alle('09:55'), EVENTO)).toBe(false);
    expect(inFinestraPromemoria(alle('10:00'), EVENTO)).toBe(true);
    expect(inFinestraPromemoria(alle('12:01'), EVENTO)).toBe(true);
    expect(inFinestraPromemoria(alle('12:05'), EVENTO)).toBe(false);
    expect(finestraPromemoriaChiusa(alle('12:05'), EVENTO)).toBe(true);
    expect(finestraPromemoriaChiusa(alle('11:00'), EVENTO)).toBe(false);
  });
  it('run rimasti: 25 alle 10:00, 1 alle 12:00', () => {
    expect(runRimastiPromemoria(alle('10:00'), EVENTO)).toBe(25);
    expect(runRimastiPromemoria(alle('12:00'), EVENTO)).toBe(1);
    expect(runRimastiPromemoria(alle('15:00'), EVENTO)).toBe(1);
  });
});

describe('chi riceve il promemoria', () => {
  const c = (x: Record<string, unknown> = {}) => ({ lancio_slug: 'webdev', lancio_fase: 'posto_bloccato', lancio_info: null, lancio_promemoria_inviato_at: null, ...x });
  it('solo posto_bloccato, mai congedato, non ancora servito', () => {
    expect(idoneoAlPromemoria(c())).toBe(true);
    expect(idoneoAlPromemoria(c({ lancio_fase: 'attesa' }))).toBe(false);
    expect(idoneoAlPromemoria(c({ lancio_fase: 'link_inviato' }))).toBe(false);
    expect(idoneoAlPromemoria(c({ lancio_info: { congedo_at: '2026-10-03T10:00:00Z' } }))).toBe(false);
    expect(idoneoAlPromemoria(c({ lancio_promemoria_inviato_at: '2026-10-05T08:00:00Z' }))).toBe(false);
    expect(idoneoAlPromemoria(c({ lancio_slug: null }))).toBe(false);
  });
  it('lotto: i rimanenti divisi per i run, dentro al tetto', () => {
    const tanti = Array.from({ length: 2400 }, () => c());
    expect(scegliLottoPromemoria(tanti, alle('10:00'), EVENTO, 300).quota).toBe(96);
    expect(scegliLottoPromemoria(tanti, alle('12:00'), EVENTO, 300).quota).toBe(300);
    expect(scegliLottoPromemoria(tanti.slice(0, 3), alle('10:00'), EVENTO, 300, true).lotto).toHaveLength(3);
  });
  it("il corpo di riserva ha il nome e l'orario", () => {
    expect(promemoriaBody('Mario')).toContain('ciao Mario, stasera alle 21:00');
  });
});
