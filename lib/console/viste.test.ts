import { describe, it, expect } from 'vitest';
import { inVista, applicaVista, contestoRiga, isVista, type RigaVista } from './viste';

const now = new Date('2026-10-05T19:00:00Z');
const base: RigaVista = {
  id: 1, ai_owner: 'mario', ai_status: 'active', ai_paused_at: null, bot_outcome: null,
  gdo_agenda_at: null, gdo_video_sent_at: null, campaign_id: null, lancio_slug: null,
  lancio_fase: null, last_inbound_at: '2026-10-05T18:00:00Z', unread_count: 0,
};
const ctx = { now, conErrori: new Set<number>() };

describe('inVista', () => {
  it('serve te: pausa manuale sempre, handed_off solo se recente', () => {
    expect(inVista({ ...base, ai_paused_at: '2026-09-01T00:00:00Z' }, 'serve_te', ctx)).toBe(true);
    expect(inVista({ ...base, ai_status: 'handed_off' }, 'serve_te', ctx)).toBe(true);
    expect(inVista({ ...base, ai_status: 'handed_off', last_inbound_at: '2026-09-20T00:00:00Z' }, 'serve_te', ctx)).toBe(false);
    expect(inVista({ ...base, bot_outcome: 'CONTATTO_UMANO' }, 'serve_te', ctx)).toBe(true);
  });
  it('non lette', () => {
    expect(inVista({ ...base, unread_count: 2 }, 'non_lette', ctx)).toBe(true);
    expect(inVista({ ...base, unread_count: null }, 'non_lette', ctx)).toBe(false);
  });
  it('lancio, fissati, gdo, campagne', () => {
    expect(inVista({ ...base, lancio_slug: 'webdev-2026-10' }, 'lancio', ctx)).toBe(true);
    expect(inVista({ ...base, bot_outcome: 'APPUNTAMENTO' }, 'fissati_bot', ctx)).toBe(true);
    expect(inVista({ ...base, gdo_agenda_at: '2026-10-01T00:00:00Z' }, 'gdo', ctx)).toBe(true);
    expect(inVista({ ...base, ai_owner: null, gdo_video_sent_at: '2026-10-01T00:00:00Z' }, 'gdo', ctx)).toBe(true);
    expect(inVista({ ...base, ai_owner: null, campaign_id: 7 }, 'campagne', ctx)).toBe(true);
    expect(inVista(base, 'campagne', ctx)).toBe(false);
  });
  it('mario in corso esclude esiti, gdo e fasi terminali', () => {
    expect(inVista(base, 'mario', ctx)).toBe(true);
    expect(inVista({ ...base, ai_status: null }, 'mario', ctx)).toBe(true);
    expect(inVista({ ...base, bot_outcome: 'RICHIAMO' }, 'mario', ctx)).toBe(false);
    expect(inVista({ ...base, ai_status: 'booked' }, 'mario', ctx)).toBe(false);
    expect(inVista({ ...base, gdo_agenda_at: 'x' }, 'mario', ctx)).toBe(false);
    expect(inVista({ ...base, lancio_fase: 'restituito' }, 'mario', ctx)).toBe(false);
  });
  it('chiuse', () => {
    expect(inVista({ ...base, ai_status: 'closed' }, 'chiuse', ctx)).toBe(true);
    expect(inVista({ ...base, lancio_fase: 'chiuso' }, 'chiuse', ctx)).toBe(true);
    expect(inVista({ ...base, bot_outcome: 'NON_RISPOSTO' }, 'chiuse', ctx)).toBe(true);
    expect(inVista({ ...base, bot_outcome: 'APPUNTAMENTO' }, 'chiuse', ctx)).toBe(false);
  });
  it('errori usa l\'insieme calcolato', () => {
    expect(inVista(base, 'errori', { now, conErrori: new Set([1]) })).toBe(true);
    expect(inVista(base, 'errori', ctx)).toBe(false);
  });
});

describe('applicaVista', () => {
  // Finto query builder che registra le chiamate.
  function fq() {
    const calls: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const q: any = new Proxy({}, { get: (_t, k: string) => (...a: unknown[]) => { calls.push(`${k}(${a.map((x) => JSON.stringify(x)).join(',')})`); return q; } });
    return { q, calls };
  }
  it('errori vuoto = null (mai in.())', () => {
    const { q } = fq();
    expect(applicaVista(q, 'errori', { now, conErrori: [] })).toBeNull();
  });
  it('errori con id usa in', () => {
    const { q, calls } = fq();
    applicaVista(q, 'errori', { now, conErrori: [3, 4] });
    expect(calls).toContain('in("id",[3,4])');
  });
  it('non lette usa gt', () => {
    const { q, calls } = fq();
    applicaVista(q, 'non_lette', { now, conErrori: [] });
    expect(calls).toContain('gt("unread_count",0)');
  });
});

describe('contestoRiga', () => {
  it('una sola etichetta, priorita\' serve te > errore > fissato > fase', () => {
    expect(contestoRiga({ ...base, ai_status: 'handed_off', bot_outcome: 'APPUNTAMENTO' }, ctx)?.testo).toBe('Serve te');
    expect(contestoRiga(base, { now, conErrori: new Set([1]) })?.tono).toBe('errore');
    expect(contestoRiga({ ...base, bot_outcome: 'APPUNTAMENTO' }, ctx)?.testo).toBe('Fissato dal bot');
    expect(contestoRiga({ ...base, lancio_slug: 's', lancio_fase: 'posto_bloccato' }, ctx)?.testo).toBe('Posto bloccato');
    expect(contestoRiga({ ...base, gdo_agenda_at: 'x' }, ctx)?.testo).toBe('Lead GDO');
  });
  it('isVista', () => { expect(isVista('lancio')).toBe(true); expect(isVista('x')).toBe(false); });
});
