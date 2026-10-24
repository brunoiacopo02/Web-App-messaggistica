/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from 'vitest';
import {
  decideSollecitoRichiamo, sollecitoRichiamoText, conversazioniParcheggiate,
  type SollecitoRichiamoInput,
} from './conf-richiamo';

const at = (iso: string) => new Date(iso).getTime();
const H = 3600_000;

// Martedì 20/10/2026, ora legale (+02:00).
const RICHIAMO = '2026-10-20T16:00:00+02:00';

const base = (over: Partial<SollecitoRichiamoInput> = {}): SollecitoRichiamoInput => ({
  enabled: true,
  confermeOutcome: 'da_rifissare',
  recallAt: RICHIAMO,
  aiPausedAt: null,
  giaInviato: false,
  lastInboundAtMs: null,
  haTemplate: true,
  nowMs: at('2026-10-20T14:00:00+02:00'),
  ...over,
});

describe('decideSollecitoRichiamo', () => {
  it('richiamo alle 16:00: alle 13:59 non ancora', () => {
    expect(decideSollecitoRichiamo(base({ nowMs: at('2026-10-20T13:59:00+02:00') }))).toBeNull();
  });

  it('richiamo alle 16:00: alle 14:00 parte (template, finestra chiusa)', () => {
    expect(decideSollecitoRichiamo(base())).toBe('template');
  });

  it('richiamo alle 16:00: alle 14:00 parte in testo se il lead ha scritto da poco', () => {
    expect(decideSollecitoRichiamo(base({ lastInboundAtMs: at('2026-10-20T11:00:00+02:00') }))).toBe('testo');
  });

  it('richiamo alle 16:00: alle 15:50 è troppo tardi', () => {
    expect(decideSollecitoRichiamo(base({ nowMs: at('2026-10-20T15:50:00+02:00') }))).toBeNull();
  });

  it('richiamo alle 09:00: alle 08:30 parte, alle 08:00 no (fascia invii)', () => {
    const r = '2026-10-20T09:00:00+02:00';
    expect(decideSollecitoRichiamo(base({ recallAt: r, nowMs: at('2026-10-20T08:30:00+02:00') }))).toBe('template');
    expect(decideSollecitoRichiamo(base({ recallAt: r, nowMs: at('2026-10-20T08:00:00+02:00') }))).toBeNull();
  });

  it('fuori fascia invii non parte nemmeno se la finestra del sollecito è aperta', () => {
    // Richiamo alle 22:00: il sollecito puo' partire dalle 20:00, ma alle 21:00 la fascia
    // degli invii (08:30-20:30) e' chiusa.
    const r = '2026-10-20T22:00:00+02:00';
    expect(decideSollecitoRichiamo(base({ recallAt: r, nowMs: at('2026-10-20T20:15:00+02:00') }))).toBe('template');
    expect(decideSollecitoRichiamo(base({ recallAt: r, nowMs: at('2026-10-20T21:00:00+02:00') }))).toBeNull();
  });

  it('esito diverso da da_rifissare: niente', () => {
    expect(decideSollecitoRichiamo(base({ confermeOutcome: 'confermato' }))).toBeNull();
    expect(decideSollecitoRichiamo(base({ confermeOutcome: null }))).toBeNull();
  });

  it('interruttore spento, richiamo assente o illeggibile, chat in pausa, già inviato: niente', () => {
    expect(decideSollecitoRichiamo(base({ enabled: false }))).toBeNull();
    expect(decideSollecitoRichiamo(base({ recallAt: null }))).toBeNull();
    expect(decideSollecitoRichiamo(base({ recallAt: 'boh' }))).toBeNull();
    expect(decideSollecitoRichiamo(base({ aiPausedAt: '2026-10-20T10:00:00Z' }))).toBeNull();
    expect(decideSollecitoRichiamo(base({ giaInviato: true }))).toBeNull();
  });

  it('inbound di 3 ore fa: testo libero', () => {
    const nowMs = at('2026-10-20T14:30:00+02:00');
    expect(decideSollecitoRichiamo(base({ nowMs, lastInboundAtMs: nowMs - 3 * H }))).toBe('testo');
  });

  it('inbound di 3 ore fa: testo libero anche senza template', () => {
    const nowMs = at('2026-10-20T14:30:00+02:00');
    expect(decideSollecitoRichiamo(base({ nowMs, lastInboundAtMs: nowMs - 3 * H, haTemplate: false }))).toBe('testo');
  });

  it('inbound di 30 ore fa e nessun template: niente', () => {
    const nowMs = at('2026-10-20T14:30:00+02:00');
    expect(decideSollecitoRichiamo(base({ nowMs, lastInboundAtMs: nowMs - 30 * H, haTemplate: false }))).toBeNull();
  });

  it('inbound di 30 ore fa col template: template', () => {
    const nowMs = at('2026-10-20T14:30:00+02:00');
    expect(decideSollecitoRichiamo(base({ nowMs, lastInboundAtMs: nowMs - 30 * H }))).toBe('template');
  });
});

