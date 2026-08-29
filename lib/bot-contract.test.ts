import { describe, it, expect } from 'vitest';
import { isoWithOffset, parseIntakePayload, parseSendAgendaPayload, validateOutcomeBody, parseAppointmentSetPayload , parsePreviousLeads,
} from './bot-contract';

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

// Il CRM ci chiama a ogni appuntamento fissato o spostato. Prima del 07/08 l'endpoint
// non esisteva e le loro chiamate morivano in un 404 di Vercel: non abbiamo nemmeno una
// richiesta vera da cui dedurre lo schema, quindi il parser e tollerante sui nomi.
describe('parseAppointmentSetPayload', () => {
  const DATA = '2026-08-07T18:00:00+02:00';

  it('la forma canonica', () => {
    expect(parseAppointmentSetPayload({ leadId: 'u1', appointmentAt: DATA }))
      .toEqual({ ok: true, value: { leadId: 'u1', appointmentAt: DATA } });
  });

  it('accetta gli alias dell\'identificativo del lead', () => {
    for (const k of ['leadId', 'lead_id', 'crmLeadId', 'crm_lead_id']) {
      expect(parseAppointmentSetPayload({ [k]: 'u1', appointmentAt: DATA }))
        .toEqual({ ok: true, value: { leadId: 'u1', appointmentAt: DATA } });
    }
  });

  it('accetta gli alias della data', () => {
    for (const k of ['appointmentAt', 'appuntamentoAt', 'appointment_at', 'appuntamento_at', 'scheduledAt', 'scheduled_at', 'date', 'at']) {
      expect(parseAppointmentSetPayload({ leadId: 'u1', [k]: DATA }))
        .toEqual({ ok: true, value: { leadId: 'u1', appointmentAt: DATA } });
    }
  });

  it('una data senza offset di fuso non si indovina', () => {
    // Due ore di errore in silenzio valgono meno di un 400 che si legge subito.
    expect(parseAppointmentSetPayload({ leadId: 'u1', appointmentAt: '2026-08-07T18:00:00' }))
      .toEqual({ ok: false, reason: 'data_senza_offset' });
    expect(parseAppointmentSetPayload({ leadId: 'u1', appointmentAt: '07/08/2026 18:00' }))
      .toEqual({ ok: false, reason: 'data_senza_offset' });
  });

  it('distingue lead mancante da data mancante: il messaggio d\'errore deve dirglielo', () => {
    expect(parseAppointmentSetPayload({ appointmentAt: DATA })).toEqual({ ok: false, reason: 'lead_mancante' });
    expect(parseAppointmentSetPayload({ leadId: 'u1' })).toEqual({ ok: false, reason: 'data_mancante' });
  });

  it('campi presenti ma vuoti valgono come mancanti', () => {
    expect(parseAppointmentSetPayload({ leadId: '  ', appointmentAt: DATA })).toEqual({ ok: false, reason: 'lead_mancante' });
    expect(parseAppointmentSetPayload({ leadId: 'u1', appointmentAt: '   ' })).toEqual({ ok: false, reason: 'data_mancante' });
  });

  it('corpo non-oggetto', () => {
    expect(parseAppointmentSetPayload(null)).toEqual({ ok: false, reason: 'bad_request' });
    expect(parseAppointmentSetPayload('ciao')).toEqual({ ok: false, reason: 'bad_request' });
    expect(parseAppointmentSetPayload([{ leadId: 'u1' }])).toEqual({ ok: false, reason: 'bad_request' });
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
        personKey: null,
        previousLeadIds: [],
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

describe('personKey e previousLeadIds (contratto 29/08/2026)', () => {
  const base = { leadId: 'nuovo', phone: '+393331234567', companyId: 'fenice' };

  it('legge la chiave della persona e i giri precedenti', () => {
    const r = parseIntakePayload({
      ...base,
      personKey: '3331234567',
      previousLeadIds: [
        { leadId: 'vecchio', status: 'REJECTED', outcome: 'non in target', createdAt: '2026-06-12T10:00:00+02:00' },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.personKey).toBe('3331234567');
    expect(r.value.previousLeadIds).toEqual([
      { leadId: 'vecchio', status: 'REJECTED', outcome: 'non in target', createdAt: '2026-06-12T10:00:00+02:00' },
    ]);
  });

  it("un push senza i campi nuovi resta valido: sono un di piu', mai una condizione", () => {
    const r = parseIntakePayload(base);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.personKey).toBeNull();
    expect(r.value.previousLeadIds).toEqual([]);
  });
});

describe('parsePreviousLeads', () => {
  it('accetta anche la lista di soli id', () => {
    expect(parsePreviousLeads(['a', 'b'])).toEqual([
      { leadId: 'a', status: null, outcome: null, createdAt: null },
      { leadId: 'b', status: null, outcome: null, createdAt: null },
    ]);
  });

  it("lascia cadere le voci senza leadId invece di far fallire l'intake", () => {
    expect(parsePreviousLeads([{ status: 'NEW' }, null, 42, { leadId: '  ' }, { leadId: 'buono' }]))
      .toEqual([{ leadId: 'buono', status: null, outcome: null, createdAt: null }]);
  });

  it("un campo che non e' una lista vale lista vuota", () => {
    expect(parsePreviousLeads('boh')).toEqual([]);
    expect(parsePreviousLeads(undefined)).toEqual([]);
  });
});
