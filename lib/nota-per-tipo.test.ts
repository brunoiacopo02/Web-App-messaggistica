import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  sendOutcome,
  sendCrmNota,
  prenotaNotaPerTipo,
  EVENTO_NOTA_TIPO,
  FINESTRA_NOTA_PER_TIPO_MS,
} from './bot-outcome';
import { tipoNota, crmDedupKey, paroleLeadDallaNota } from './note-dedup';

// PO, 31/10/2026: al massimo UNA nota per TIPO per conversazione ogni 2 ore.
// I testi qui sotto sono le note vere degli ultimi 7 giorni (DB del bot), tagliate.

const DISDETTE_29516 = [
  'DISDETTA — appuntamento di venerdì 30 ottobre alle 18:00 da annullare. Causa: Situazione economica gravissima, Parole del lead: "Ok".',
  'DISDETTA — appuntamento di venerdì 30 ottobre alle 18:00 da annullare. Causa: situazione economica troppo grave. Parole del lead: "Grazie".',
  'DISDETTA — appuntamento di venerdì 30 ottobre alle 18:00 da annullare. Causa: economicamente impossibile, vive con la madre. Parole del lead: "A presto".',
];
const SPOSTAMENTO_25581 =
  'SPOSTAMENTO CHIESTO — il lead ha chiesto di spostare a giovedì 29 ottobre alle 15:00. In agenda resta mercoledì 28 ottobre alle 15:00: mantenuto finché non lo spostate voi.';
const DA_RICHIAMARE_29654 =
  'DA RICHIAMARE — giorno e ora da concordare: il lead ha chiesto di essere ricontattato ma non ha indicato quando. Parole del lead: "ok".';

describe('tipoNota — il tipo è l\'etichetta in testa', () => {
  it('DISDETTA con cause e parole diverse → stesso tipo', () => {
    const tipi = new Set(DISDETTE_29516.map(tipoNota));
    expect([...tipi]).toEqual(['DISDETTA']);
  });

  it('DA RICHIAMARE, RICONFERMA, APPUNTAMENTO NON FISSATO', () => {
    expect(tipoNota(DA_RICHIAMARE_29654)).toBe('DA RICHIAMARE');
    expect(tipoNota('RICONFERMA — il lead ha riconfermato l\'appuntamento di venerdì 30 ottobre alle 18:00. Parole del lead: "A dopo".')).toBe('RICONFERMA');
    expect(tipoNota('APPUNTAMENTO NON FISSATO — il bot stava per fissare una call ma era domenica: in agenda non c\'è niente.')).toBe('APPUNTAMENTO NON FISSATO');
  });

  it('SPOSTAMENTO CHIESTO porta la data chiesta: date diverse → tipi diversi', () => {
    const giovedi = tipoNota(SPOSTAMENTO_25581);
    const venerdi = tipoNota(SPOSTAMENTO_25581.replace('giovedì 29 ottobre alle 15:00.', 'venerdì 30 ottobre alle 17:00.'));
    expect(giovedi).toBe('SPOSTAMENTO CHIESTO|giovedì 29 ottobre alle 15:00');
    expect(venerdi).toBe('SPOSTAMENTO CHIESTO|venerdì 30 ottobre alle 17:00');
    expect(tipoNota('SPOSTAMENTO CHIESTO — il lead ha chiesto di spostare l\'appuntamento (nessuna nuova data indicata dal lead). Appuntamento mantenuto: da spostare voi.'))
      .toBe('SPOSTAMENTO CHIESTO|');
  });

  it('SPOSTAMENTO NON REGISTRATO: la data chiesta sta fra parentesi', () => {
    const n = 'SPOSTAMENTO NON REGISTRATO — in agenda resta giovedì 29 ottobre alle 15:00, e non è stato spostato niente. Il bot stava per spostare la call (domenica 1 novembre alle 10:00) ma era domenica.';
    expect(tipoNota(n)).toBe('SPOSTAMENTO NON REGISTRATO|domenica 1 novembre alle 10:00');
  });

  it('sulla chiave di dedup del CRM (prima frase) dà lo stesso tipo della nota intera', () => {
    expect(tipoNota(crmDedupKey(SPOSTAMENTO_25581))).toBe(tipoNota(SPOSTAMENTO_25581));
    expect(tipoNota(crmDedupKey(DISDETTE_29516[0]))).toBe('DISDETTA');
  });

  it('esclusi: IL BOT HA RIPRESO LA CHAT, CALL FISSATA DAL BOT, note senza etichetta', () => {
    expect(tipoNota('IL BOT HA RIPRESO LA CHAT — IL LEAD HA RISCRITTO SU WHATSAPP: «ciao».')).toBeNull();
    expect(tipoNota('CALL FISSATA DAL BOT — il bot ha fissato una call per giovedì 29 ottobre alle 15:00 in chat.')).toBeNull();
    expect(tipoNota('Riscaldamento – budget e chi decide: «Decido io»')).toBeNull();
    expect(tipoNota('Secondo recapito del lead: 3274049866, sue parole: "3274049866"')).toBeNull();
    expect(tipoNota('Il lead dice — forse — di sì')).toBeNull();
  });

  it('paroleLeadDallaNota prende la citazione in coda', () => {
    expect(paroleLeadDallaNota(DISDETTE_29516[1])).toBe('Grazie');
    expect(paroleLeadDallaNota('X — «ciao»')).toBe('ciao');
    expect(paroleLeadDallaNota('X — niente')).toBeNull();
  });
});

