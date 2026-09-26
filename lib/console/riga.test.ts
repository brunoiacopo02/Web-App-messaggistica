import { describe, expect, it } from 'vitest';
import { fondiPrimaPagina, nomeRiga, orarioRiga, prefissoAnteprima } from './riga';

it('senza nome mostra il telefono formattato', () => {
  expect(nomeRiga({ nome: null, telefono: '+393471182290' })).toEqual({ principale: '+39 347 118 2290', secondario: 'Senza nome' });
  expect(nomeRiga({ nome: 'Giulia Ferraresi', telefono: '+39333' }).principale).toBe('Giulia Ferraresi');
  expect(nomeRiga({ nome: null, telefono: null }).principale).toBe('Contatto sconosciuto');
});

it('un telefono non italiano resta com\'è, un nome di soli spazi conta come assente', () => {
  expect(nomeRiga({ nome: null, telefono: '+41791234567' })).toEqual({ principale: '+41791234567', secondario: 'Senza nome' });
  expect(nomeRiga({ nome: '   ', telefono: null })).toEqual({ principale: 'Contatto sconosciuto', secondario: null });
  expect(nomeRiga({ nome: '  Marco  ', telefono: '+393331112222' })).toEqual({ principale: 'Marco', secondario: null });
});

it('orario: oggi HH:MM, ieri "Ieri", prima gg/mm', () => {
  const now = new Date('2026-10-05T19:30:00Z');
  expect(orarioRiga('2026-10-05T19:14:00Z', now)).toBe('21:14');
  expect(orarioRiga('2026-10-04T10:00:00Z', now)).toBe('Ieri');
  expect(orarioRiga('2026-09-28T10:00:00Z', now)).toBe('28/09');
  expect(orarioRiga(null, now)).toBe('');
});

it('orario: il giorno è quello di Roma, non quello UTC', () => {
  // 22:30 UTC del 4 ottobre = 00:30 del 5 a Roma: è "oggi", non "ieri".
  const now = new Date('2026-10-05T08:00:00Z');
  expect(orarioRiga('2026-10-04T22:30:00Z', now)).toBe('00:30');
  expect(orarioRiga('non una data', now)).toBe('');
});

it('anteprima su una riga sola, emoji intatte', () => {
  expect(prefissoAnteprima('Ciao\n\n  come   va? 🙂')).toBe('Ciao come va? 🙂');
  expect(prefissoAnteprima(null)).toBe('');
  expect(prefissoAnteprima('   ')).toBe('');
});

describe('fondiPrimaPagina', () => {
  const r = (id: number, ultimoAt: string, nonLetti = 0) => ({
    id, nome: `L${id}`, telefono: null, ultimoAt, anteprima: null, nonLetti, contesto: null, fase: null,
  });

  it('mette in cima le arrivate, tiene la coda già caricata e il suo cursore', () => {
    const vecchie = [r(5, '2026-10-05T10:05:00Z'), r(4, '2026-10-05T10:04:00Z'), r(3, '2026-10-05T10:03:00Z'), r(2, '2026-10-05T10:02:00Z')];
    // prima pagina nuova: arriva la 9, la 3 risale in cima; la pagina finisce alla 4
    const pagina = { righe: [r(3, '2026-10-05T10:07:00Z', 1), r(9, '2026-10-05T10:06:00Z', 1), r(5, '2026-10-05T10:05:00Z'), r(4, '2026-10-05T10:04:00Z')], prossimo: 'c-nuovo' };
    const f = fondiPrimaPagina(vecchie, pagina, 'c-vecchio');
    expect(f.righe.map((x) => x.id)).toEqual([3, 9, 5, 4, 2]);
    expect(f.prossimo).toBe('c-vecchio');
    expect(f.arrivate).toEqual([3, 9]);
  });

  it('una chat uscita dalla vista sparisce; senza altre pagine vale solo la nuova', () => {
    const vecchie = [r(5, '2026-10-05T10:05:00Z'), r(4, '2026-10-05T10:04:00Z')];
    const f = fondiPrimaPagina(vecchie, { righe: [r(4, '2026-10-05T10:04:00Z')], prossimo: null }, null);
    expect(f.righe.map((x) => x.id)).toEqual([4]);
    expect(f.prossimo).toBeNull();
    expect(f.arrivate).toEqual([]);
  });

  it('se la coda è tutta dentro la nuova pagina, il cursore è quello nuovo', () => {
    const vecchie = [r(5, '2026-10-05T10:05:00Z')];
    const f = fondiPrimaPagina(vecchie, { righe: [r(6, '2026-10-05T10:06:00Z'), r(5, '2026-10-05T10:05:00Z')], prossimo: 'c-nuovo' }, null);
    expect(f.prossimo).toBe('c-nuovo');
  });
});
