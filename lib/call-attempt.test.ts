import { describe, it, expect } from 'vitest';
import { parseCallAttempt, tentativoGestito } from './call-attempt';

const AT = '2026-08-28T10:00:00+02:00';
const APPUNTAMENTO = '2026-08-29T15:00:00+02:00';
const base = { leadId: 'u1', esito: 'no_answer', tentativo: 1, at: AT, appointmentAt: APPUNTAMENTO };

describe('parseCallAttempt', () => {
  it('accetta il payload valido', () => {
    const r = parseCallAttempt(base);
    expect(r).toEqual({ ok: true, value: base });
  });

  it('accetta il tentativo 3 (l\'altro tentativo gestito)', () => {
    const r = parseCallAttempt({ ...base, tentativo: 3 });
    expect(r.ok).toBe(true);
  });

  it('accetta anche il tentativo 2: e\' un payload valido, solo non gestito piu\' avanti', () => {
    // Il CRM non ritenta: rispondere 400 qui perderebbe l'informazione senza guadagnare
    // niente. La decisione "non lo gestiamo" spetta a tentativoGestito, non al parser.
    const r = parseCallAttempt({ ...base, tentativo: 2 });
    expect(r).toEqual({ ok: true, value: { ...base, tentativo: 2 } });
  });

  it('rifiuta leadId mancante', () => {
    const r = parseCallAttempt({ ...base, leadId: '' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/lead/i);
  });

  it('rifiuta leadId non stringa', () => {
    const r = parseCallAttempt({ ...base, leadId: 123 });
    expect(r.ok).toBe(false);
  });

  it('rifiuta esito diverso da no_answer', () => {
    const r = parseCallAttempt({ ...base, esito: 'answered' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/esito/i);
  });

  it('rifiuta tentativo non intero', () => {
    const r = parseCallAttempt({ ...base, tentativo: 1.5 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/tentativo/i);
  });

  it('rifiuta tentativo non numerico', () => {
    const r = parseCallAttempt({ ...base, tentativo: '1' });
    expect(r.ok).toBe(false);
  });

  it('rifiuta at senza offset di fuso', () => {
    const r = parseCallAttempt({ ...base, at: '2026-08-28T10:00:00' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/at/i);
  });

  it('rifiuta appointmentAt senza offset di fuso', () => {
    const r = parseCallAttempt({ ...base, appointmentAt: '2026-08-29T15:00:00' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/appointment/i);
  });

  it('rifiuta un corpo che non è un oggetto', () => {
    expect(parseCallAttempt(null).ok).toBe(false);
    expect(parseCallAttempt('stringa').ok).toBe(false);
    expect(parseCallAttempt([]).ok).toBe(false);
    expect(parseCallAttempt(undefined).ok).toBe(false);
  });
});

describe('tentativoGestito', () => {
  it('1 e 3 sono gestiti', () => {
    expect(tentativoGestito(1)).toBe(true);
    expect(tentativoGestito(3)).toBe(true);
  });

  it('2 e qualunque altro valore non sono gestiti', () => {
    expect(tentativoGestito(2)).toBe(false);
    expect(tentativoGestito(0)).toBe(false);
    expect(tentativoGestito(4)).toBe(false);
    expect(tentativoGestito(-1)).toBe(false);
  });
});
