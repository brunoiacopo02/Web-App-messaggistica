import { describe, it, expect } from 'vitest';
import { parseLeadStatusPage, toRow, mergeLatched, prossimoCursore } from './crm-lead-status';

const LEAD = {
  leadId: 'abc',
  status: 'APPOINTMENT',
  appointmentDate: '2026-08-28T17:00:00.000Z',
  appointmentCreatedAt: '2026-08-26T09:12:00.000Z',
  confermeOutcome: 'confermato',
  confermeOutcomeAt: '2026-08-27T10:03:00.000Z',
  confermeDiscardReason: null,
  presented: true,
  presentedAt: '2026-08-28T17:00:00.000Z',
  salesOutcome: 'Chiuso',
  salesOutcomeAt: '2026-08-28T18:20:00.000Z',
  sold: true,
  soldProduct: 'gold',
  soldAmountEur: 3500,
  discardReason: null,
  agendaStatus: 'consegnato',
  updatedAt: '2026-08-28T18:20:00.000Z',
};

describe('parseLeadStatusPage', () => {
  it('legge una pagina intera', () => {
    const r = parseLeadStatusPage({ leads: [LEAD], nextSince: '2026-08-28T18:20:00.000Z', hasMore: false });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.page.leads).toHaveLength(1);
    expect(r.page.leads[0].leadId).toBe('abc');
    expect(r.page.hasMore).toBe(false);
    expect(r.page.scartate).toBe(0);
  });

  it('rifiuta un body che non e\' una pagina', () => {
    expect(parseLeadStatusPage(null).ok).toBe(false);
    expect(parseLeadStatusPage({ leads: 'no' }).ok).toBe(false);
  });

  it('una riga senza leadId non fa cadere le altre', () => {
    const r = parseLeadStatusPage({ leads: [{ ...LEAD, leadId: '' }, LEAD], hasMore: false });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.page.leads).toHaveLength(1);
    expect(r.page.scartate).toBe(1);
  });

  it('una riga senza updatedAt viene scartata: senza non si avanza il cursore', () => {
    const { updatedAt, ...senzaData } = LEAD;
    const r = parseLeadStatusPage({ leads: [senzaData], hasMore: false });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.page.leads).toHaveLength(0);
    expect(r.page.scartate).toBe(1);
  });

  it('ricava nextSince dall\'ultima riga quando il CRM non lo manda', () => {
    const r = parseLeadStatusPage({
      leads: [{ ...LEAD, updatedAt: '2026-08-27T10:00:00.000Z' }, LEAD],
      hasMore: true,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.page.nextSince).toBe('2026-08-28T18:20:00.000Z');
  });
});

describe('toRow: il ritorno sui contatti umani', () => {
  const conRitorno = {
    leadId: 'abc',
    updatedAt: '2026-08-29T11:03:00.000Z',
    contattoUmano: {
      stato: 'closed',
      presoInCaricoDa: 'Giulia',
      presoInCaricoIl: '2026-08-29T10:12:00.000Z',
      esito: 'chiamato_ok',
      esitoIl: '2026-08-29T11:03:00.000Z',
      nota: 'richiamata, conferma la call',
      richiestaIl: '2026-08-28T18:40:00.000Z',
    },
  };

  it('porta il blocco sulle colonne', () => {
    expect(toRow(conRitorno as never, 7)).toMatchObject({
      contatto_umano_stato: 'closed',
      contatto_umano_preso_da: 'Giulia',
      contatto_umano_preso_il: '2026-08-29T10:12:00.000Z',
      contatto_umano_esito: 'chiamato_ok',
      contatto_umano_esito_il: '2026-08-29T11:03:00.000Z',
      contatto_umano_nota: 'richiamata, conferma la call',
      contatto_umano_richiesta_il: '2026-08-28T18:40:00.000Z',
    });
  });

  it("una richiesta ancora pending non ha esito, e va bene: dice che l'hanno ricevuta", () => {
    const row = toRow({ leadId: 'abc', updatedAt: '2026-08-29T11:03:00.000Z',
      contattoUmano: { stato: 'pending', richiestaIl: '2026-08-28T18:40:00.000Z' } } as never, 7);
    expect(row.contatto_umano_stato).toBe('pending');
    expect(row.contatto_umano_esito).toBeNull();
    expect(row.contatto_umano_preso_da).toBeNull();
  });

  it('un lead che non ha mai chiesto una persona non ha il blocco: tutto null, nessun errore', () => {
    const row = toRow({ leadId: 'abc', updatedAt: '2026-08-29T11:03:00.000Z' } as never, 7);
    expect(row.contatto_umano_stato).toBeNull();
    expect(row.contatto_umano_richiesta_il).toBeNull();
  });
});

