import { describe, it, expect } from 'vitest';
import { ripresaVergine, parseRiprendi, HANDOFF_VERGINI } from './lancio-vergini';
import { decideFollowup } from './lancio-followup';

describe('follow-up ai ridati dal pool', () => {
  const base = { lancio_fase: 'attesa', lancio_followup_inviato_at: null, rows: [], fineNotte: 0 };
  it('chi non ha mai scritto riceve il follow-up se il TL lo ha ridato al bot', () => {
    expect(decideFollowup({ ...base, ancora: null, lancio_info: { pool_vergini: { fase_prima: 'attesa', ripreso_at: 'x' } } }))
      .toEqual({ kind: 'invia', tipo: 'followup' });
  });
  it('senza ripresa resta escluso come prima', () => {
    expect(decideFollowup({ ...base, ancora: '2026-10-01T00:00:00Z', lancio_info: {} }))
      .toEqual({ kind: 'salta', motivo: 'mai_scritto' });
  });
});

const adesso = new Date('2026-10-08T07:00:00Z');

describe('ripresaVergine', () => {
  it('riporta la chat alla fase di prima e la riattiva', () => {
    const u = ripresaVergine({
      id: 1, handed_off_reason: HANDOFF_VERGINI,
      lancio_info: { zoom_minuti: 30, pool_vergini: { fase_prima: 'link_inviato', at: 'x' } },
    }, adesso);
    expect(u).toEqual({
      ai_status: 'active', ai_paused_at: null, handed_off_at: null, handed_off_reason: null,
      lancio_fase: 'link_inviato',
      lancio_info: { zoom_minuti: 30, pool_vergini: { fase_prima: 'link_inviato', at: 'x', ripreso_at: adesso.toISOString() } },
    });
  });

  it('fase di prima mancante o strana → attesa', () => {
    expect(ripresaVergine({ id: 1, handed_off_reason: HANDOFF_VERGINI, lancio_info: null }, adesso)?.lancio_fase).toBe('attesa');
    expect(ripresaVergine({ id: 1, handed_off_reason: HANDOFF_VERGINI, lancio_info: { pool_vergini: { fase_prima: 'chiuso' } } }, adesso)?.lancio_fase).toBe('attesa');
  });

  it('non tocca una chat che non è più nel pool', () => {
    expect(ripresaVergine({ id: 1, handed_off_reason: null, lancio_info: {} }, adesso)).toBeNull();
    expect(ripresaVergine({ id: 1, handed_off_reason: 'gdo_umani_lancio', lancio_info: {} }, adesso)).toBeNull();
  });
});

describe('parseRiprendi', () => {
  it('accetta e deduplica', () => {
    expect(parseRiprendi({ leadIds: ['a', 'b', 'a', '', 3] })).toEqual({ ok: true, leadIds: ['a', 'b'] });
  });
  it('rifiuta corpo vuoto o troppo grande', () => {
    expect(parseRiprendi({}).ok).toBe(false);
    expect(parseRiprendi({ leadIds: [] }).ok).toBe(false);
    expect(parseRiprendi({ leadIds: Array.from({ length: 501 }, (_, i) => `l${i}`) }).ok).toBe(false);
  });
});
