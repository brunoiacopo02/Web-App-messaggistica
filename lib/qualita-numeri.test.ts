import { describe, it, expect } from 'vitest';
import { decidi, piuGiorni, giornoRoma, normalizzaQualita, sommaTetti, type StatoQualita, type Qualita } from './qualita-numeri';

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

  it('3199: rientra a 15 dopo 4 giorni HIGH di fila; al 7° sale a 30 una volta sola (PO 07/11/2026), poi resta', () => {
    let s = vuoto();
    let tetti = tuttiAperti() as Record<string, number>;
    const giorno = (k: number) => piuGiorni('2026-11-01', k);
    for (let k = 0; k < 3; k++) {
      const r = run(giorno(k), leggi({ [P]: 'HIGH' }), s, tetti);
      expect(r.azioni).toEqual([]);
      s = r.stato; tetti = r.tetti;
    }
    const r4 = run(giorno(3), leggi({ [P]: 'HIGH' }), s, tetti);
    expect(r4.tetti[`whatsapp:${P}`]).toBe(15);
    expect(r4.azioni).toEqual([{ tipo: 'rientro_primario', numero: P, tetto: 15 }]);
    s = r4.stato; tetti = r4.tetti;
    for (let k = 4; k < 12; k++) {
      const r = run(giorno(k), leggi({ [P]: 'HIGH' }), s, tetti);
      if (k === 6) {
        // 7° giorno HIGH di fila (k = 0..6): promozione una tantum a 30.
        expect(r.tetti[`whatsapp:${P}`]).toBe(30);
        expect(r.azioni).toEqual([{ tipo: 'tetto_promosso', numero: P, da: 15, a: 30, giorniHigh: 7 }]);
      } else {
        expect(r.tetti[`whatsapp:${P}`]).toBe(k < 6 ? 15 : 30);
        expect(r.azioni).toEqual([]);
      }
      s = r.stato; tetti = r.tetti;
    }
    expect(s.primario).toBeNull();
  });

  it('3199 messo a 15 a mano e HIGH: resta a 15', () => {
    const tetti = { ...tuttiAperti(), [`whatsapp:${P}`]: 15 };
    const r = run('2026-11-06', leggi({ [P]: 'HIGH' }), vuoto(), tetti);
    expect(r.tetti[`whatsapp:${P}`]).toBe(15);
    expect(r.azioni).toEqual([]);
  });

  it('una fase "trenta" rimasta dallo stato vecchio si azzera senza alzare il tetto', () => {
    const tetti = { ...tuttiAperti(), [`whatsapp:${P}`]: 30 };
    const r = run('2026-11-20', leggi({ [P]: 'HIGH' }), { ...vuoto(), primario: { fase: 'trenta', dal: '2026-11-01' } }, tetti);
    expect(r.tetti[`whatsapp:${P}`]).toBe(30);
    expect(r.stato.primario).toBeNull();
  });

  it('3199 a 15 che scende: esce subito e la fila riparte da zero', () => {
    let s = vuoto();
    let tetti = tuttiAperti() as Record<string, number>;
    for (let k = 0; k < 4; k++) { const r = run(piuGiorni('2026-11-01', k), leggi({ [P]: 'HIGH' }), s, tetti); s = r.stato; tetti = r.tetti; }
    expect(tetti[`whatsapp:${P}`]).toBe(15);
    const giu = run('2026-11-05', leggi({ [P]: 'MEDIUM' }), s, tetti);
    expect(giu.tetti[`whatsapp:${P}`]).toBeUndefined();
    expect(giu.stato.primario).toBeNull();
    s = giu.stato; tetti = giu.tetti;
    for (let k = 5; k < 8; k++) { const r = run(piuGiorni('2026-11-01', k), leggi({ [P]: 'HIGH' }), s, tetti); s = r.stato; tetti = r.tetti; }
    expect(tetti[`whatsapp:${P}`]).toBeUndefined();
  });

  it('3199: un giorno MEDIUM in mezzo azzera la fila', () => {
    let s = vuoto();
    const q: Qualita[] = ['HIGH', 'HIGH', 'MEDIUM', 'HIGH', 'HIGH', 'HIGH'];
    let ultimo;
    for (let k = 0; k < q.length; k++) {
      ultimo = run(piuGiorni('2026-11-01', k), leggi({ [P]: q[k] }), s);
      s = ultimo.stato;
    }
    expect(ultimo!.tetti[`whatsapp:${P}`]).toBeUndefined();
  });

  it('3199 a 30 messo a mano (senza fase): non sale da solo a regime', () => {
    const r = run('2026-11-10', leggi({ [P]: 'HIGH' }), vuoto(), { ...tuttiAperti(), [`whatsapp:${P}`]: 30 });
    expect(r.tetti[`whatsapp:${P}`]).toBe(30);
    expect(r.azioni).toEqual([]);
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

describe('promozioni una tantum dei tetti (PO 07/11/2026)', () => {
  const N8061 = '+393520158061';
  const N8718 = '+393522018718';
  const N0047 = '+393522070047';
  const N2245 = '+393522622245';
  const N2508 = '+393522782508';
  const SEC2 = [N8061, N8718, N0047, N2245, N2508].map((n) => `whatsapp:${n}`);
  // I tetti com'erano il 07/11 mattina (somma 190 = BOT_TETTO_GIORNALIERO del CRM).
  const tetti07 = (): Record<string, number> => ({
    [`whatsapp:${N8061}`]: 15, [`whatsapp:${P}`]: 15, [`whatsapp:${N8718}`]: 50,
    [`whatsapp:${N0047}`]: 50, [`whatsapp:${N2245}`]: 30, [`whatsapp:${N2508}`]: 30,
  });
  const tuttiHigh = (): Record<string, Qualita> =>
    Object.fromEntries([P, N8061, N8718, N0047, N2245, N2508].map((n) => [n, 'HIGH'])) as Record<string, Qualita>;
  // Lo storico vero al 07/11: 2245/2508 HIGH dal 06/11, 3199 HIGH dal 06/11 (LOW prima).
  const stato07 = (): StatoQualita => ({
    pause: {},
    storico: {
      [P]: { '2026-11-04': 'LOW', '2026-11-05': 'LOW', '2026-11-06': 'HIGH', '2026-11-07': 'HIGH' },
      [N8061]: { '2026-11-06': 'HIGH', '2026-11-07': 'HIGH' },
      [N8718]: { '2026-11-06': 'HIGH', '2026-11-07': 'HIGH' },
      [N0047]: { '2026-11-06': 'HIGH', '2026-11-07': 'HIGH' },
      [N2245]: { '2026-11-06': 'HIGH', '2026-11-07': 'HIGH' },
      [N2508]: { '2026-11-06': 'HIGH', '2026-11-07': 'HIGH' },
    },
  });
  const giro = (oggi: string, letture: Record<string, Qualita>, stato: StatoQualita, tetti: Record<string, number>) =>
    decidi({ oggi, letture, stato, tetti, primario: `whatsapp:${P}`, secondari: SEC2 });

  it('07/11 (2 giorni HIGH): nessuna promozione', () => {
    const r = giro('2026-11-07', tuttiHigh(), stato07(), tetti07());
    expect(r.azioni.filter((a) => a.tipo === 'tetto_promosso')).toEqual([]);
    expect(r.tetti).toEqual(tetti07());
  });

  it('08/11 (3 giorni HIGH): 2245 e 2508 da 30 a 50, nient altro; somma 190 -> 230', () => {
    const r = giro('2026-11-08', tuttiHigh(), stato07(), tetti07());
    expect(r.azioni).toEqual([
      { tipo: 'tetto_promosso', numero: N2245, da: 30, a: 50, giorniHigh: 3 },
      { tipo: 'tetto_promosso', numero: N2508, da: 30, a: 50, giorniHigh: 3 },
    ]);
    expect(r.tetti).toEqual({ ...tetti07(), [`whatsapp:${N2245}`]: 50, [`whatsapp:${N2508}`]: 50 });
    expect(sommaTetti(tetti07())).toBe(190);
    expect(sommaTetti(r.tetti)).toBe(230);
    expect(r.stato.promozioni?.[N2245]).toEqual({ giorno: '2026-11-08', da: 30, a: 50 });
  });

  it('idempotente: il secondo giro dello stesso giorno, e i giorni dopo, non rifanno niente', () => {
    const r1 = giro('2026-11-08', tuttiHigh(), stato07(), tetti07());
    const r2 = giro('2026-11-08', tuttiHigh(), r1.stato, r1.tetti);
    expect(r2.azioni).toEqual([]);
    expect(r2.tetti).toEqual(r1.tetti);
    // Anche se una persona lo riabbassa a mano: la promozione non torna.
    const r3 = giro('2026-11-09', tuttiHigh(), r2.stato, { ...r2.tetti, [`whatsapp:${N2245}`]: 20 });
    expect(r3.azioni.filter((a) => a.tipo === 'tetto_promosso')).toEqual([]);
    expect(r3.tetti[`whatsapp:${N2245}`]).toBe(20);
  });

  it('3199: da 15 a 30 solo al 7° giorno HIGH di fila (12/11)', () => {
    let s = stato07();
    let t = tetti07();
    const promosso3199: string[] = [];
    for (const g of ['2026-11-08', '2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12']) {
      const r = giro(g, tuttiHigh(), s, t);
      if (r.azioni.some((a) => a.tipo === 'tetto_promosso' && a.numero === P)) promosso3199.push(g);
      s = r.stato;
      t = r.tetti;
    }
    expect(promosso3199).toEqual(['2026-11-12']);
    expect(t[`whatsapp:${P}`]).toBe(30);
    expect(sommaTetti(t)).toBe(245);
  });

  it('un giorno non HIGH nella serie: niente promozione', () => {
    const s = stato07();
    s.storico[N2245]['2026-11-07'] = 'MEDIUM';
    const r = giro('2026-11-08', tuttiHigh(), s, tetti07());
    expect(r.azioni.some((a) => a.tipo === 'tetto_promosso' && a.numero === N2245)).toBe(false);
    expect(r.tetti[`whatsapp:${N2245}`]).toBe(30);
  });

  it('mai verso il basso, mai su un numero a 0', () => {
    const t = { ...tetti07(), [`whatsapp:${N2245}`]: 80, [`whatsapp:${N2508}`]: 0 };
    const r = giro('2026-11-08', tuttiHigh(), stato07(), t);
    expect(r.azioni.filter((a) => a.tipo === 'tetto_promosso')).toEqual([]);
    expect(r.tetti[`whatsapp:${N2245}`]).toBe(80);
    expect(r.tetti[`whatsapp:${N2508}`]).toBe(0);
  });

  it('sceso sotto HIGH oggi: va in pausa e non viene promosso', () => {
    const r = giro('2026-11-08', { ...tuttiHigh(), [N2245]: 'MEDIUM' }, stato07(), tetti07());
    expect(r.tetti[`whatsapp:${N2245}`]).toBe(0);
    expect(r.azioni.some((a) => a.tipo === 'tetto_promosso' && a.numero === N2245)).toBe(false);
  });
});
