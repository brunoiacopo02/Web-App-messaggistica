import { describe, it, expect, vi, beforeEach } from 'vitest';

// Le azioni non si toccano mai dall'Assistente: se qualcuno chiama anteprima o esegui, il test cade.
const azioniChiamate = vi.hoisted(() => ({ n: 0 }));
vi.mock('@/lib/console/azioni', async (importOriginal) => {
  const vere = await importOriginal<typeof import('@/lib/console/azioni')>();
  return {
    PARAMS: vere.PARAMS,
    anteprima: () => {
      azioniChiamate.n++;
      throw new Error('anteprima non va mai chiamata dall\'Assistente');
    },
    esegui: () => {
      azioniChiamate.n++;
      throw new Error('esegui non va mai chiamata dall\'Assistente');
    },
  };
});
vi.mock('@/lib/console/viste-db', () => ({
  cercaChat: async () => [],
  contaViste: async () => ({ serve_te: 2, non_lette: 5, lancio: 0, fissati_bot: 0, gdo: 0, mario: 0, chiuse: 0, campagne: 0, errori: 1 }),
}));
vi.mock('@/lib/console/avvisi-db', () => ({
  leggiAvvisi: async () => [
    {
      id: 'twilio-63016', gravita: 'attenzione', titolo: 'Messaggi fuori finestra', significato: '', cosaFare: 'Aprire le chat',
      conteggio: 3, chat: [1], ultimoAt: null, area: 'twilio', azioni: [], primoAt: null, firma: 'x',
    },
  ],
}));
vi.mock('@/lib/console/regia-db', () => ({ leggiRegia: async () => { throw new Error('non serve qui'); } }));

const { eseguiStrumento, tronca, STRUMENTI } = await import('./assistente-tools');

