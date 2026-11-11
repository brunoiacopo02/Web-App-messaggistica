import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { enrollDatabaseLead, chiaveTelefono, depsDatabase, type DepsDatabase, type ChatDelNumero } from './database-enroll';
import { parseSettingsDatabase, scegliVariante, FUNNEL_CHAT_DATABASE, EVENTO_DATABASE_APERTURA, type VarianteDatabase } from './database-bot';
import { parseTettiNumeri } from './tetti-numeri';

const P = 'whatsapp:+393520413199';
const ELIXIR = 'whatsapp:+393522018718';
const N8061 = 'whatsapp:+393520158061';
const N0047 = 'whatsapp:+393522070047';
const SID: Record<VarianteDatabase, string> = { bf: 'HXbf', a: 'HXa', b: 'HXb', c: 'HXc', d: 'HXd' };
/** Giovedi' 12/11/2026 alle 10:00 di Roma: in fascia, Black Friday in corso. */
const ADESSO = Date.parse('2026-11-12T10:00:00+01:00');

type Mondo = {
  settings: unknown;
  nowMs: number;
  chat: ChatDelNumero | null;
  /** Aperture database gia' fatte oggi, per numero. */
  databaseOggi: Record<string, number>;
  conteggioDatabaseRotto?: boolean;
  tetti: Record<string, number> | null;
  aperture: Record<string, number | null>;
  /** numero → SID approvati; assente = tutti. */
  approvati?: Record<string, string[]>;
  senzaCredenziali?: string[];
  prossimaConv: number;
  /** Il numero con cui la chat risulta nata (default: quello chiesto). */
  waNumberAllaNascita?: string;
  invioOk: boolean;
  /** L'update del segno sulla chat fallisce. */
  segnoRotto?: boolean;
};

function mondo(o: Partial<Mondo> = {}) {
  const m: Mondo = {
    settings: { attivo: true },
    nowMs: ADESSO,
    chat: { esiste: false },
    databaseOggi: {},
    tetti: { [P]: 15, [ELIXIR]: 70, [N8061]: 70, [N0047]: 70 },
    aperture: {},
    prossimaConv: 50_000,
    invioOk: true,
    ...o,
  };
  const eventi: { type: string; level: string; payload: any }[] = [];
  const ordine: string[] = [];
  const chiamate = { ordine, creaChat: [] as any[], invia: [] as any[], aggiorna: [] as any[], registra: [] as any[], approvato: [] as [string, string][], leggiSettings: 0, chatDelNumero: 0 };
  const deps: DepsDatabase = {
    nowMs: () => m.nowMs,
    leggiSettings: async () => { chiamate.leggiSettings++; return parseSettingsDatabase(m.settings); },
    chatDelNumero: async () => { chiamate.chatDelNumero++; return m.chat; },
    contaDatabaseOggi: async (numero) => {
      if (m.conteggioDatabaseRotto) return null;
      return numero ? (m.databaseOggi[numero] ?? 0) : Object.values(m.databaseOggi).reduce((a, b) => a + b, 0);
    },
    numeri: () => [ELIXIR, N8061, N0047, P],
    tetti: async () => (m.tetti ? parseTettiNumeri(m.tetti) : null),
    apertureOggi: async (numero) => (numero in m.aperture ? m.aperture[numero] : 0),
    credenzialiOk: (numero) => !(m.senzaCredenziali ?? []).includes(numero),
    approvato: async (sid, numero) => {
      chiamate.approvato.push([sid, numero]);
      return m.approvati ? (m.approvati[numero] ?? []).includes(sid) : true;
    },
    creaChat: async (a) => { chiamate.creaChat.push(a); return { conversationId: m.prossimaConv, waNumber: m.waNumberAllaNascita ?? a.mittente }; },
    registraApertura: async (a) => { ordine.push('registra'); chiamate.registra.push(a); },
    invia: async (a) => { ordine.push('invia'); chiamate.invia.push(a); return m.invioOk ? { ok: true, sid: 'SM1' } : { ok: false, error: 'boom' }; },
    aggiornaChat: async (id, patch) => { ordine.push('segno'); chiamate.aggiorna.push({ id, patch }); return !m.segnoRotto; },
    log: async (type, level, payload) => { eventi.push({ type, level, payload }); },
  };
  return { m, deps, eventi, chiamate };
}

