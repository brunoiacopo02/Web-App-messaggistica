import { describe, it, expect } from 'vitest';
import { runPool } from './run-pool';

describe('runPool', () => {
  it('risultati nell ordine degli input, anche se finiscono in ordine diverso', async () => {
    const out = await runPool([30, 10, 20], 3, async (ms) => {
      await new Promise((r) => setTimeout(r, ms));
      return ms;
    });
    expect(out).toEqual([30, 10, 20]);
  });

  it('non supera la concorrenza', async () => {
    let attivi = 0;
    let picco = 0;
    await runPool(Array.from({ length: 12 }, (_, i) => i), 5, async () => {
      attivi++;
      picco = Math.max(picco, attivi);
      await new Promise((r) => setTimeout(r, 5));
      attivi--;
    });
    expect(picco).toBe(5);
  });

  it('lista vuota: nessun worker, array vuoto', async () => {
    let chiamate = 0;
    const out = await runPool([], 5, async () => { chiamate++; });
    expect(out).toEqual([]);
    expect(chiamate).toBe(0);
  });
});
