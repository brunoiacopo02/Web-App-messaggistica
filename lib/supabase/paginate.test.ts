import { describe, it, expect } from 'vitest';
import { fetchAllRows, PAGE_SIZE } from './paginate';

/** Finta tabella: risponde a .range(from, to) come fa PostgREST, tetto incluso. */
function tabella(righe: number, capPerRichiesta = PAGE_SIZE) {
  const chiamate: Array<[number, number]> = [];
  const query = async (from: number, to: number) => {
    chiamate.push([from, to]);
    const quante = Math.min(to - from + 1, capPerRichiesta);
    const data = Array.from({ length: Math.max(0, Math.min(quante, righe - from)) }, (_, i) => ({ id: from + i }));
    return { data, error: null };
  };
  return { query, chiamate };
}

describe('fetchAllRows', () => {
  it('una pagina piena non basta: continua finché la pagina è corta', async () => {
    const t = tabella(2350);
    const righe = await fetchAllRows<{ id: number }>((from, to) => t.query(from, to));
    expect(righe).toHaveLength(2350);
    expect(righe[0].id).toBe(0);
    expect(righe[2349].id).toBe(2349);
  });

  it('chiede pagine da PAGE_SIZE, non oltre il tetto di PostgREST', async () => {
    const t = tabella(2350);
    await fetchAllRows<{ id: number }>((from, to) => t.query(from, to));
    expect(t.chiamate[0]).toEqual([0, PAGE_SIZE - 1]);
    expect(t.chiamate[1]).toEqual([PAGE_SIZE, 2 * PAGE_SIZE - 1]);
    expect(PAGE_SIZE).toBeLessThanOrEqual(1000);
  });

  it('meno di una pagina: una sola richiesta', async () => {
    const t = tabella(12);
    const righe = await fetchAllRows<{ id: number }>((from, to) => t.query(from, to));
    expect(righe).toHaveLength(12);
    expect(t.chiamate).toHaveLength(1);
  });

  it('tabella vuota: nessuna riga, nessun giro a vuoto', async () => {
    const t = tabella(0);
    const righe = await fetchAllRows<{ id: number }>((from, to) => t.query(from, to));
    expect(righe).toEqual([]);
    expect(t.chiamate).toHaveLength(1);
  });

  it('un multiplo esatto della pagina non perde righe (ultima pagina vuota)', async () => {
    const t = tabella(2 * PAGE_SIZE);
    const righe = await fetchAllRows<{ id: number }>((from, to) => t.query(from, to));
    expect(righe).toHaveLength(2 * PAGE_SIZE);
  });

  it('un errore ferma la lettura e risale: mezza tabella è peggio di un errore', async () => {
    const query = async (from: number) =>
      from === 0
        ? { data: Array.from({ length: PAGE_SIZE }, (_, i) => ({ id: i })), error: null }
        : { data: null, error: { message: 'boom' } };
    await expect(fetchAllRows<{ id: number }>((from) => query(from))).rejects.toThrow('boom');
  });

  it('il tetto massimo protegge da una tabella che non finisce mai', async () => {
    const t = tabella(1_000_000);
    const righe = await fetchAllRows<{ id: number }>((from, to) => t.query(from, to), { max: 3 * PAGE_SIZE });
    expect(righe).toHaveLength(3 * PAGE_SIZE);
  });
});