const ARGS = { phone: '+393331234567', firstName: 'Giulia Rossi', email: null, crmLeadId: 'lead-1', crmFunnel: 'Database' };
const enroll = (deps: DepsDatabase, args = ARGS) => enrollDatabaseLead({} as never, args, deps);

beforeEach(() => {
  vi.stubEnv('DATABASE_OPENING_SID_BF', SID.bf);
  vi.stubEnv('DATABASE_OPENING_SID_A', SID.a);
  vi.stubEnv('DATABASE_OPENING_SID_B', SID.b);
  vi.stubEnv('DATABASE_OPENING_SID_C', SID.c);
  vi.stubEnv('DATABASE_OPENING_SID_D', SID.d);
});
afterEach(() => { vi.unstubAllEnvs(); });

describe('interruttore spento (default)', () => {
  it.each([
    ['riga assente', undefined],
    ['attivo: false', { attivo: false }],
    ['valore sporco', 'si'],
  ])('%s: nessuna chat, nessun messaggio, il lead resta in coda al CRM', async (_n, settings) => {
    const { deps, chiamate, eventi } = mondo({ settings });
    const r = await enroll(deps);
    expect(r).toEqual({ tipo: 'rifiuto', motivo: 'database_non_aperto', dettaglio: 'spento' });
    expect(chiamate.creaChat).toHaveLength(0);
    expect(chiamate.invia).toHaveLength(0);
    expect(chiamate.aggiorna).toHaveLength(0);
    expect(chiamate.registra).toHaveLength(0);
    // Spento non legge nemmeno la chat ne' Twilio.
    expect(chiamate.chatDelNumero).toBe(0);
    expect(chiamate.approvato).toHaveLength(0);
    expect(eventi.map((e) => e.type)).toEqual(['database_intake_rifiutato']);
  });
});

describe('apertura', () => {
  it('apre col template database, firma la chat e registra variante e numero', async () => {
    const { deps, chiamate, eventi } = mondo({ prossimaConv: 50_002 });
    const r = await enroll(deps);
    const attesa = scegliVariante(50_002, ['bf', 'a', 'b', 'c', 'd']) as VarianteDatabase;
    expect(r).toMatchObject({ tipo: 'aperto', ok: true, conversationId: 50_002, variante: attesa, numero: ELIXIR });
    expect(chiamate.creaChat[0]).toMatchObject({ phone: ARGS.phone, mittente: ELIXIR });
    expect(chiamate.invia).toHaveLength(1);
    expect(chiamate.invia[0]).toMatchObject({ sid: SID[attesa], from: ELIXIR, nome: 'Giulia', etichetta: `Apertura database ${attesa}` });
    expect(chiamate.invia[0].testo.startsWith('Ciao Giulia, sono Marta di Fenice Academy.')).toBe(true);
    expect(chiamate.aggiorna[0].patch).toMatchObject({
      ai_owner: 'mario', ai_status: 'active', crm_lead_id: 'lead-1', crm_funnel: FUNNEL_CHAT_DATABASE,
    });
    // Conta nel tetto del numero come ogni apertura.
    expect(chiamate.registra[0]).toMatchObject({ numero: ELIXIR, conversationId: 50_002 });
    const ev = eventi.find((e) => e.type === EVENTO_DATABASE_APERTURA);
    expect(ev?.payload).toMatchObject({ conversationId: 50_002, numero: ELIXIR, variante: attesa, sid: SID[attesa], crmLeadId: 'lead-1', inviato: true });
  });

  it('le cinque varianti girano da subito: cinque chat consecutive, cinque varianti', async () => {
    const viste = new Set<string>();
    for (let id = 60_000; id < 60_005; id++) {
      const { deps } = mondo({ prossimaConv: id });
      const r = await enroll(deps);
      if (r.tipo === 'aperto') viste.add(r.variante);
    }
    expect([...viste].sort()).toEqual(['a', 'b', 'bf', 'c', 'd']);
  });

  it('una variante spenta dalla lista non esce piu\'', async () => {
    for (let id = 61_000; id < 61_010; id++) {
      const { deps } = mondo({ prossimaConv: id, settings: { attivo: true, varianti: ['a', 'c'] } });
      const r = await enroll(deps);
      expect(r.tipo === 'aperto' && ['a', 'c'].includes(r.variante)).toBe(true);
    }
  });

  it('dal 1/12/2026 la bf non esce piu\'', async () => {
    for (let id = 62_000; id < 62_010; id++) {
      const { deps } = mondo({ prossimaConv: id, nowMs: Date.parse('2026-12-01T10:00:00+01:00') });
      const r = await enroll(deps);
      expect(r.tipo === 'aperto' && r.variante !== 'bf').toBe(true);
    }
  });

  it('solo le varianti approvate sull\'account del numero', async () => {
    // Sul numero scelto Meta ha approvato solo la b e la d.
    const approvati = { [ELIXIR]: [SID.b, SID.d], [N8061]: [SID.b, SID.d], [N0047]: [SID.b, SID.d], [P]: [SID.b, SID.d] };
    for (let id = 63_000; id < 63_010; id++) {
      const { deps } = mondo({ prossimaConv: id, approvati });
      const r = await enroll(deps);
      expect(r.tipo === 'aperto' && ['b', 'd'].includes(r.variante)).toBe(true);
    }
  });

  it('invio fallito: la chat resta firmata e l\'apertura conta lo stesso nei tetti', async () => {
    const { deps, eventi } = mondo({ invioOk: false });
    const r = await enroll(deps);
    expect(r).toMatchObject({ tipo: 'aperto', ok: false, error: 'boom' });
    expect(eventi.find((e) => e.type === EVENTO_DATABASE_APERTURA)?.payload).toMatchObject({ inviato: false });
  });
});