/** event_log in memoria con id crescenti, created_at = adesso (orologio di vitest). */
function makeDb(conv: Record<string, unknown> = {}) {
  const righe: any[] = [];
  let nextId = 1;
  const updates: any[] = [];
  const val = (r: any, col: string) => {
    const m = col.match(/^payload->>(.+)$/);
    const v = m ? r.payload?.[m[1]] : r[col];
    return v == null ? undefined : String(v);
  };
  const aggiungi = (row: any) => {
    const r = { id: nextId++, created_at: new Date().toISOString(), ...row };
    righe.push(r);
    return r;
  };
  const supabase: any = {
    from(table: string) {
      if (table === 'conversations') {
        return {
          select() { return this; },
          eq() { return this; },
          maybeSingle() { return Promise.resolve({ data: conv }); },
          update(p: any) { updates.push(p); return { eq() { return Promise.resolve({}); } }; },
        };
      }
      return {
        insert(row: any) {
          const r = aggiungi(row);
          const p: any = Promise.resolve({ data: null, error: null });
          p.select = () => ({ single: () => Promise.resolve({ data: { id: r.id }, error: null }) });
          return p;
        },
        delete() {
          return { eq(col: string, v: unknown) {
            for (let i = righe.length - 1; i >= 0; i--) if (String(righe[i][col]) === String(v)) righe.splice(i, 1);
            return Promise.resolve({});
          } };
        },
        select() {
          const eqs: [string, string][] = [];
          let gte: [string, string] | null = null;
          let asc = true;
          const run = () => {
            const out = righe.filter((r) => eqs.every(([c, v]) => val(r, c) === v) && (!gte || (val(r, gte[0]) ?? '') >= gte[1]));
            out.sort((a, b) => (asc ? a.id - b.id : b.id - a.id));
            return out;
          };
          const q: any = {
            eq(c: string, v: string) { eqs.push([c, String(v)]); return q; },
            gte(c: string, v: string) { gte = [c, v]; return q; },
            order(_c: string, o?: { ascending?: boolean }) { asc = o?.ascending !== false; return q; },
            limit(n: number) { return Promise.resolve({ data: run().slice(0, n) }); },
            maybeSingle() { return Promise.resolve({ data: run()[0] ?? null }); },
          };
          return q;
        },
      };
    },
  };
  return { supabase, righe, updates, aggiungi };
}

const fetchOk = () => vi.fn(async () => ({ ok: true, status: 200, text: async () => '', json: async () => ({}) }));
const corpi = (f: any) => f.mock.calls.map((c: any[]) => JSON.parse(c[1].body));

