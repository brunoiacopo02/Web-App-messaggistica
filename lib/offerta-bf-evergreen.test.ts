import { describe, expect, it } from 'vitest';
import {
  haVideoConferenza, interruttoreAcceso, notaAppuntamentoConOfferta, offertaBfEvergreenAttiva,
  offertaBfEvergreenContextNote, offertaBfEvergreenVale, PREFISSO_NOTA_OFFERTA_BF, videoConferenzaInVsl,
} from './offerta-bf-evergreen';
import { FINE_BLACK_FRIDAY_DEFAULT_MS, INIZIO_BLACK_FRIDAY_MS, parseScadenza } from './black-friday';

const OGGI = Date.parse('2026-11-10T12:00:00+01:00');
const VSL = 'https://lp.feniceacademy.it/vsl-offerta';
const SCADENZA = parseScadenza('2026-11-30T23:59:59+01:00');

describe('interruttore offerta_bf_evergreen', () => {
  it('acceso solo con on/true/1', () => {
    expect(interruttoreAcceso('on')).toBe(true);
    expect(interruttoreAcceso(' ON ')).toBe(true);
    expect(interruttoreAcceso(true)).toBe(true);
    expect(interruttoreAcceso('off')).toBe(false);
    expect(interruttoreAcceso(null)).toBe(false);
    expect(interruttoreAcceso(undefined)).toBe(false);
  });
  it('dal 9/11 alla scadenza, poi si spegne da solo', () => {
    const base = { interruttore: 'on', scadenzaAtMs: SCADENZA!.atMs };
    expect(offertaBfEvergreenAttiva({ ...base, nowMs: OGGI })).toBe(true);
    expect(offertaBfEvergreenAttiva({ ...base, nowMs: INIZIO_BLACK_FRIDAY_MS - 1 })).toBe(false);
    expect(offertaBfEvergreenAttiva({ ...base, nowMs: SCADENZA!.atMs + 1000 })).toBe(false);
    // Scadenza assente: fine del 30/11.
    expect(offertaBfEvergreenAttiva({ interruttore: 'on', nowMs: FINE_BLACK_FRIDAY_DEFAULT_MS + 1000 })).toBe(false);
  });
  it('spento dall\'interruttore e dall\'emergenza BLACK_FRIDAY_FUNNEL=0; il "1" delle prove non lo tiene acceso dopo la scadenza', () => {
    expect(offertaBfEvergreenAttiva({ interruttore: 'off', nowMs: OGGI })).toBe(false);
    expect(offertaBfEvergreenAttiva({ interruttore: 'on', env: '0', nowMs: OGGI })).toBe(false);
    expect(offertaBfEvergreenAttiva({ interruttore: 'on', env: '1', nowMs: FINE_BLACK_FRIDAY_DEFAULT_MS + 1000 })).toBe(false);
  });
});

describe('a chi vale', () => {
  const base = { attiva: true, vslLink: VSL, altroFlusso: false, esitoInPiedi: null, giaPresentata: false, rows: [] };
  it('lead evergreen senza video: si', () => expect(offertaBfEvergreenVale(base)).toBe(true));
  it('spenta, senza VSL o di un altro flusso: no', () => {
    expect(offertaBfEvergreenVale({ ...base, attiva: false })).toBe(false);
    expect(offertaBfEvergreenVale({ ...base, vslLink: null })).toBe(false);
    expect(offertaBfEvergreenVale({ ...base, altroFlusso: true })).toBe(false);
  });
  it('ha gia\' ricevuto un video conferenza: no (niente secondo video, caso Luciani)', () => {
    const rows = [{ direction: 'out', body: 'Prima della videochiamata guarda questo video 👉 https://corso.feniceacademy.it/conferenza-bx' }];
    expect(haVideoConferenza(rows)).toBe(true);
    expect(offertaBfEvergreenVale({ ...base, rows })).toBe(false);
  });
  it('call fissata prima del 10/11 (senza evento): no; fissata con l\'offerta: si', () => {
    expect(offertaBfEvergreenVale({ ...base, esitoInPiedi: 'APPUNTAMENTO' })).toBe(false);
    expect(offertaBfEvergreenVale({ ...base, esitoInPiedi: 'APPUNTAMENTO', giaPresentata: true })).toBe(true);
  });
});