type Chiamata = [string, unknown[]];
/** Finto client Supabase: ogni `from` registra le chiamate e risponde con l'handler della tabella. */
function fintoSupa(handlers: Record<string, (calls: Chiamata[]) => unknown>) {
  const log: { tabella: string; calls: Chiamata[] }[] = [];
  const metodi = ['select', 'eq', 'gte', 'lte', 'gt', 'lt', 'order', 'or', 'in', 'like', 'limit', 'abortSignal'];
  const s = {
    log,
    from(tabella: string) {
      const calls: Chiamata[] = [];
      log.push({ tabella, calls });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const q: any = {};
      for (const m of metodi) q[m] = (...args: unknown[]) => { calls.push([m, args]); return q; };
      const risposta = () => Promise.resolve(handlers[tabella]?.(calls) ?? { data: [], error: null });
      q.maybeSingle = () => risposta();
      q.then = (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) => risposta().then(ok, ko);
      for (const m of ['insert', 'update', 'upsert', 'delete']) q[m] = () => { throw new Error(`scrittura su ${tabella}`); };
      return q;
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return s as any;
}

const now = new Date('2026-10-05T19:00:00.000Z');
const chatInPausa = (pausa: string | null) =>
  fintoSupa({ conversations: () => ({ data: { id: 9, ai_owner: 'mario', ai_paused_at: pausa, campaign: null }, error: null }) });

beforeEach(() => {
  azioniChiamate.n = 0;
});

describe('proponi_azione', () => {
  it('parametri validi: restituisce la proposta senza chiamare le azioni', async () => {
    const r = await eseguiStrumento(
      'proponi_azione',
      { azione: 'pausa_mario', params: { conversationId: 9 }, motivo: 'Fermare Mario sulla chat di Anna' },
      { s: fintoSupa({}), now },
    );
    expect(r.proposta).toEqual({ azione: 'pausa_mario', params: { conversationId: 9 }, etichetta: 'Fermare Mario sulla chat di Anna' });
    expect(r.contenuto).toBe("Proposta mostrata all'admin: la esegue solo lui dopo la prova a vuoto.");
    expect(azioniChiamate.n).toBe(0);
  });

  it('azione inesistente: errore e nessuna proposta', async () => {
    const r = await eseguiStrumento('proponi_azione', { azione: 'cancella_tutto', params: {}, motivo: 'x' }, { s: fintoSupa({}), now });
    expect(r.proposta).toBeUndefined();
    expect(r.contenuto).toMatch(/non valid|non esiste/i);
    expect(azioniChiamate.n).toBe(0);
  });

  it('parametri che non rispettano PARAMS: nessuna proposta', async () => {
    const r = await eseguiStrumento('proponi_azione', { azione: 'pausa_mario', params: { conversationId: 'nove' }, motivo: 'x' }, { s: fintoSupa({}), now });
    expect(r.proposta).toBeUndefined();
    expect(azioniChiamate.n).toBe(0);
  });
});

describe('bozza_risposta', () => {
  it('Mario attivo: rifiuta e non restituisce bozze', async () => {
    const r = await eseguiStrumento('bozza_risposta', { conversationId: 9, testo: 'Ciao Anna' }, { s: chatInPausa(null), now });
    expect(r.bozza).toBeUndefined();
    expect(r.contenuto.startsWith('Rifiutato')).toBe(true);
  });

  it('Mario in pausa: la bozza è il testo scritto dal modello, senza scritture', async () => {
    const s = chatInPausa('2026-10-05T18:00:00.000Z');
    const r = await eseguiStrumento('bozza_risposta', { conversationId: 9, testo: 'Ciao Anna, ti scrivo io' }, { s, now });
    expect(r.bozza).toEqual({ conversationId: 9, testo: 'Ciao Anna, ti scrivo io' });
    expect(r.contenuto).toBe('Bozza mostrata all\'admin: la invia lui.');
    expect(s.log.every((l: { tabella: string }) => l.tabella === 'conversations')).toBe(true);
  });
});

describe('leggi_eventi', () => {
  it('ore oltre 72 vengono ridotte a 72', async () => {
    const s = fintoSupa({ event_log: () => ({ data: [], error: null }) });
    const r = await eseguiStrumento('leggi_eventi', { ore: 500 }, { s, now });
    const gte = s.log[0].calls.find(([m]: Chiamata) => m === 'gte');
    expect(gte?.[1]).toEqual(['created_at', new Date(now.getTime() - 72 * 3600_000).toISOString()]);
    expect(r.sintesi).toContain('ultime 72 ore');
  });

  it('al massimo 50 righe', async () => {
    const s = fintoSupa({ event_log: () => ({ data: [], error: null }) });
    await eseguiStrumento('leggi_eventi', {}, { s, now });
    expect(s.log[0].calls).toContainEqual(['limit', [50]]);
  });
});

describe('altri strumenti', () => {
  it('elenca_avvisi cita gli avvisi', async () => {
    const r = await eseguiStrumento('elenca_avvisi', {}, { s: fintoSupa({}), now });
    expect(r.citazioni).toEqual([{ tipo: 'avviso', id: 'twilio-63016', etichetta: 'Messaggi fuori finestra' }]);
    expect(r.contenuto).toContain('Aprire le chat');
  });

  it('conta_viste riporta i conteggi con le etichette', async () => {
    const r = await eseguiStrumento('conta_viste', {}, { s: fintoSupa({}), now });
    expect(r.contenuto).toContain('Serve te: 2');
  });

  it('spiega_errore_twilio usa la tabella dei codici', async () => {
    const r = await eseguiStrumento('spiega_errore_twilio', { code: 63016 }, { s: fintoSupa({}), now });
    expect(r.contenuto).toContain('24 ore');
  });

  it('strumento sconosciuto: contenuto di errore', async () => {
    const r = await eseguiStrumento('invia_messaggio', {}, { s: fintoSupa({}), now });
    expect(r.contenuto).toMatch(/sconosciuto/i);
  });

  it('nessuno strumento ha un nome che scrive o invia', () => {
    const nomi = STRUMENTI.map((t) => t.name);
    expect(nomi).toEqual([
      'cerca_lead', 'leggi_chat', 'leggi_eventi', 'conta_viste', 'elenca_avvisi',
      'spiega_errore_twilio', 'stato_lancio', 'proponi_azione', 'bozza_risposta',
    ]);
  });
});

describe('tronca', () => {
  it('taglia a 2000 caratteri con i puntini', () => {
    const t = tronca('a'.repeat(3000));
    expect(t).toHaveLength(2000);
    expect(t.endsWith('…')).toBe(true);
  });

  it('lascia intatto un testo corto', () => {
    expect(tronca('ciao')).toBe('ciao');
  });
});
