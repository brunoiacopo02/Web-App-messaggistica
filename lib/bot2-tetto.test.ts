import { describe, it, expect } from 'vitest';
import { inizioGiornataRoma, chatNateOggi } from './bot2-tetto';

const NUM = 'whatsapp:+393522070047';

/** Un finto Supabase che risponde con un conteggio, o esplode. */
function finto(risposta: { count?: number | null; error?: unknown; lancia?: boolean }) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          gte: async () => {
            if (risposta.lancia) throw new Error('rete giu');
            return { count: risposta.count ?? null, error: risposta.error ?? null };
          },
        }),
      }),
    }),
  } as never;
}

describe('inizioGiornataRoma', () => {
  it('il giorno si conta su Roma, non su UTC', () => {
    // 00:30 di Roma in estate = 22:30 UTC del giorno prima: la mezzanotte
    // giusta e' quella italiana, altrimenti il tetto si azzera due ore tardi.
    const inizio = inizioGiornataRoma(new Date('2026-07-10T22:30:00Z'));
    expect(inizio.startsWith('2026-07-11T00:00:00')).toBe(true);
  });
});

describe('chatNateOggi', () => {
  it('torna il conteggio', async () => {
    expect(await chatNateOggi(finto({ count: 12 }), 'whatsapp:+393522018718')).toBe(12);
  });
  it('errore, eccezione o conteggio nullo = null', async () => {
    expect(await chatNateOggi(finto({ error: { message: 'x' } }), NUM)).toBeNull();
    expect(await chatNateOggi(finto({ lancia: true }), NUM)).toBeNull();
    expect(await chatNateOggi(finto({ count: null }), NUM)).toBeNull();
  });
});
