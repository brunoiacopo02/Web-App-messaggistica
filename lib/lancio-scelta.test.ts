import { describe, it, expect } from 'vitest';
import {
  giorniLancio, modoPostPitch, modoEtichette, puoRispondere, validaAtLancio, parseLancioTag, stripLancioTags,
  oreProponibili, atIso, etichettaGiorno, testoSlots, bloccoSlotPerPrompt,
  testoConfermaChiamata, testoConfermaPrenotazione, testoOraEsaurita, raccogliRisposte, MARKER_PULSANTE_RE,
} from './lancio-scelta';
import type { LancioSlots } from './lancio-crm';

const EVENTO = new Date('2026-10-05T21:00:00+02:00');
const t = (iso: string) => new Date(iso);
const NOTTE = t('2026-10-05T22:40:00+02:00');
const MATTINA6 = t('2026-10-06T09:10:00+02:00');

describe('giorniLancio e modo', () => {
  it('i tre giorni di Roma derivano dall evento', () => {
    expect(giorniLancio(EVENTO)).toEqual({ evento: '2026-10-05', giornoDopo: '2026-10-06', dopodomani: '2026-10-07' });
  });
  // Le etichette dei giorni NON seguono la finestra della notte: seguono il giorno di
  // Roma. Tenerle insieme faceva dire "oggi pomeriggio" alle 20:40 del 5 (parlando del
  // pomeriggio del 6) e "domani mattina" il 7 (parlando di stamattina).
  it('etichette: il 5 e notte a qualunque ora, il 6 e giorno, il 7 e dopodomani', () => {
    expect(modoEtichette(t('2026-10-05T20:40:00+02:00'), EVENTO)).toBe('notte');
    expect(modoEtichette(t('2026-10-05T23:30:00+02:00'), EVENTO)).toBe('notte');
    expect(modoEtichette(t('2026-10-06T02:00:00+02:00'), EVENTO)).toBe('giorno');
    expect(modoEtichette(t('2026-10-06T10:00:00+02:00'), EVENTO)).toBe('giorno');
    expect(modoEtichette(t('2026-10-07T09:30:00+02:00'), EVENTO)).toBe('dopodomani');
  });
  it('alle 02:00 del 6 la chiamata immediata e ancora possibile ma il giorno e gia oggi', () => {
    expect(modoPostPitch(t('2026-10-06T02:00:00+02:00'), EVENTO)).toBe('notte');
    expect(modoEtichette(t('2026-10-06T02:00:00+02:00'), EVENTO)).toBe('giorno');
  });
  it('notte dalle 21:00 del 5 alle 02:59 del 6, giorno dopo', () => {
    expect(modoPostPitch(t('2026-10-05T21:00:00+02:00'), EVENTO)).toBe('notte');
    expect(modoPostPitch(t('2026-10-06T02:59:00+02:00'), EVENTO)).toBe('notte');
    expect(modoPostPitch(t('2026-10-06T03:00:00+02:00'), EVENTO)).toBe('giorno');
    expect(modoPostPitch(t('2026-10-05T20:00:00+02:00'), EVENTO)).toBe('giorno');
  });
});

describe('puoRispondere', () => {
  it('post_pitch: sempre di notte, poi solo 08:30-23:00', () => {
    expect(puoRispondere(t('2026-10-06T01:30:00+02:00'), EVENTO, 'post_pitch')).toBe(true);
    expect(puoRispondere(t('2026-10-06T04:00:00+02:00'), EVENTO, 'post_pitch')).toBe(false);
    expect(puoRispondere(t('2026-10-06T08:29:00+02:00'), EVENTO, 'post_pitch')).toBe(false);
    expect(puoRispondere(t('2026-10-06T08:30:00+02:00'), EVENTO, 'post_pitch')).toBe(true);
    expect(puoRispondere(t('2026-10-06T23:00:00+02:00'), EVENTO, 'post_pitch')).toBe(false);
  });
  it('link_inviato: dal blast alle 23:59 del giorno dell evento, poi mai (il 6 risponde il follow-up del B5)', () => {
    expect(puoRispondere(t('2026-10-05T19:20:00+02:00'), EVENTO, 'link_inviato')).toBe(false);
    expect(puoRispondere(t('2026-10-05T19:35:00+02:00'), EVENTO, 'link_inviato')).toBe(true);
    expect(puoRispondere(t('2026-10-05T23:50:00+02:00'), EVENTO, 'link_inviato')).toBe(true);
    expect(puoRispondere(t('2026-10-06T00:10:00+02:00'), EVENTO, 'link_inviato')).toBe(false);
    expect(puoRispondere(t('2026-10-06T10:00:00+02:00'), EVENTO, 'link_inviato')).toBe(false);
  });
});