describe('numero: tutti i numeri attivi, dentro i tetti', () => {
  it('vince il numero con meno aperture database oggi, poi quello con meno aperture', async () => {
    const a = mondo({ databaseOggi: { [ELIXIR]: 2, [N8061]: 1, [N0047]: 1, [P]: 1 }, aperture: { [N8061]: 40, [N0047]: 10, [P]: 12 } });
    expect(await enroll(a.deps)).toMatchObject({ tipo: 'aperto', numero: N0047 });
  });

  it('il primario entra nel giro come gli altri', async () => {
    const a = mondo({ databaseOggi: { [ELIXIR]: 1, [N8061]: 1, [N0047]: 1 } });
    expect(await enroll(a.deps)).toMatchObject({ tipo: 'aperto', numero: P });
  });

  it('30 lead si dividono su 4 numeri senza superare 6 a numero... e il resto aspetta', async () => {
    const databaseOggi: Record<string, number> = {};
    let aperti = 0, inAttesa = 0;
    for (let i = 0; i < 30; i++) {
      const { deps } = mondo({ databaseOggi, prossimaConv: 70_000 + i });
      const r = await enroll(deps);
      if (r.tipo === 'aperto') { aperti++; databaseOggi[r.numero] = (databaseOggi[r.numero] ?? 0) + 1; }
      else inAttesa++;
    }
    expect(databaseOggi).toEqual({ [ELIXIR]: 6, [N8061]: 6, [N0047]: 6, [P]: 6 });
    expect(aperti).toBe(24);
    expect(inAttesa).toBe(6);
  });

  it('tetto per numero impostabile', async () => {
    const { deps } = mondo({ settings: { attivo: true, tetto_numero: 2 }, databaseOggi: { [ELIXIR]: 2, [N8061]: 2, [N0047]: 2, [P]: 1 } });
    expect(await enroll(deps)).toMatchObject({ tipo: 'aperto', numero: P });
  });

  it('un numero a riposo (tetto 0 o assente) non apre', async () => {
    const { deps } = mondo({ tetti: { [N0047]: 70 } });
    expect(await enroll(deps)).toMatchObject({ tipo: 'aperto', numero: N0047 });
  });

  it('un numero al suo tetto di aperture non apre: nessun trabocco per il database', async () => {
    const { deps, chiamate } = mondo({ aperture: { [ELIXIR]: 70, [N8061]: 70, [N0047]: 70, [P]: 15 } });
    expect(await enroll(deps)).toMatchObject({ tipo: 'rifiuto', motivo: 'database_non_aperto', dettaglio: 'nessun_numero' });
    expect(chiamate.creaChat).toHaveLength(0);
    expect(chiamate.invia).toHaveLength(0);
  });

  it('conteggio fallito o credenziali mancanti = numero escluso', async () => {
    const { deps } = mondo({ aperture: { [ELIXIR]: null }, senzaCredenziali: [N8061] });
    expect(await enroll(deps)).toMatchObject({ tipo: 'aperto', numero: N0047 });
  });

  it('nessun template approvato su un numero: si passa al successivo', async () => {
    const { deps } = mondo({ approvati: { [N0047]: [SID.a] } });
    expect(await enroll(deps)).toMatchObject({ tipo: 'aperto', numero: N0047, variante: 'a' });
  });

  it('nessun template approvato da nessuna parte: nessuna chat, il lead aspetta', async () => {
    const { deps, chiamate } = mondo({ approvati: {} });
    expect(await enroll(deps)).toMatchObject({ tipo: 'rifiuto', motivo: 'database_non_aperto', dettaglio: 'nessun_numero' });
    expect(chiamate.creaChat).toHaveLength(0);
  });
});

