import { describe, it, expect } from 'vitest';
import { stopDalCrm } from './stop-crm';

const base = { presented: false, sold: false, discard_reason: null };

describe('stopDalCrm', () => {
  it("chi ha comprato non riceve piu' niente", () => {
    expect(stopDalCrm({ ...base, presented: true, sold: true })).toBe('gia_cliente');
  });

  it('chi si e\' presentato alla call non riceve piu\' niente', () => {
    expect(stopDalCrm({ ...base, presented: true })).toBe('gia_presentato');
  });

  it('uno scarto deciso da una persona ferma il bot', () => {
    expect(stopDalCrm({ ...base, discard_reason: 'non in target' })).toBe('scartato_da_persona');
  });

  it('una causale di scarto fatta di soli spazi non e\' una causale', () => {
    expect(stopDalCrm({ ...base, discard_reason: '   ' })).toBeNull();
  });

  it('un lead vivo non ferma niente', () => {
    expect(stopDalCrm(base)).toBeNull();
  });

  it('senza nessuno stato dal CRM si scrive: il bot non tace per un dato mai arrivato', () => {
    expect(stopDalCrm(null)).toBeNull();
    expect(stopDalCrm(undefined)).toBeNull();
  });

  it('lo scarto delle Conferme NON ferma: e\' il caso del recupero NR', () => {
    // "3 NR consecutivi" arriva come conferme_outcome, non come discard_reason, ed e'
    // esattamente il lead a cui vogliamo scrivere. Se un giorno finisse qui dentro,
    // spegnerebbe in silenzio il recupero che vale il 42% degli appuntamenti.
    expect(stopDalCrm({ presented: false, sold: false, discard_reason: null })).toBeNull();
  });
});

describe('irreperibile non e\' un no', () => {
  const base = { presented: false, sold: false, discard_reason: null };

  it('non ferma su "irreperibile (4 tentativi vuoti)"', () => {
    // E' un telefono che non risponde, cioe' la stessa cosa dei "3 NR" scritta in un
    // altro campo. E' il lead per cui la chat WhatsApp vale di piu', non di meno.
    expect(stopDalCrm({ ...base, discard_reason: 'irreperibile (4 tentativi vuoti)' })).toBeNull();
  });

  it('non ferma nemmeno sulla grafia loro, "irriperebile (3 tentativi vuoti)"', () => {
    expect(stopDalCrm({ ...base, discard_reason: 'irriperebile (3 tentativi vuoti)' })).toBeNull();
  });

  it('ferma su un giudizio vero: non interessato', () => {
    expect(stopDalCrm({ ...base, discard_reason: 'non interessato' })).toBe('scartato_da_persona');
  });

  it('ferma su numero inesistente', () => {
    expect(stopDalCrm({ ...base, discard_reason: 'numero inesistente' })).toBe('scartato_da_persona');
  });

  it('un cliente resta fermo comunque, qualunque sia la causale', () => {
    expect(stopDalCrm({ presented: true, sold: true, discard_reason: 'irreperibile (4 tentativi vuoti)' }))
      .toBe('gia_cliente');
  });
});