describe('validaAtLancio: le regole dure', () => {
  it('mattina del 6 a ore piene: ok, kind mattina', () => {
    expect(validaAtLancio('2026-10-06T09:00:00+02:00', NOTTE, EVENTO)).toEqual({ ok: true, kind: 'mattina', date: '2026-10-06', hour: 9 });
    expect(validaAtLancio('2026-10-06T14:00:00+02:00', NOTTE, EVENTO)).toMatchObject({ ok: true, kind: 'mattina' });
  });
  it('15-20 del 6: pomeriggio; 9-14 del 7: dopodomani', () => {
    expect(validaAtLancio('2026-10-06T15:00:00+02:00', NOTTE, EVENTO)).toMatchObject({ ok: true, kind: 'pomeriggio' });
    expect(validaAtLancio('2026-10-06T20:00:00+02:00', NOTTE, EVENTO)).toMatchObject({ ok: true, kind: 'pomeriggio' });
    expect(validaAtLancio('2026-10-07T14:00:00+02:00', NOTTE, EVENTO)).toMatchObject({ ok: true, kind: 'dopodomani' });
  });
  it('senza offset: formato; l ora UTC equivalente conta come Roma', () => {
    expect(validaAtLancio('2026-10-06T09:00:00', NOTTE, EVENTO)).toEqual({ ok: false, motivo: 'formato' });
    expect(validaAtLancio('2026-10-06T07:00:00Z', NOTTE, EVENTO)).toMatchObject({ ok: true, hour: 9 });
  });
  it('giorno non ammesso: il 5, l 8', () => {
    expect(validaAtLancio('2026-10-05T23:00:00+02:00', NOTTE, EVENTO)).toEqual({ ok: false, motivo: 'giorno_non_ammesso' });
    expect(validaAtLancio('2026-10-08T10:00:00+02:00', NOTTE, EVENTO)).toEqual({ ok: false, motivo: 'giorno_non_ammesso' });
  });
  it('ora non tonda', () => {
    expect(validaAtLancio('2026-10-06T09:30:00+02:00', NOTTE, EVENTO)).toEqual({ ok: false, motivo: 'ora_non_tonda' });
  });
  it('fuori fascia: 8 e 21 del 6, 15 del 7', () => {
    expect(validaAtLancio('2026-10-06T08:00:00+02:00', NOTTE, EVENTO)).toEqual({ ok: false, motivo: 'fuori_fascia' });
    expect(validaAtLancio('2026-10-06T21:00:00+02:00', NOTTE, EVENTO)).toEqual({ ok: false, motivo: 'fuori_fascia' });
    expect(validaAtLancio('2026-10-07T15:00:00+02:00', NOTTE, EVENTO)).toEqual({ ok: false, motivo: 'fuori_fascia' });
  });
  it('troppo vicino: alle 09:10 del 6 le 9 e le 10 sono andate, le 11 no', () => {
    expect(validaAtLancio('2026-10-06T09:00:00+02:00', MATTINA6, EVENTO)).toEqual({ ok: false, motivo: 'troppo_vicino' });
    expect(validaAtLancio('2026-10-06T10:00:00+02:00', MATTINA6, EVENTO)).toEqual({ ok: false, motivo: 'troppo_vicino' });
    expect(validaAtLancio('2026-10-06T11:00:00+02:00', MATTINA6, EVENTO)).toMatchObject({ ok: true, kind: 'mattina' });
  });
});

