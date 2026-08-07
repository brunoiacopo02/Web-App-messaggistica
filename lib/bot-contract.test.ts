import { describe, it, expect } from 'vitest';
import { isoWithOffset, parseIntakePayload, parseSendAgendaPayload, validateOutcomeBody } from './bot-contract';

describe('isoWithOffset', () => {
  it('accetta offset esplicito', () => {
    expect(isoWithOffset('2026-06-20T15:00:00+02:00')).toBe(true);
    expect(isoWithOffset('2026-06-20T13:00:00Z')).toBe(true);
  });
  it('rifiuta senza fuso', () => {
    expect(isoWithOffset('2026-06-20T15:00:00')).toBe(false);
  });
  it('rifiuta spazzatura', () => {
    expect(isoWithOffset('domani alle 15')).toBe(false);
  });
});

describe('parseIntakePayload', () => {
  const base = { leadId: 'u1', name: 'Mario', phone: '333 123 4567', email: null, funnel: 'badanti', companyId: 'fenice' };
  it('accetta payload valido', () => {
    const r = parseIntakePayload(base);
    expect(r.ok).toBe(true);
  });
  it('rifiuta companyId errato', () => {
    const r = parseIntakePayload({ ...base, companyId: 'altro' });
    expect(r).toEqual({ ok: false, reason: 'forbidden' });
  });
  it('rifiuta leadId mancante', () => {
    const r = parseIntakePayload({ ...base, leadId: '' });
    expect(r).toEqual({ ok: false, reason: 'bad_request' });
  });
  it('rifiuta phone mancante', () => {
    const r = parseIntakePayload({ ...base, phone: '' });
    expect(r).toEqual({ ok: false, reason: 'bad_request' });
  });
});

describe('validateOutcomeBody', () => {
  it('APPUNTAMENTO richiede date con offset', () => {
    expect(validateOutcomeBody({ leadId: 'u1', outcome: 'APPUNTAMENTO' })).toEqual({ ok: false, reason: 'bad_request' });
    expect(validateOutcomeBody({ leadId: 'u1', outcome: 'APPUNTAMENTO', date: '2026-06-20T15:00:00' })).toEqual({ ok: false, reason: 'bad_request' });
    expect(validateOutcomeBody({ leadId: 'u1', outcome: 'APPUNTAMENTO', date: '2026-06-20T15:00:00+02:00' })).toEqual({ ok: true });
  });
  it('DA_SCARTARE non richiede date', () => {
    expect(validateOutcomeBody({ leadId: 'u1', outcome: 'DA_SCARTARE' })).toEqual({ ok: true });
  });
  it('INTERROTTO non richiede date', () => {
    expect(validateOutcomeBody({ leadId: 'u1', outcome: 'INTERROTTO' })).toEqual({ ok: true });
  });
  it('outcome non valido → bad_request', () => {
    expect(validateOutcomeBody({ leadId: 'u1', outcome: 'BOH' as never })).toEqual({ ok: false, reason: 'bad_request' });
  });
});

describe('esito NOTA', () => {
  it('accetta NOTA con una nota e senza data', () => {
    const r = validateOutcomeBody({ leadId: 'x', outcome: 'NOTA', note: 'il lead ha disdetto' });
    expect(r.ok).toBe(true);
  });

  it('rifiuta NOTA senza nota', () => {
    expect(validateOutcomeBody({ leadId: 'x', outcome: 'NOTA' }).ok).toBe(false);
    expect(validateOutcomeBody({ leadId: 'x', outcome: 'NOTA', note: '   ' }).ok).toBe(false);
  });

  it('NOTA non richiede la data', () => {
    const r = validateOutcomeBody({ leadId: 'x', outcome: 'NOTA', note: 'ok' });
    expect(r.ok).toBe(true);
  });
});

describe('esito CONTATTO_UMANO', () => {
  it('è un esito valido con una nota', () => {
    expect(validateOutcomeBody({ leadId: 'u1', outcome: 'CONTATTO_UMANO', note: 'vuole parlare con una persona' }))
      .toEqual({ ok: true });
  });

  it('senza nota non parte: il CRM risponderebbe 400', () => {
    expect(validateOutcomeBody({ leadId: 'u1', outcome: 'CONTATTO_UMANO' }))
      .toEqual({ ok: false, reason: 'note_required' });
    expect(validateOutcomeBody({ leadId: 'u1', outcome: 'CONTATTO_UMANO', note: '   ' }))
      .toEqual({ ok: false, reason: 'note_required' });
  });

  it('NON richiede una data: non è un appuntamento, è una segnalazione', () => {
    // Metterlo in DATE_REQUIRED rimetterebbe il modello nella condizione di inventarne
    // una, che è esattamente il bug chiuso il 06/08 sulle date di RICHIAMO.
    expect(validateOutcomeBody({ leadId: 'u1', outcome: 'CONTATTO_UMANO', note: 'x' }))
      .toEqual({ ok: true });
  });
});

describe('parseSendAgendaPayload', () => {
  const base = {
    leadId: 'gdo-1',
    name: 'Mario Rossi',
    phone: '333 123 4567',
    email: 'mario@esempio.it',
    funnel: 'Nome funnel',
    companyId: 'fenice',
    variant: { lavora: true, haFamiglia: false, offertaDelMese: false },
  };

  it('accetta il payload del CRM e conserva la variante', () => {
    const r = parseSendAgendaPayload(base);
    expect(r).toEqual({
      ok: true,
      value: {
        leadId: 'gdo-1',
        name: 'Mario Rossi',
        phone: '333 123 4567',
        email: 'mario@esempio.it',
        funnel: 'Nome funnel',
        companyId: 'fenice',
        variant: { lavora: true, haFamiglia: false, offertaDelMese: false },
      },
    });
  });

  it('variante assente → tutte le opzioni false (il video di default)', () => {
    const { variant, ...senzaVariant } = base;
    const r = parseSendAgendaPayload(senzaVariant);
    expect(r.ok && r.value.variant).toEqual({ lavora: false, haFamiglia: false, offertaDelMese: false });
  });

  it('flag della variante non booleani → trattati come false, non come errore', () => {
    const r = parseSendAgendaPayload({ ...base, variant: { lavora: 'si', haFamiglia: 1, offertaDelMese: null } });
    expect(r.ok && r.value.variant).toEqual({ lavora: false, haFamiglia: false, offertaDelMese: false });
  });

  it('rifiuta companyId diverso da fenice', () => {
    expect(parseSendAgendaPayload({ ...base, companyId: 'altro' })).toEqual({ ok: false, reason: 'forbidden' });
  });

  it('rifiuta leadId o telefono mancanti', () => {
    expect(parseSendAgendaPayload({ ...base, leadId: '  ' })).toEqual({ ok: false, reason: 'bad_request' });
    expect(parseSendAgendaPayload({ ...base, phone: '' })).toEqual({ ok: false, reason: 'bad_request' });
  });

  it('rifiuta un payload che non è un oggetto', () => {
    expect(parseSendAgendaPayload(null)).toEqual({ ok: false, reason: 'bad_request' });
  });
});