describe('tetto giornaliero complessivo', () => {
  it('default 30: il trentunesimo aspetta', async () => {
    const pieno = mondo({ databaseOggi: { [ELIXIR]: 6, [N8061]: 6, [N0047]: 6, [P]: 6, altro: 6 } });
    expect(await enroll(pieno.deps)).toMatchObject({ tipo: 'rifiuto', motivo: 'database_non_aperto', dettaglio: 'tetto_giorno' });
    expect(pieno.chiamate.creaChat).toHaveLength(0);
  });

  it('impostabile', async () => {
    const { deps } = mondo({ settings: { attivo: true, tetto_giorno: 3 }, databaseOggi: { [ELIXIR]: 3 } });
    expect(await enroll(deps)).toMatchObject({ tipo: 'rifiuto', dettaglio: 'tetto_giorno' });
  });

  it('fallisce chiuso: conteggio o tetti illeggibili = non si apre', async () => {
    expect(await enroll(mondo({ conteggioDatabaseRotto: true }).deps)).toMatchObject({ tipo: 'rifiuto', dettaglio: 'conteggio_fallito' });
    expect(await enroll(mondo({ tetti: null }).deps)).toMatchObject({ tipo: 'rifiuto', dettaglio: 'tetti_illeggibili' });
  });
});

describe('un solo messaggio a persona', () => {
  it('il numero ha gia\' una chat col bot: nessuna apertura, rifiuto definitivo', async () => {
    const { deps, chiamate } = mondo({ chat: { esiste: true, conversationId: 123, crmLeadId: 'lead-vecchio', crmFunnel: 'TELEGRAM' } });
    expect(await enroll(deps)).toEqual({ tipo: 'rifiuto', motivo: 'database_chat_esistente', dettaglio: 'chat_esistente', conversationId: 123 });
    expect(chiamate.invia).toHaveLength(0);
    expect(chiamate.aggiorna).toHaveLength(0);
  });

  it('ritento dello stesso intake: duplicato, nessun secondo messaggio', async () => {
    const { deps, chiamate } = mondo({ chat: { esiste: true, conversationId: 123, crmLeadId: 'lead-1', crmFunnel: FUNNEL_CHAT_DATABASE } });
    expect(await enroll(deps)).toEqual({ tipo: 'duplicato', conversationId: 123 });
    expect(chiamate.invia).toHaveLength(0);
  });

  it('lettura della chat fallita: non si apre', async () => {
    const { deps, chiamate } = mondo({ chat: null });
    expect(await enroll(deps)).toMatchObject({ tipo: 'rifiuto', motivo: 'database_non_aperto', dettaglio: 'lettura_chat_fallita' });
    expect(chiamate.invia).toHaveLength(0);
  });

  it('chat nata nel frattempo su un altro numero: nessuna apertura', async () => {
    const { deps, chiamate } = mondo({ waNumberAllaNascita: N8061 });
    expect(await enroll(deps)).toMatchObject({ tipo: 'rifiuto', motivo: 'database_chat_esistente' });
    expect(chiamate.invia).toHaveLength(0);
  });
});

describe('fascia e configurazione', () => {
  it('fuori dalla fascia 07-23 non si apre e non si differisce', async () => {
    const { deps, chiamate } = mondo({ nowMs: Date.parse('2026-11-12T23:30:00+01:00') });
    expect(await enroll(deps)).toMatchObject({ tipo: 'rifiuto', dettaglio: 'fuori_fascia' });
    expect(chiamate.creaChat).toHaveLength(0);
  });

  it('nessun SID in env: nessuna variante, non si apre', async () => {
    vi.unstubAllEnvs();
    for (const k of ['BF', 'A', 'B', 'C', 'D']) vi.stubEnv(`DATABASE_OPENING_SID_${k}`, '');
    const { deps, chiamate } = mondo();
    expect(await enroll(deps)).toMatchObject({ tipo: 'rifiuto', dettaglio: 'nessuna_variante' });
    expect(chiamate.creaChat).toHaveLength(0);
  });
});

