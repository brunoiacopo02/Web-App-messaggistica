import { describe, it, expect, afterEach, vi } from 'vitest';
import { puoAprireSuBot2, tettoBot2, inizioGiornataRoma, TETTO_BOT2_DEFAULT, chatNateOggi } from './bot2-tetto';

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

afterEach(() => { delete process.env.BOT2_DAILY_CAP; });

describe('tetto giornaliero del numero nuovo', () => {
  it('sotto il tetto: si apre', async () => {
    const e = await puoAprireSuBot2(finto({ count: 149 }), NUM);
    expect(e).toMatchObject({ consentito: true, oggi: 149, tetto: 150, motivo: 'ok' });
  });

  it('esattamente al tetto: NON si apre', async () => {
    const e = await puoAprireSuBot2(finto({ count: 150 }), NUM);
    expect(e).toMatchObject({ consentito: false, motivo: 'tetto_raggiunto' });
  });

  it('oltre il tetto: NON si apre', async () => {
    const e = await puoAprireSuBot2(finto({ count: 300 }), NUM);
    expect(e.consentito).toBe(false);
  });

  // Il punto di tutto il modulo: nel dubbio si dice NO.
  it('query in errore: NON si apre', async () => {
    const e = await puoAprireSuBot2(finto({ error: { message: 'boom' } }), NUM);
    expect(e).toMatchObject({ consentito: false, motivo: 'conteggio_fallito' });
  });

  it('query che esplode: NON si apre', async () => {
    const e = await puoAprireSuBot2(finto({ lancia: true }), NUM);
    expect(e).toMatchObject({ consentito: false, motivo: 'conteggio_fallito' });
  });

  it('conteggio nullo: NON si apre', async () => {
    const e = await puoAprireSuBot2(finto({ count: null }), NUM);
    expect(e.consentito).toBe(false);
  });

  it('numero non configurato: NON si apre', async () => {
    const e = await puoAprireSuBot2(finto({ count: 0 }), undefined);
    expect(e).toMatchObject({ consentito: false, motivo: 'numero_assente' });
  });

  it('il tetto si configura, e un valore assurdo ricade sul default', () => {
    process.env.BOT2_DAILY_CAP = '40';
    expect(tettoBot2()).toBe(40);
    for (const v of ['tanti', '-1', '3.5', '99999']) {
      process.env.BOT2_DAILY_CAP = v;
      expect(tettoBot2(), `valore "${v}"`).toBe(TETTO_BOT2_DEFAULT);
    }
  });

  it('tetto a zero: blocca tutto, ed e un modo legittimo di spegnere il numero', async () => {
    process.env.BOT2_DAILY_CAP = '0';
    const e = await puoAprireSuBot2(finto({ count: 0 }), NUM);
    expect(e.consentito).toBe(false);
  });

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