beforeEach(() => {
  vi.stubEnv('BOT_WEBHOOK_SECRET', 'test-secret');
  vi.stubEnv('GIUDICE_DISDETTE_ENABLED', '0');
  vi.stubGlobal('fetch', fetchOk());
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('prenotaNotaPerTipo — il lucchetto su event_log', () => {
  const base = { conversationId: 29516, crmLeadId: 'lead-1' };

  it('prima nota passa, seconda dello stesso tipo bloccata con evento nota_doppia_non_inviata', async () => {
    const { supabase, righe } = makeDb();
    expect((await prenotaNotaPerTipo(supabase, { ...base, note: DISDETTE_29516[0] })).ok).toBe(true);
    expect((await prenotaNotaPerTipo(supabase, { ...base, note: DISDETTE_29516[1] })).ok).toBe(false);
    const ev = righe.find((r) => r.type === 'nota_doppia_non_inviata');
    expect(ev.payload).toMatchObject({ conversationId: 29516, crmLeadId: 'lead-1', tipo: 'DISDETTA', paroleDelLead: 'Grazie' });
    // Il lucchetto del bloccato si toglie: ne resta uno solo.
    expect(righe.filter((r) => r.type === EVENTO_NOTA_TIPO)).toHaveLength(1);
  });

  it('tipo diverso passa (SPOSTAMENTO poi DISDETTA), data di spostamento diversa passa', async () => {
    const { supabase } = makeDb();
    expect((await prenotaNotaPerTipo(supabase, { ...base, note: SPOSTAMENTO_25581 })).ok).toBe(true);
    expect((await prenotaNotaPerTipo(supabase, { ...base, note: DISDETTE_29516[0] })).ok).toBe(true);
    expect((await prenotaNotaPerTipo(supabase, { ...base, note: SPOSTAMENTO_25581.replace('giovedì 29', 'venerdì 30') })).ok).toBe(true);
    expect((await prenotaNotaPerTipo(supabase, { ...base, note: SPOSTAMENTO_25581 })).ok).toBe(false);
  });

  it('un\'altra conversazione non è toccata', async () => {
    const { supabase } = makeDb();
    expect((await prenotaNotaPerTipo(supabase, { ...base, note: DA_RICHIAMARE_29654 })).ok).toBe(true);
    expect((await prenotaNotaPerTipo(supabase, { ...base, conversationId: 1, note: DA_RICHIAMARE_29654 })).ok).toBe(true);
  });

  it('dopo 2 ore la stessa nota ripassa', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-30T07:48:53Z'));
    const { supabase } = makeDb();
    expect((await prenotaNotaPerTipo(supabase, { ...base, note: DISDETTE_29516[0] })).ok).toBe(true);
    vi.setSystemTime(new Date(Date.now() + FINESTRA_NOTA_PER_TIPO_MS - 60_000));
    expect((await prenotaNotaPerTipo(supabase, { ...base, note: DISDETTE_29516[1] })).ok).toBe(false);
    vi.setSystemTime(new Date(Date.now() + 2 * 60_000));
    expect((await prenotaNotaPerTipo(supabase, { ...base, note: DISDETTE_29516[2] })).ok).toBe(true);
  });

  it('concorrenza: vince il lucchetto più vecchio', async () => {
    const { supabase, aggiungi } = makeDb();
    // Un altro messaggio ha già scritto il suo lucchetto (id più basso) ed è in volo.
    aggiungi({ type: EVENTO_NOTA_TIPO, payload: { conversationId: 29516, crmLeadId: 'lead-1', tipo: 'DISDETTA' } });
    expect((await prenotaNotaPerTipo(supabase, { ...base, note: DISDETTE_29516[0] })).ok).toBe(false);
  });

  it('se l\'invio fallisce e si rilascia, il messaggio successivo riprova', async () => {
    const { supabase } = makeDb();
    const p = await prenotaNotaPerTipo(supabase, { ...base, note: DISDETTE_29516[0] });
    expect(p.ok).toBe(true);
    if (p.ok) await p.rilascia();
    expect((await prenotaNotaPerTipo(supabase, { ...base, note: DISDETTE_29516[1] })).ok).toBe(true);
  });

  it('note senza tipo non scrivono nessun lucchetto', async () => {
    const { supabase, righe } = makeDb();
    expect((await prenotaNotaPerTipo(supabase, { ...base, note: 'Riscaldamento – budget e chi decide: «Io»' })).ok).toBe(true);
    expect(righe).toHaveLength(0);
  });
});

describe('le tre vie verso il CRM rispettano la regola', () => {
  const DATA_IN_AGENDA = '2026-10-30T17:00:00Z';

  it('ramo locked di sendOutcome: 8 DISDETTA in 7 minuti (conv 29516) → 1 sola nota al CRM', async () => {
    const { supabase, righe, updates } = makeDb({ crm_lead_id: 'lead-29516', bot_outcome: 'APPUNTAMENTO', bot_scheduled_at: DATA_IN_AGENDA });
    const parole = ['Ok', 'Grazie', 'A presto', 'si', 'va bene', 'ciao', 'grazie mille', 'ok ciao'];
    const esiti = [];
    for (const [i, p] of parole.entries()) {
      esiti.push(await sendOutcome(supabase, 29516, { outcome: 'DA_SCARTARE', discardReason: `situazione economica ${i}`, leadWords: p }));
    }
    expect((globalThis.fetch as any).mock.calls).toHaveLength(1);
    expect(esiti[0].sent).toBe(true);
    expect(esiti.slice(1).every((e) => e.error === 'note_duplicate')).toBe(true);
    expect(righe.filter((r) => r.type === 'nota_doppia_non_inviata')).toHaveLength(7);
    // Esito terminale: la conversazione si chiude anche quando la nota è bloccata.
    expect(updates.filter((u) => u.ai_status === 'closed').length).toBe(8);
  });

  it('ramo locked: SPOSTAMENTO poi DISDETTA passano entrambe', async () => {
    const { supabase } = makeDb({ crm_lead_id: 'lead-25581', bot_outcome: 'APPUNTAMENTO', bot_scheduled_at: DATA_IN_AGENDA });
    await sendOutcome(supabase, 25581, { outcome: 'RICHIAMO', date: '2026-11-02T15:00:00+01:00', leadWords: 'lunedì?' });
    await sendOutcome(supabase, 25581, { outcome: 'RICHIAMO', date: '2026-11-02T15:00:00+01:00', leadWords: 'ok' });
    await sendOutcome(supabase, 25581, { outcome: 'DA_SCARTARE', discardReason: 'non può', leadWords: 'annullo' });
    const note = corpi(globalThis.fetch).map((b: any) => b.note);
    expect(note).toHaveLength(2);
    expect(note[0]).toMatch(/^SPOSTAMENTO CHIESTO/);
    expect(note[1]).toMatch(/^DISDETTA/);
  });

  it('postino GDO (noteOnly): 5 SPOSTAMENTO alla stessa data in 2 minuti (conv 25581) → 1; data nuova → passa', async () => {
    const { supabase } = makeDb({ crm_lead_id: 'lead-25581', bot_outcome: null, bot_scheduled_at: null, gdo_appuntamento_at: DATA_IN_AGENDA });
    for (const p of ['giovedì alle 15?', 'ok', 'grazie', 'perfetto', 'a giovedì']) {
      await sendOutcome(supabase, 25581, { outcome: 'RICHIAMO', date: '2026-10-29T15:00:00+01:00', leadWords: p }, { noteOnly: true });
    }
    await sendOutcome(supabase, 25581, { outcome: 'RICHIAMO', date: '2026-10-30T17:00:00+01:00', leadWords: 'anzi venerdì' }, { noteOnly: true });
    const note = corpi(globalThis.fetch).map((b: any) => b.note);
    expect(note).toHaveLength(2);
    expect(note[0]).toContain('giovedì 29 ottobre alle 15:00');
    expect(note[1]).toContain('venerdì 30 ottobre alle 17:00');
  });

  it('inviaNotaAlCrm: 4 DA RICHIAMARE in 8 minuti (conv 29654) → 1; IL BOT HA RIPRESO LA CHAT non è toccata', async () => {
    const { supabase } = makeDb({ crm_lead_id: 'lead-29654' });
    for (let i = 0; i < 4; i++) await sendCrmNota(supabase, 29654, DA_RICHIAMARE_29654.replace('"ok"', `"ok ${i}"`));
    await sendCrmNota(supabase, 29654, 'IL BOT HA RIPRESO LA CHAT — IL LEAD HA RISCRITTO SU WHATSAPP: «ciao».');
    await sendCrmNota(supabase, 29654, 'IL BOT HA RIPRESO LA CHAT — IL LEAD HA RISCRITTO SU WHATSAPP: «ci sei?».');
    expect((globalThis.fetch as any).mock.calls).toHaveLength(3);
  });

  it('inviaNotaAlCrm: un invio fallito toglie il lucchetto e il messaggio dopo riprova', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'boom' })
      .mockResolvedValue({ ok: true, status: 200, text: async () => '' }));
    const { supabase } = makeDb({ crm_lead_id: 'lead-29654' });
    expect((await sendCrmNota(supabase, 29654, DA_RICHIAMARE_29654)).sent).toBe(false);
    expect((await sendCrmNota(supabase, 29654, DA_RICHIAMARE_29654)).sent).toBe(true);
    expect((await sendCrmNota(supabase, 29654, DA_RICHIAMARE_29654)).error).toBe('note_duplicate');
  });

  it('stesso tipo da un\'altra chat dello stesso lead: niente allungamento, il CRM la raggruppa', async () => {
    const { supabase } = makeDb({ crm_lead_id: 'lead-x' });
    await sendCrmNota(supabase, 1, DA_RICHIAMARE_29654);
    await sendCrmNota(supabase, 2, DA_RICHIAMARE_29654.replace('"ok"', '"grazie"'));
    const note = corpi(globalThis.fetch).map((b: any) => b.note);
    expect(note).toHaveLength(2);
    expect(crmDedupKey(note[1])).toBe(crmDedupKey(note[0]));
  });
});