describe('nota per il lead evergreen', () => {
  const settings = { scadenza: SCADENZA, posti: 30 };
  const t = offertaBfEvergreenContextNote({ vslLink: VSL, settings, nowMs: OGGI, callGiaFissata: false });
  it('riusa i fatti del funnel BF', () => {
    expect(t).toContain("I FATTI DELL'OFFERTA sono SOLO questi");
    expect(t).toContain('dai 1.000 ai 3.000 euro');
    expect(t).toContain('dai 2.000 ai 4.000 euro');
    expect(t).toContain('COLLOCATO O RIMBORSATO');
    expect(t).toContain("corso sull'intelligenza artificiale");
    expect(t).toContain('regalo tech, fisico');
    expect(t).toContain('solo 30');
    expect(t).toContain('lunedì 30 novembre');
    expect(t).toContain('primo trimestre del 2027');
  });
  it('mai "tablet", mai cifre di rata, chiusura presunta', () => {
    expect(t.toLowerCase()).not.toContain('tablet');
    expect(t).toContain('niente "circa 100 euro al mese"');
    expect(t).toContain('Mai "se ti convince"');
  });
  it('VSL al posto dei conferenza-*, senza durata', () => {
    expect(t).toContain(VSL);
    expect(t).toContain('i quattro link conferenza-* per questo lead NON esistono');
    expect(t).toContain('niente "20 minuti"');
  });
  it('flusso e tono del manuale restano', () => expect(t).toContain('non riscrivere il resto'));
  it('scadenza passata: niente data', () => {
    const dopo = offertaBfEvergreenContextNote({ vslLink: VSL, settings, nowMs: SCADENZA!.atMs + 1000, callGiaFissata: false });
    expect(dopo).not.toContain('lunedì 30 novembre');
  });
  it('call gia\' fissata: niente nuova proposta, video solo la VSL', () => {
    const c = offertaBfEvergreenContextNote({ vslLink: VSL, settings, nowMs: OGGI, callGiaFissata: true });
    expect(c).toContain("CALL GIA' FISSATA");
    expect(c).toContain('i quattro link conferenza-* per questo lead NON esistono');
    expect(c).not.toContain('NEL PITCH');
  });
});

describe('nota al CRM', () => {
  it('in testa alla nota dell\'appuntamento, una volta', () => {
    const n = notaAppuntamentoConOfferta('Lavora in fabbrica, vuole cambiare');
    expect(n.startsWith(PREFISSO_NOTA_OFFERTA_BF)).toBe(true);
    expect(n).toContain('Lavora in fabbrica');
    expect(notaAppuntamentoConOfferta(n)).toBe(n);
    expect(notaAppuntamentoConOfferta(undefined)).toBe(PREFISSO_NOTA_OFFERTA_BF);
  });
});

describe('rete di sicurezza sul video', () => {
  it('un conferenza-* del modello diventa la VSL, senza i 20 minuti', () => {
    const r = videoConferenzaInVsl([
      'Perfetto, ci siamo',
      '*Prima della videochiamata guarda questo video*, dura 20 minuti 👉 https://corso.feniceacademy.it/conferenza-ax',
    ], VSL);
    expect(r.sostituiti).toBe(1);
    expect(r.parts[1]).toBe(`*Prima della videochiamata guarda questo video* 👉 ${VSL}`);
    expect(r.parts[0]).toBe('Perfetto, ci siamo');
  });
  it('senza conferenza non tocca niente', () => {
    const r = videoConferenzaInVsl([`guarda 👉 ${VSL}`], VSL);
    expect(r.sostituiti).toBe(0);
    expect(r.parts).toEqual([`guarda 👉 ${VSL}`]);
  });
});