describe('tag', () => {
  it('riconosce i quattro tag e toglie tutto dal testo', () => {
    expect(parseLancioTag('Perfetto! [LANCIO:CHIAMA_ORA]')).toEqual({ tag: 'CHIAMA_ORA' });
    expect(parseLancioTag('[LANCIO:PRENOTA|2026-10-06T09:00:00+02:00] ok')).toEqual({ tag: 'PRENOTA', at: '2026-10-06T09:00:00+02:00' });
    expect(parseLancioTag('Vediamo le ore [LANCIO:SLOTS]')).toEqual({ tag: 'SLOTS' });
    expect(parseLancioTag('[lancio:no]')).toEqual({ tag: 'NO' });
    expect(parseLancioTag('nessun tag')).toBeNull();
    expect(stripLancioTags('Ciao [LANCIO:SLOTS] a te [LANCIO:PRENOTA|x]')).toBe('Ciao  a te');
  });
  it('PRENOTA senza argomento non e un tag valido', () => {
    expect(parseLancioTag('[LANCIO:PRENOTA|]')).toBeNull();
  });
});

const SLOTS: LancioSlots = { date: '2026-10-06', mattina: [{ hour: 9, liberi: 1 }, { hour: 11, liberi: 2 }, { hour: 13, liberi: 0 }, { hour: 14, liberi: 1 }], pomeriggio: { aperto: true, ore: [15, 16, 17, 18, 19, 20] }, mattinaEsaurita: false };
const GIORNI = giorniLancio(EVENTO);

describe('oreProponibili', () => {
  it('di notte: mattina dagli slot con liberi>0, pomeriggio intero, dopodomani 9-14', () => {
    expect(oreProponibili(SLOTS, NOTTE, EVENTO)).toEqual({ mattina: [9, 11, 14], pomeriggio: [15, 16, 17, 18, 19, 20], dopodomani: [9, 10, 11, 12, 13, 14], mattinaEsaurita: false });
  });
  it('senza slot (CRM giu): niente mattina, pomeriggio e dopodomani restano', () => {
    expect(oreProponibili(null, NOTTE, EVENTO)).toMatchObject({ mattina: [], pomeriggio: [15, 16, 17, 18, 19, 20], mattinaEsaurita: true });
  });
  it('alle 09:10 del 6 la regola +1h taglia 9 e 10', () => {
    expect(oreProponibili(SLOTS, MATTINA6, EVENTO).mattina).toEqual([11, 14]);
  });
  it('alle 19:30 del 6 resta solo il 7', () => {
    const ore = oreProponibili(SLOTS, t('2026-10-06T19:30:00+02:00'), EVENTO);
    expect(ore.pomeriggio).toEqual([]);
    expect(ore.dopodomani).toEqual([9, 10, 11, 12, 13, 14]);
  });
});

