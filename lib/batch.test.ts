import { describe, it, expect } from 'vitest';
import { planBatch } from './batch';
import type { AcApiContact } from './ac-api';

function c(id: string, phone: string | null): AcApiContact {
  return { id, phone, email: null, firstName: null, lastName: null };
}

describe('planBatch', () => {
  it('normalizza i telefoni italiani e marca quelli da inviare', () => {
    const plan = planBatch([c('1', '3480300004'), c('2', '338 224 4214')], new Set());
    expect(plan.toSend.map((p) => p.phone)).toEqual(['+393480300004', '+393382244214']);
    expect(plan.invalidPhone).toHaveLength(0);
  });

  it('scarta i telefoni mancanti o non validi', () => {
    const plan = planBatch([c('1', null), c('2', ''), c('3', 'abc')], new Set());
    expect(plan.toSend).toHaveLength(0);
    expect(plan.invalidPhone).toHaveLength(3);
  });

  it('salta i contatti già inviati (idempotenza)', () => {
    const plan = planBatch([c('1', '3480300004')], new Set(['+393480300004']));
    expect(plan.toSend).toHaveLength(0);
    expect(plan.alreadySent).toHaveLength(1);
    expect(plan.alreadySent[0].phone).toBe('+393480300004');
  });

  it('invia una sola volta in caso di telefono duplicato nella lista', () => {
    const plan = planBatch([c('1', '3480300004'), c('2', '348 030 0004')], new Set());
    expect(plan.toSend).toHaveLength(1);
    expect(plan.duplicates).toHaveLength(1);
  });
});
