import { describe, it, expect } from 'vitest';
import { stopDalCrm, vuolePassaggioAUmano } from './stop-crm';

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

  it('di nostra iniziativa non si scrive a nessuno scartato, irreperibile compreso', () => {
    // Il dato del CRM chiude la discussione: sui lead scartati e ri-pushati al bot gli
    // appuntamenti recuperati sono zero su 50.380.
    expect(stopDalCrm({ ...base, discard_reason: 'irreperibile (4 tentativi vuoti)' }))
      .toBe('scartato_da_persona');
    expect(stopDalCrm({ ...base, discard_reason: 'irriperebile (3 tentativi vuoti)' }))
      .toBe('scartato_da_persona');
  });

  it("ma se e' il lead a scriverci, uno scarto non ci fa tacere", () => {
    expect(stopDalCrm({ ...base, discard_reason: 'non interessato' }, 'risposta')).toBeNull();
    expect(stopDalCrm({ ...base, discard_reason: 'irreperibile (4 tentativi vuoti)' }, 'risposta')).toBeNull();
  });

  it("a un cliente non risponde nemmeno se e' lui a scrivere: quella chat vuole una persona", () => {
    expect(stopDalCrm({ ...base, sold: true }, 'risposta')).toBe('gia_cliente');
    expect(stopDalCrm({ ...base, presented: true }, 'risposta')).toBe('gia_presentato');
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

describe('vuolePassaggioAUmano', () => {
  it('cliente e presentato vogliono una persona, lo scarto no', () => {
    expect(vuolePassaggioAUmano('gia_cliente')).toBe(true);
    expect(vuolePassaggioAUmano('gia_presentato')).toBe(true);
    expect(vuolePassaggioAUmano('scartato_da_persona')).toBe(false);
  });
});