describe('sollecitoRichiamoText', () => {
  it('è il testo del template con le variabili al loro posto', () => {
    expect(sollecitoRichiamoText({ '1': 'Luca', '2': 'oggi alle 16:00' })).toBe(
      'Ciao Luca, oggi alle 16:00 ti richiama Noemi, una collega di Fenice Academy, da un numero di cellulare ' +
      "per confermare giorno e ora della tua videochiamata: rispondi, sono pochi minuti. Se non l'hai ancora " +
      'fatto, guarda il video che ti ho mandato qui.',
    );
  });

  it('niente trattino lungo', () => {
    expect(sollecitoRichiamoText({ '1': 'Luca', '2': 'oggi alle 16:00' })).not.toContain('—');
  });
});

describe('conversazioniParcheggiate', () => {
  type RigaStatus = { conversation_id: number | null; lead_id: string; conferme_outcome: string | null };
  function fintoSupabase(
    righe: RigaStatus[],
    convs: Array<{ id: number; crm_lead_id: string | null }> = [],
    erroreSu: string | null = null,
  ) {
    const chiamate: string[] = [];
    const eventi: any[] = [];
    const supabase = {
      from(table: string) {
        chiamate.push(table);
        const filtri: Array<(r: any) => boolean> = [];
        const sorgente: any[] = table === 'crm_lead_status' ? righe : table === 'conversations' ? convs : [];
        const q: any = {
          select: () => q,
          eq: (c: string, v: unknown) => { filtri.push((r) => r[c] === v); return q; },
          in: (c: string, v: unknown[]) => { filtri.push((r) => v.includes(r[c])); return q; },
          then: (resolve: any) => resolve(erroreSu === table
            ? { data: null, error: { message: 'giù' } }
            : { data: sorgente.filter((r) => filtri.every((f) => f(r))), error: null }),
          insert: async (r: any) => { eventi.push(r); return { error: null }; },
        };
        return q;
      },
    };
    return { supabase, chiamate, eventi };
  }

  // Ogni chat punta al suo lead del CRM; la 3 e' passata dal lead L3-vecchio a L3.
  const CONVS = [
    { id: 1, crm_lead_id: 'L1' }, { id: 2, crm_lead_id: 'L2' }, { id: 3, crm_lead_id: 'L3' },
    { id: 9, crm_lead_id: 'L9' },
  ];

  it('torna solo le conversazioni con esito da_rifissare, tra quelle chieste', async () => {
    const { supabase } = fintoSupabase([
      { conversation_id: 1, lead_id: 'L1', conferme_outcome: 'da_rifissare' },
      { conversation_id: 2, lead_id: 'L2', conferme_outcome: 'confermato' },
      { conversation_id: 3, lead_id: 'L3', conferme_outcome: 'da_rifissare' },
      { conversation_id: 9, lead_id: 'L9', conferme_outcome: 'da_rifissare' },
    ], CONVS);
    const s = await conversazioniParcheggiate(supabase, [1, 2, 3]);
    expect([...s].sort()).toEqual([1, 3]);
  });

  it("una riga gemella vecchia (lead_id diverso dal crm_lead_id della chat) non parcheggia l'appuntamento vivo", async () => {
    const { supabase } = fintoSupabase([
      { conversation_id: 3, lead_id: 'L3-vecchio', conferme_outcome: 'da_rifissare' },
      { conversation_id: 3, lead_id: 'L3', conferme_outcome: 'confermato' },
    ], CONVS);
    const s = await conversazioniParcheggiate(supabase, [3]);
    expect(s.size).toBe(0);
  });

  it('nessun id: nessuna query', async () => {
    const { supabase, chiamate } = fintoSupabase([]);
    const s = await conversazioniParcheggiate(supabase, []);
    expect(s.size).toBe(0);
    expect(chiamate).toEqual([]);
  });

  it('nessuna riga parcheggiata: non si leggono le conversazioni', async () => {
    const { supabase, chiamate } = fintoSupabase([], CONVS);
    await conversazioniParcheggiate(supabase, [1, 2]);
    expect(chiamate).toEqual(['crm_lead_status']);
  });

  it('query in errore: insieme vuoto (i promemoria restano quelli di sempre) e riga in event_log', async () => {
    const { supabase, eventi } = fintoSupabase([], CONVS, 'crm_lead_status');
    const s = await conversazioniParcheggiate(supabase, [1]);
    expect(s.size).toBe(0);
    expect(eventi.map((e) => e.type)).toEqual(['conf_parcheggiati_query_error']);
  });

  it('lettura delle conversazioni in errore: insieme vuoto e riga in event_log', async () => {
    const { supabase, eventi } = fintoSupabase(
      [{ conversation_id: 1, lead_id: 'L1', conferme_outcome: 'da_rifissare' }], CONVS, 'conversations');
    const s = await conversazioniParcheggiate(supabase, [1]);
    expect(s.size).toBe(0);
    expect(eventi.map((e) => e.type)).toEqual(['conf_parcheggiati_query_error']);
  });
});
