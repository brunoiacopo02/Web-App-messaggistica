import { describe, it, expect } from 'vitest';
import { parseTettiNumeri, tettoDi, getTettiNumeri } from './tetti-numeri';

describe('parseTettiNumeri', () => {
  it('legge la mappa e normalizza le chiavi', () => {
    const t = parseTettiNumeri({ 'whatsapp:+393522018718': 150, '+393520158061': 150, 'whatsapp:+393522070047': 0 });
    expect(tettoDi(t, 'whatsapp:+393522018718')).toBe(150);
    expect(tettoDi(t, 'whatsapp:+393520158061')).toBe(150);
    expect(tettoDi(t, '+393522070047')).toBe(0);
  });

  it('numero assente = 0', () => {
    expect(tettoDi(parseTettiNumeri({}), 'whatsapp:+393522018718')).toBe(0);
  });

  it('valori strani = 0', () => {
    const t = parseTettiNumeri({ '+391': -5, '+392': 3.5, '+393': 'tanti', '+394': null, '+395': '40' });
    for (const n of ['+391', '+392', '+393', '+394']) expect(tettoDi(t, n), n).toBe(0);
    expect(tettoDi(t, '+395')).toBe(40); // stringa intera: accettata, e' come la scrive un umano
  });

  it('non un oggetto = mappa vuota', () => {
    for (const raw of [null, undefined, 'x', 3, [1, 2]]) expect(parseTettiNumeri(raw).size).toBe(0);
  });
});

describe('getTettiNumeri', () => {
  const finto = (risposta: { data?: unknown; error?: unknown; lancia?: boolean }) => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => {
      if (risposta.lancia) throw new Error('rete giu');
      return { data: risposta.data ?? null, error: risposta.error ?? null };
    } }) }) }),
  }) as never;

  it('riga presente', async () => {
    const t = await getTettiNumeri(finto({ data: { value: { '+393522018718': 150 } } }));
    expect(t && tettoDi(t, '+393522018718')).toBe(150);
  });
  it('riga assente = mappa vuota (tutti a 0)', async () => {
    expect((await getTettiNumeri(finto({ data: null })))?.size).toBe(0);
  });
  it('errore o eccezione = null', async () => {
    expect(await getTettiNumeri(finto({ error: { message: 'boom' } }))).toBeNull();
    expect(await getTettiNumeri(finto({ lancia: true }))).toBeNull();
  });
});
