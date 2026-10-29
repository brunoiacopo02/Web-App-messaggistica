import { describe, it, expect } from 'vitest';
import { decidi, piuGiorni, giornoRoma, normalizzaQualita, type StatoQualita, type Qualita } from './qualita-numeri';

const P = '+393520413199';
const A = '+393520158061';
const B = '+393522018718';
const C = '+393522070047';
const SEC = [`whatsapp:${C}`, `whatsapp:${B}`, `whatsapp:${A}`];
const vuoto = (): StatoQualita => ({ storico: {}, pause: {} });
const tuttiAperti = () => ({ [`whatsapp:${A}`]: 100000, [`whatsapp:${B}`]: 100000, [`whatsapp:${C}`]: 100000 });
const leggi = (o: Partial<Record<string, Qualita>>): Record<string, Qualita> =>
  ({ [P]: 'LOW', [A]: 'HIGH', [B]: 'HIGH', [C]: 'HIGH', ...o } as Record<string, Qualita>);
const run = (oggi: string, letture: Record<string, Qualita>, stato = vuoto(), tetti: Record<string, number> = tuttiAperti()) =>
  decidi({ oggi, letture, stato, tetti, primario: `whatsapp:${P}`, secondari: SEC });

describe('decidi (PO 29/10/2026)', () => {
  it('tutti HIGH e 3199 LOW: nessuna azione, tetti invariati', () => {
    const r = run('2026-10-30', leggi({}));
    expect(r.azioni).toEqual([]);
    expect(r.tetti).toEqual(tuttiAperti());
  });

  it('un secondario MEDIUM: pausa di 3 giorni col tetto di prima salvato', () => {
    const r = run('2026-10-30', leggi({ [C]: 'MEDIUM' }));
    expect(r.tetti[`whatsapp:${C}`]).toBe(0);
    expect(r.stato.pause[C]).toEqual({ fino: '2026-11-02', tettoPrima: 100000, dal: '2026-10-30' });
    expect(r.azioni).toEqual([{ tipo: 'pausa', numero: C, qualita: 'MEDIUM', fino: '2026-11-02', tettoPrima: 100000 }]);
  });

  it('pausa non ancora scaduta: resta ferma anche se torna HIGH', () => {
    const s = run('2026-10-30', leggi({ [C]: 'LOW' })).stato;
    const r = run('2026-11-01', leggi({}), s, { ...tuttiAperti(), [`whatsapp:${C}`]: 0 });
    expect(r.tetti[`whatsapp:${C}`]).toBe(0);
    expect(r.azioni).toEqual([]);
  });

  it('pausa scaduta e HIGH: riparte col tetto di prima', () => {
    const s = run('2026-10-30', leggi({ [C]: 'LOW' })).stato;
    const r = run('2026-11-02', leggi({}), s, { ...tuttiAperti(), [`whatsapp:${C}`]: 0 });
    expect(r.tetti[`whatsapp:${C}`]).toBe(100000);
    expect(r.stato.pause[C]).toBeUndefined();
    expect(r.azioni[0]).toMatchObject({ tipo: 'ripresa', numero: C });
  });

  it('pausa scaduta ma ancora MEDIUM: altri 3 giorni', () => {
    const s = run('2026-10-30', leggi({ [C]: 'LOW' })).stato;
    const r = run('2026-11-02', leggi({ [C]: 'MEDIUM' }), s, { ...tuttiAperti(), [`whatsapp:${C}`]: 0 });
    expect(r.tetti[`whatsapp:${C}`]).toBe(0);
    expect(r.stato.pause[C].fino).toBe('2026-11-05');
  });

  it('mai fermare l ultimo aperto: azione di avviso e tetto intatto', () => {
    const tetti = { [`whatsapp:${A}`]: 100000, [`whatsapp:${B}`]: 0, [`whatsapp:${C}`]: 0 };
    const r = run('2026-10-30', leggi({ [A]: 'MEDIUM' }), vuoto(), tetti);
    expect(r.tetti[`whatsapp:${A}`]).toBe(100000);
    expect(r.azioni).toEqual([{ tipo: 'pausa_negata_ultimo', numero: A, qualita: 'MEDIUM' }]);
  });

  it('due scendono insieme: il primo si ferma, il secondo no se resterebbe l unico... ma qui ne resta uno', () => {
    const r = run('2026-10-30', leggi({ [A]: 'LOW', [B]: 'MEDIUM' }));
    expect(r.tetti[`whatsapp:${A}`]).toBe(0);
    expect(r.tetti[`whatsapp:${B}`]).toBe(0);
    expect(r.tetti[`whatsapp:${C}`]).toBe(100000);
  });

  it('tutti e tre scendono: si fermano i primi due, il terzo resta aperto con avviso', () => {
    const r = run('2026-10-30', leggi({ [A]: 'LOW', [B]: 'LOW', [C]: 'LOW' }));
    const aperti = [A, B, C].filter((n) => r.tetti[`whatsapp:${n}`] > 0);
    expect(aperti).toHaveLength(1);
    expect(r.azioni.some((a) => a.tipo === 'pausa_negata_ultimo')).toBe(true);
  });

  it('UNKNOWN (API giu): nessuna pausa', () => {
    const r = run('2026-10-30', leggi({ [C]: 'UNKNOWN' }));
    expect(r.azioni).toEqual([]);
  });

  it('un numero a riposo messo a mano (tetto 0, senza pausa) non viene mai riaperto', () => {
    const tetti = { ...tuttiAperti(), [`whatsapp:${C}`]: 0 };
    const r = run('2026-10-30', leggi({}), vuoto(), tetti);
    expect(r.tetti[`whatsapp:${C}`]).toBe(0);
  });

  it('3199: rientra a 30 solo dopo 7 giorni HIGH di fila', () => {
    let s = vuoto();
    let tetti = tuttiAperti() as Record<string, number>;
    for (let k = 0; k < 6; k++) {
      const r = run(piuGiorni('2026-11-01', k), leggi({ [P]: 'HIGH' }), s, tetti);
      expect(r.azioni).toEqual([]);
      s = r.stato; tetti = r.tetti;
    }
    const r7 = run(piuGiorni('2026-11-01', 6), leggi({ [P]: 'HIGH' }), s, tetti);
    expect(r7.tetti[`whatsapp:${P}`]).toBe(30);
    expect(r7.azioni).toEqual([{ tipo: 'rientro_primario', numero: P, tetto: 30 }]);
  });

  it('3199: un giorno MEDIUM in mezzo azzera la fila', () => {
    let s = vuoto();
    const q: Qualita[] = ['HIGH', 'HIGH', 'MEDIUM', 'HIGH', 'HIGH', 'HIGH', 'HIGH'];
    let ultimo;
    for (let k = 0; k < q.length; k++) {
      ultimo = run(piuGiorni('2026-11-01', k), leggi({ [P]: q[k] }), s);
      s = ultimo.stato;
    }
    expect(ultimo!.tetti[`whatsapp:${P}`]).toBeUndefined();
  });

  it('3199: la lettura peggiore del giorno resta, anche se dopo torna HIGH', () => {
    const s = run('2026-11-01', leggi({ [P]: 'MEDIUM' })).stato;
    const r = run('2026-11-01', leggi({ [P]: 'HIGH' }), s);
    expect(r.stato.storico[P]['2026-11-01']).toBe('MEDIUM');
  });

  it('3199 nel giro che scende: esce subito', () => {
    const r = run('2026-11-10', leggi({ [P]: 'MEDIUM' }), vuoto(), { ...tuttiAperti(), [`whatsapp:${P}`]: 30 });
    expect(r.tetti[`whatsapp:${P}`]).toBeUndefined();
    expect(r.azioni).toEqual([{ tipo: 'uscita_primario', numero: P, qualita: 'MEDIUM' }]);
  });

  it('storico: tiene solo le ultime 3 settimane', () => {
    const s: StatoQualita = { storico: { [A]: { '2026-09-01': 'LOW' } }, pause: {} };
    const r = run('2026-10-30', leggi({}), s);
    expect(r.stato.storico[A]['2026-09-01']).toBeUndefined();
  });
});

describe('utilita', () => {
  it('giornoRoma usa il giorno di Roma', () => {
    expect(giornoRoma(new Date('2026-10-29T23:30:00Z'))).toBe('2026-10-30');
  });
  it('normalizzaQualita', () => {
    expect(normalizzaQualita('high')).toBe('HIGH');
    expect(normalizzaQualita(null)).toBe('UNKNOWN');
  });
});