describe('testi', () => {
  it('atIso ed etichetta', () => {
    expect(atIso('2026-10-06', 9)).toBe('2026-10-06T09:00:00+02:00');
    expect(etichettaGiorno('2026-10-07')).toBe('mercoledì 7 ottobre');
  });
  it('slot di notte: mattina elencata, pomeriggio a fascia', () => {
    const s = testoSlots(oreProponibili(SLOTS, NOTTE, EVENTO), GIORNI, 'notte');
    expect(s).toBe('Per la call ho libero domattina alle 9, alle 11 o alle 14, oppure domani pomeriggio dalle 15 alle 20: che ora preferisci?');
  });
  it('mattina piena: si propone il pomeriggio e il 7 solo per chi puo solo la mattina', () => {
    const s = testoSlots(oreProponibili({ ...SLOTS, mattina: [], mattinaEsaurita: true }, NOTTE, EVENTO), GIORNI, 'notte');
    expect(s).toContain('Domattina è tutto pieno');
    expect(s).toContain('domani pomeriggio dalle 15 alle 20');
    expect(s).toContain('mercoledì 7 ottobre dalle 9 alle 14');
  });
  it('di giorno non si nomina la mattina di oggi anche se ha ore', () => {
    const s = testoSlots(oreProponibili(SLOTS, MATTINA6, EVENTO), GIORNI, 'giorno');
    expect(s).not.toMatch(/alle 11/);
    expect(s).toContain('oggi pomeriggio dalle 15 alle 20');
    expect(s).toContain('domani mattina');
  });
  // Il pulsante premuto alle 20:40 del 5 (il link e' gia' partito, la live non e' ancora
  // cominciata): il 6 e' domani, non oggi.
  it('alle 20:40 del 5 il giorno dopo si chiama domani, non oggi', () => {
    const ora = t('2026-10-05T20:40:00+02:00');
    const s = testoSlots(oreProponibili(SLOTS, ora, EVENTO), GIORNI, modoEtichette(ora, EVENTO));
    expect(s).toBe('Per la call ho libero domattina alle 9, alle 11 o alle 14, oppure domani pomeriggio dalle 15 alle 20: che ora preferisci?');
  });
  // Alle 02:00 il giorno di Roma e' gia' il 6: le ore della mattina restano prenotabili
  // (il blocco del prompt le tiene) ma non si propongono da sole, come in tutto il 6.
  it('alle 02:00 del 6 si dice oggi, non domani', () => {
    const ora = t('2026-10-06T02:00:00+02:00');
    const s = testoSlots(oreProponibili(SLOTS, ora, EVENTO), GIORNI, modoEtichette(ora, EVENTO));
    expect(s).toContain('oggi pomeriggio dalle 15 alle 20');
    expect(s).not.toContain('domattina');
    expect(s).toContain('domani mattina dalle 9 alle 14');
  });
  // Il 7 il 6 non esiste piu': le sue ore sono tutte passate e non si nomina.
  it('alle 09:30 del 7 la mattina di oggi e stamattina, e del 6 non si parla', () => {
    const ora = t('2026-10-07T09:30:00+02:00');
    const ore = oreProponibili(SLOTS, ora, EVENTO);
    expect(ore.mattina).toEqual([]);
    expect(ore.pomeriggio).toEqual([]);
    const s = testoSlots(ore, GIORNI, modoEtichette(ora, EVENTO));
    expect(s).toBe('Per la call ho stamattina dalle 11 alle 14: che ora preferisci?');
    expect(s).not.toMatch(/domani|ieri|non ho piu/);
    const b = bloccoSlotPerPrompt(ore, GIORNI, modoEtichette(ora, EVENTO));
    expect(b).toContain('2026-10-07T11:00:00+02:00 → mercoledì 7 ottobre alle 11:00 (stamattina)');
    expect(b).not.toContain('2026-10-06T');
  });
  it('il blocco per il prompt elenca stringhe ISO da copiare', () => {
    const b = bloccoSlotPerPrompt(oreProponibili(SLOTS, NOTTE, EVENTO), GIORNI, 'notte');
    expect(b).toContain('2026-10-06T09:00:00+02:00');
    expect(b).toContain('2026-10-06T20:00:00+02:00');
    expect(b).toContain('2026-10-07T14:00:00+02:00');
    expect(b).not.toContain('2026-10-06T13:00:00+02:00');
    expect(b).not.toContain('2026-10-06T21:00:00+02:00');
  });
  it('conferme fisse', () => {
    expect(testoConfermaChiamata('Luca')).toBe('Perfetto, ti chiama Luca tra pochissimo.');
    expect(testoConfermaPrenotazione('mattina', '2026-10-06T09:00:00+02:00', 'Luca')).toBe('Perfetto, ci sentiamo martedì 6 ottobre alle 9:00: ti chiama Luca. Tieni il telefono a portata di mano.');
    expect(testoConfermaPrenotazione('pomeriggio', '2026-10-06T17:00:00+02:00')).toBe('Perfetto, ci sentiamo martedì 6 ottobre alle 17:00: ti chiama un nostro consulente. Tieni il telefono a portata di mano.');
    expect(testoOraEsaurita(9, oreProponibili(SLOTS, NOTTE, EVENTO), GIORNI, 'notte')).toMatch(/^Le 9 si sono appena riempite\. Per la call ho libero/);
  });
});

describe('raccogliRisposte', () => {
  it('accumula le parole del lead, salta il marker del pulsante, taglia a 6 e a 300 caratteri', () => {
    const uno = raccogliRisposte(null, ['Ho seguito la live Web Developer AI e voglio saperne di più 🚀', 'faccio il barista']);
    expect(uno.risposte).toEqual(['faccio il barista']);
    const lunga = 'x'.repeat(400);
    const due = raccogliRisposte(uno, ['a', 'b', 'c', 'd', 'e', lunga, '  ']);
    expect(due.risposte).toHaveLength(6);
    expect(due.risposte[5]).toHaveLength(300);
    expect(MARKER_PULSANTE_RE.test('ho seguito la LIVE web developer AI')).toBe(true);
  });
  it('conserva slotsMostratiAt', () => {
    expect(raccogliRisposte({ risposte: [], slotsMostratiAt: 'x' }, ['ciao']).slotsMostratiAt).toBe('x');
  });
});