describe('toRow', () => {
  it('mappa il payload sulle colonne', () => {
    const row = toRow(parseLeadStatusPage({ leads: [LEAD], hasMore: false }).ok
      ? (parseLeadStatusPage({ leads: [LEAD], hasMore: false }) as any).page.leads[0]
      : (null as never), 42);
    expect(row).toMatchObject({
      lead_id: 'abc',
      conversation_id: 42,
      status: 'APPOINTMENT',
      conferme_outcome: 'confermato',
      presented: true,
      sales_outcome: 'Chiuso',
      sold: true,
      sold_product: 'gold',
      sold_amount_eur: 3500,
      agenda_status: 'consegnato',
      crm_updated_at: '2026-08-28T18:20:00.000Z',
    });
  });

  it('un importo che arriva come stringa diventa un numero', () => {
    const p = parseLeadStatusPage({ leads: [{ ...LEAD, soldAmountEur: '3500' }], hasMore: false });
    if (!p.ok) throw new Error('pagina non valida');
    expect(toRow(p.page.leads[0], null).sold_amount_eur).toBe(3500);
  });

  it('un importo non numerico diventa null invece di NaN', () => {
    const p = parseLeadStatusPage({ leads: [{ ...LEAD, soldAmountEur: 'boh' }], hasMore: false });
    if (!p.ok) throw new Error('pagina non valida');
    expect(toRow(p.page.leads[0], null).sold_amount_eur).toBeNull();
  });

  it('senza conversazione agganciata la colonna resta null', () => {
    const p = parseLeadStatusPage({ leads: [LEAD], hasMore: false });
    if (!p.ok) throw new Error('pagina non valida');
    expect(toRow(p.page.leads[0], null).conversation_id).toBeNull();
  });
});

describe('mergeLatched', () => {
  const base = { lead_id: 'abc', presented: false, presented_at: null, sold: false } as any;

  it('una presenza gia\' registrata non torna indietro', () => {
    const esistente = { presented: true, presented_at: '2026-08-28T17:00:00.000Z', sold: false };
    const row = mergeLatched(esistente, { ...base, presented: false, presented_at: null });
    expect(row.presented).toBe(true);
    expect(row.presented_at).toBe('2026-08-28T17:00:00.000Z');
  });

  it('una vendita gia\' registrata non torna indietro', () => {
    const row = mergeLatched({ presented: false, presented_at: null, sold: true }, { ...base, sold: false });
    expect(row.sold).toBe(true);
  });

  it('la presenza puo\' passare da falsa a vera', () => {
    const row = mergeLatched({ presented: false, presented_at: null, sold: false }, {
      ...base, presented: true, presented_at: '2026-08-28T17:00:00.000Z',
    });
    expect(row.presented).toBe(true);
  });

  it('senza riga precedente vale quello che arriva', () => {
    const row = mergeLatched(null, { ...base, presented: true });
    expect(row.presented).toBe(true);
  });
});

describe('prossimoCursore', () => {
  const pagina = (nextSince: string | null, hasMore: boolean, n = 1) => ({
    leads: Array.from({ length: n }, () => ({ leadId: 'x', updatedAt: nextSince ?? '' })) as any,
    nextSince,
    hasMore,
    scartate: 0,
  });

  it('avanza al nextSince della pagina', () => {
    const r = prossimoCursore('2026-08-01T00:00:00.000Z', pagina('2026-08-28T18:20:00.000Z', true));
    expect(r.since).toBe('2026-08-28T18:20:00.000Z');
    expect(r.continua).toBe(true);
  });

  it('si ferma quando hasMore e\' falso', () => {
    const r = prossimoCursore('2026-08-01T00:00:00.000Z', pagina('2026-08-28T18:20:00.000Z', false));
    expect(r.continua).toBe(false);
  });

  it('un cursore che non avanza ferma il giro invece di ciclare all\'infinito', () => {
    const stesso = '2026-08-28T18:20:00.000Z';
    const r = prossimoCursore(stesso, pagina(stesso, true));
    expect(r.continua).toBe(false);
    expect(r.bloccato).toBe(true);
  });

  it('non torna mai indietro rispetto al cursore corrente', () => {
    const r = prossimoCursore('2026-08-28T18:20:00.000Z', pagina('2026-08-01T00:00:00.000Z', true));
    expect(r.since).toBe('2026-08-28T18:20:00.000Z');
    expect(r.continua).toBe(false);
    expect(r.bloccato).toBe(true);
  });

  it('una pagina vuota non muove il cursore e chiude il giro', () => {
    const r = prossimoCursore('2026-08-01T00:00:00.000Z', pagina(null, true, 0));
    expect(r.since).toBe('2026-08-01T00:00:00.000Z');
    expect(r.continua).toBe(false);
  });
});