describe("segno sulla chat prima dell'invio (revisione 11/11/2026)", () => {
  it("la chat e' firmata (crm_lead_id, DATABASE BOT, ai_owner) PRIMA dell'apertura", async () => {
    const { deps, chiamate } = mondo();
    await enroll(deps);
    expect(chiamate.ordine).toEqual(['segno', 'registra', 'invia']);
  });

  it("se il segno non si scrive non parte niente e il CRM riprova piu' tardi", async () => {
    const { deps, chiamate } = mondo({ segnoRotto: true });
    expect(await enroll(deps)).toMatchObject({ tipo: 'rifiuto', motivo: 'database_non_aperto', dettaglio: 'segno_non_scritto' });
    expect(chiamate.invia).toHaveLength(0);
    expect(chiamate.registra).toHaveLength(0);
  });
});

describe("numero normalizzato (PO 11/11/2026)", () => {
  it("chiave: ultime 10 cifre, qualunque sia la scrittura", () => {
    expect(chiaveTelefono('+393331234567')).toBe('3331234567');
    expect(chiaveTelefono('333 123 4567')).toBe('3331234567');
    expect(chiaveTelefono('0039 333-1234567')).toBe('3331234567');
    expect(chiaveTelefono('12345')).toBeNull();
  });

  // Finto PostgREST: due schede del bot per la stessa persona, scritte diverse.
  function supa(leadsDb: { id: number; phone_e164: string }[], convs: { id: number; lead_id: number; crm_lead_id: string | null; crm_funnel: string | null }[]) {
    const filtri: string[] = [];
    return {
      filtri,
      from(t: string) {
        if (t === 'leads') {
          const b: any = {
            select: () => b,
            like: (_c: string, pat: string) => { filtri.push(`like ${pat}`); b._rows = leadsDb.filter((l) => l.phone_e164.endsWith(pat.replace('%', ''))); return b; },
            eq: (_c: string, v: string) => { filtri.push(`eq ${v}`); b._rows = leadsDb.filter((l) => l.phone_e164 === v); return b; },
            limit: async () => ({ data: b._rows, error: null }),
          };
          return b;
        }
        const c: any = {
          select: () => c,
          in: (_c: string, ids: number[]) => { c._rows = convs.filter((x) => ids.includes(x.lead_id)); return c; },
          order: () => c,
          limit: async () => ({ data: c._rows, error: null }),
        };
        return c;
      },
    };
  }

  it("la chat esistente si trova anche se la scheda del bot ha il numero scritto in un altro modo", async () => {
    const s = supa([{ id: 7, phone_e164: '+393331234567' }], [{ id: 70, lead_id: 7, crm_lead_id: 'altro', crm_funnel: 'TELEGRAM' }]);
    const r = await depsDatabase(s as never).chatDelNumero('+39 333 1234567');
    expect(s.filtri).toEqual(['like %3331234567']);
    expect(r).toEqual({ esiste: true, conversationId: 70, crmLeadId: 'altro', crmFunnel: 'TELEGRAM' });
  });

  it("fra piu' chat della stessa persona vince quella del giro database (ritento riconoscibile)", async () => {
    const s = supa(
      [{ id: 7, phone_e164: '+393331234567' }, { id: 8, phone_e164: '+3903331234567' }],
      [{ id: 70, lead_id: 7, crm_lead_id: 'altro', crm_funnel: 'TELEGRAM' }, { id: 80, lead_id: 8, crm_lead_id: 'lead-1', crm_funnel: FUNNEL_CHAT_DATABASE }],
    );
    expect(await depsDatabase(s as never).chatDelNumero('+393331234567')).toMatchObject({ conversationId: 80, crmLeadId: 'lead-1' });
  });

  it("nessuna scheda con quelle cifre: nessuna chat", async () => {
    const s = supa([{ id: 7, phone_e164: '+393339999999' }], []);
    expect(await depsDatabase(s as never).chatDelNumero('+393331234567')).toEqual({ esiste: false });
  });
});
