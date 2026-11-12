import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { enrollDatabaseLead, chiaveTelefono, depsDatabase, type DepsDatabase, type ChatDelNumero } from './database-enroll';
import { parseSettingsDatabase, scegliVariante, motivoChatNonRiapribile, FUNNEL_CHAT_DATABASE, EVENTO_DATABASE_APERTURA, type VarianteDatabase, type StatoChatEsistente } from './database-bot';
import { parseTettiNumeri, type StatoQualitaLetto } from './tetti-numeri';
import { giornoRoma } from './qualita-numeri';

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
  /** Stato della chat esistente (riapertura). */
  stato?: Partial<StatoChatEsistente> | null;
  riaperteOggi?: number;
  /** Stato del cron qualita-numeri; assente = tutti HIGH oggi e nessuna pausa. */
  qualita?: StatoQualitaLetto | null;
};

/** Stato qualita' con la lettura di oggi per ogni numero (default HIGH). */
function qualitaOggi(nowMs: number, letture: Record<string, string> = {}, pause: Record<string, unknown> = {}): StatoQualitaLetto {
  const oggi = giornoRoma(new Date(nowMs));
  const storico: Record<string, Record<string, string>> = {};
  for (const n of [ELIXIR, N8061, N0047, P]) storico[n.replace('whatsapp:', '')] = { [oggi]: letture[n] ?? 'HIGH' };
  return { storico, pause };
}
const senzaPrefisso = (n: string) => n.replace('whatsapp:', '');

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
    statoChat: async () => (m.stato === null ? null : {
      waNumber: N0047, ultimoMessaggioMs: m.nowMs - 40 * 24 * 3600_000, pausata: false, chatGdo: false, lancioInCorso: false,
      botOutcome: 'NON_RISPOSTO', botOutcomeMs: m.nowMs - 40 * 24 * 3600_000, optOut: false, senzaWhatsapp: false, haRisposto: true, ...(m.stato ?? {}),
    }),
    contaRiapertureOggi: async () => m.riaperteOggi ?? 0,
    contaDatabaseOggi: async (numero) => {
      if (m.conteggioDatabaseRotto) return null;
      return numero ? (m.databaseOggi[numero] ?? 0) : Object.values(m.databaseOggi).reduce((a, b) => a + b, 0);
    },
    numeri: () => [ELIXIR, N8061, N0047, P],
    tetti: async () => (m.tetti ? parseTettiNumeri(m.tetti) : null),
    statoQualita: async () => (m.qualita === undefined ? qualitaOggi(m.nowMs) : m.qualita),
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

describe("fuori tetto e numeri espliciti (PO 11/11/2026: 5 a numero, al di la' del tetto)", () => {
  it('fuori_tetto: un numero sano pieno apre lo stesso, fino a tetto_numero; il primario senza voce no', async () => {
    // Tutti i numeri pieni e il primario senza voce: dentro i tetti nessuno aprirebbe.
    const base = { aperture: { [ELIXIR]: 70, [N8061]: 70, [N0047]: 70 }, tetti: { [ELIXIR]: 70, [N8061]: 70, [N0047]: 70 } };
    expect(await enroll(mondo(base).deps)).toMatchObject({ tipo: 'rifiuto', dettaglio: 'nessun_numero' });
    const { deps } = mondo({ ...base, settings: { attivo: true, fuori_tetto: true, tetto_numero: 5 } });
    const r = await enroll(deps);
    expect(r).toMatchObject({ tipo: 'aperto' });
    expect(r.tipo === 'aperto' ? r.numero : null).not.toBe(P);
  });

  // Revisione 11/11/2026: `fuori_tetto` vale solo come "oltre il tetto quotidiano di un
  // numero sano". Col codice di prima questi numeri aprivano lo stesso.
  const FUORI = { attivo: true, fuori_tetto: true, tetto_numero: 5 };
  const PIENI = { [ELIXIR]: 70, [N8061]: 70, [N0047]: 70, [P]: 15 };

  it('fuori_tetto non usa un numero a riposo (tetto 0 o assente in tetti_numeri)', async () => {
    const { deps, chiamate } = mondo({ settings: FUORI, tetti: { [ELIXIR]: 0 } });
    expect(await enroll(deps)).toMatchObject({ tipo: 'rifiuto', motivo: 'database_non_aperto', dettaglio: 'nessun_numero' });
    expect(chiamate.creaChat).toHaveLength(0);
    expect(chiamate.invia).toHaveLength(0);
  });

  it('fuori_tetto non usa un numero in pausa qualita', async () => {
    const tre = Object.fromEntries([ELIXIR, N8061, P].map((n) => [senzaPrefisso(n), { dal: 'ieri' }]));
    const { deps } = mondo({ settings: FUORI, aperture: PIENI, qualita: qualitaOggi(ADESSO, {}, tre) });
    expect(await enroll(deps)).toMatchObject({ tipo: 'aperto', numero: N0047 });
    const tutti = Object.fromEntries([ELIXIR, N8061, N0047, P].map((n) => [senzaPrefisso(n), true]));
    const x = mondo({ settings: FUORI, aperture: PIENI, qualita: qualitaOggi(ADESSO, {}, tutti) });
    expect(await enroll(x.deps)).toMatchObject({ tipo: 'rifiuto', dettaglio: 'nessun_numero' });
    expect(x.chiamate.invia).toHaveLength(0);
  });

  it('fuori_tetto non usa un numero non HIGH (MEDIUM, LOW, lettura mancante)', async () => {
    const qualita = qualitaOggi(ADESSO, { [ELIXIR]: 'MEDIUM', [N8061]: 'LOW', [P]: 'UNKNOWN' });
    const { deps } = mondo({ settings: FUORI, aperture: PIENI, qualita });
    expect(await enroll(deps)).toMatchObject({ tipo: 'aperto', numero: N0047 });
    const nessuno = mondo({ settings: FUORI, aperture: PIENI, qualita: { storico: {}, pause: {} } });
    expect(await enroll(nessuno.deps)).toMatchObject({ tipo: 'rifiuto', dettaglio: 'nessun_numero' });
    expect(nessuno.chiamate.invia).toHaveLength(0);
  });

  it('anche dentro i tetti un numero non HIGH o in pausa non apre; stato illeggibile = nessuno apre', async () => {
    const qualita = qualitaOggi(ADESSO, { [ELIXIR]: 'MEDIUM', [N8061]: 'MEDIUM', [P]: 'LOW' });
    expect(await enroll(mondo({ qualita }).deps)).toMatchObject({ tipo: 'aperto', numero: N0047 });
    const rotto = mondo({ qualita: null });
    expect(await enroll(rotto.deps)).toMatchObject({ tipo: 'rifiuto', motivo: 'database_non_aperto', dettaglio: 'qualita_illeggibile' });
    expect(rotto.chiamate.creaChat).toHaveLength(0);
  });

  it('fuori_tetto non scavalca tetto_numero', async () => {
    const tutti5 = { [ELIXIR]: 5, [N8061]: 5, [N0047]: 5, [P]: 5 };
    const { deps, chiamate } = mondo({ databaseOggi: tutti5, settings: { attivo: true, fuori_tetto: true, tetto_numero: 5, tetto_giorno: 30 } });
    expect(await enroll(deps)).toMatchObject({ tipo: 'rifiuto', dettaglio: 'nessun_numero' });
    expect(chiamate.invia).toHaveLength(0);
  });

  it('30 lead, 5 a numero sui numeri elencati, anche se tutti pieni di aperture di Mario', async () => {
    const numeri = [ELIXIR, N8061, N0047, P];
    const oggi: Record<string, number> = {};
    let aperti = 0;
    for (let i = 0; i < 30; i++) {
      const { deps } = mondo({
        prossimaConv: 70_000 + i, databaseOggi: { ...oggi }, aperture: { [ELIXIR]: 70, [N8061]: 70, [N0047]: 70, [P]: 15 },
        settings: { attivo: true, fuori_tetto: true, tetto_numero: 5, tetto_giorno: 30, numeri: numeri.map((n) => n.replace('whatsapp:', '')) },
      });
      const r = await enroll(deps);
      if (r.tipo === 'aperto') { aperti++; oggi[r.numero] = (oggi[r.numero] ?? 0) + 1; }
    }
    expect(aperti).toBe(20);
    expect(Object.values(oggi)).toEqual([5, 5, 5, 5]);
  });

  it('numeri: solo quelli elencati; lista vuota = nessun numero', async () => {
    const solo = mondo({ settings: { attivo: true, numeri: ['+393522070047'] } });
    expect(await enroll(solo.deps)).toMatchObject({ tipo: 'aperto', numero: N0047 });
    const vuota = mondo({ settings: { attivo: true, numeri: [] } });
    expect(await enroll(vuota.deps)).toMatchObject({ tipo: 'rifiuto', dettaglio: 'nessun_numero' });
  });

  it('senza le due opzioni tutto come prima', () => {
    expect(parseSettingsDatabase({ attivo: true })).toMatchObject({ fuoriTetto: false, numeri: null });
    expect(parseSettingsDatabase({ attivo: true, fuori_tetto: 'si' }).fuoriTetto).toBe(false);
  });
});

describe("riapertura di una chat ferma: la strada principale per i lead di database (PO 11/11/2026)", () => {
  const VECCHIA = { esiste: true as const, conversationId: 900, crmLeadId: 'lead-vecchio', crmFunnel: 'CORSO 10 ORE' };
  const ACCESO = { attivo: true, giorni_fermo: 14 };
  const GIORNO = 24 * 3600_000;

  it("senza giorni_fermo una chat esistente resta un rifiuto definitivo (come prima)", async () => {
    const { deps, chiamate } = mondo({ chat: VECCHIA });
    expect(await enroll(deps)).toMatchObject({ tipo: 'rifiuto', motivo: 'database_chat_esistente', dettaglio: 'chat_esistente' });
    expect(chiamate.invia).toHaveLength(0);
  });

  it("chat ferma da 40 giorni: si riapre SUL SUO numero, un solo messaggio, niente chat nuova", async () => {
    const { deps, chiamate, eventi } = mondo({ chat: VECCHIA, settings: ACCESO });
    const r = await enroll(deps);
    expect(r).toMatchObject({ tipo: 'aperto', ok: true, conversationId: 900, numero: N0047 });
    expect(chiamate.creaChat).toHaveLength(0);
    expect(chiamate.invia).toHaveLength(1);
    expect(chiamate.invia[0]).toMatchObject({ from: N0047, conversationId: 900 });
    expect(chiamate.ordine).toEqual(['segno', 'registra', 'invia']);
    expect(chiamate.aggiorna[0].patch).toMatchObject({
      crm_lead_id: 'lead-1', crm_funnel: FUNNEL_CHAT_DATABASE, ai_owner: 'mario', ai_status: 'active',
      bot_outcome: null, bot_outcome_at: null, bot_followups_sent: 0, handed_off_at: null,
      // PO 12/11/2026: il marcatore della call vecchia (disdetta o attesa «riscrivo io») non spegne i promemoria di un appuntamento nuovo.
      cancel_requested_at: null,
    });
    expect(chiamate.aggiorna[0].patch.ai_started_at).toBeTruthy();
    expect(eventi.find((e) => e.type === EVENTO_DATABASE_APERTURA)?.payload).toMatchObject({ riaperta: true, esitoPrima: 'NON_RISPOSTO', numero: N0047 });
  });

  it("il ritento dello stesso intake dopo la riapertura e' un duplicato: nessun secondo messaggio", async () => {
    const { deps, chiamate } = mondo({ chat: { esiste: true, conversationId: 900, crmLeadId: 'lead-1', crmFunnel: FUNNEL_CHAT_DATABASE }, settings: ACCESO });
    expect(await enroll(deps)).toEqual({ tipo: 'duplicato', conversationId: 900 });
    expect(chiamate.invia).toHaveLength(0);
  });

  it("una chat gia' aperta dal database per un altro lead della stessa persona non si riapre", async () => {
    const { deps, chiamate } = mondo({ chat: { ...VECCHIA, crmFunnel: FUNNEL_CHAT_DATABASE }, settings: ACCESO });
    expect(await enroll(deps)).toMatchObject({ tipo: 'rifiuto', motivo: 'database_chat_esistente', dettaglio: 'gia_aperta_dal_database' });
    expect(chiamate.invia).toHaveLength(0);
  });

  it("chat viva (ultimo messaggio 5 giorni fa): riprova questo lead piu' avanti, il giro continua", async () => {
    const { deps, chiamate } = mondo({ chat: VECCHIA, settings: ACCESO, stato: { ultimoMessaggioMs: ADESSO - 5 * GIORNO } });
    expect(await enroll(deps)).toMatchObject({ tipo: 'rifiuto', motivo: 'database_chat_attiva', dettaglio: 'chat_attiva' });
    expect(chiamate.invia).toHaveLength(0);
    expect(chiamate.aggiorna).toHaveLength(0);
  });

  it.each([
    ['opt_out', { optOut: true }],
    ['pausa_manuale', { pausata: true }],
    ['senza_whatsapp', { senzaWhatsapp: true }],
    ['chat_gdo', { chatGdo: true }],
    ['lancio_in_corso', { lancioInCorso: true }],
    ['scartata_dal_bot', { botOutcome: 'DA_SCARTARE' }],
  ])("%s: mai riaperta, rifiuto definitivo", async (dettaglio, stato) => {
    const { deps, chiamate } = mondo({ chat: VECCHIA, settings: ACCESO, stato });
    expect(await enroll(deps)).toMatchObject({ tipo: 'rifiuto', motivo: 'database_chat_esistente', dettaglio });
    expect(chiamate.invia).toHaveLength(0);
  });

  it("stato della chat illeggibile: non si apre (fallisce chiuso)", async () => {
    const { deps, chiamate } = mondo({ chat: VECCHIA, settings: ACCESO, stato: null });
    expect(await enroll(deps)).toMatchObject({ tipo: 'rifiuto', motivo: 'database_non_aperto', dettaglio: 'lettura_chat_fallita' });
    expect(chiamate.invia).toHaveLength(0);
  });

  // Revisione 11/11/2026: il numero della chat non disponibile e' un problema di QUESTO
  // lead. `database_chat_attiva` = il CRM salta solo lui (il giro continua) e lo ripropone;
  // col vecchio `database_non_aperto` il CRM fermava tutta la coda.
  const SALTA_SOLO_LUI = { tipo: 'rifiuto', motivo: 'database_chat_attiva', dettaglio: 'numero_chat_non_disponibile', conversationId: 900 };

  it("il numero della chat e' pieno o fuori dal giro: non si sposta su un altro numero, si salta solo questo lead", async () => {
    const pieno = mondo({ chat: VECCHIA, settings: ACCESO, aperture: { [N0047]: 70 } });
    expect(await enroll(pieno.deps)).toEqual(SALTA_SOLO_LUI);
    expect(pieno.chiamate.invia).toHaveLength(0);
    expect(pieno.chiamate.aggiorna).toHaveLength(0);
    const fuori = mondo({ chat: VECCHIA, settings: { ...ACCESO, numeri: ['393522018718'] } });
    expect(await enroll(fuori.deps)).toEqual(SALTA_SOLO_LUI);
    expect(fuori.chiamate.invia).toHaveLength(0);
    // Con fuori_tetto il numero pieno (ma sano) apre lo stesso.
    const fuoriTetto = mondo({ chat: VECCHIA, settings: { ...ACCESO, fuori_tetto: true }, aperture: { [N0047]: 70 } });
    expect(await enroll(fuoriTetto.deps)).toMatchObject({ tipo: 'aperto', numero: N0047 });
  });

  it("riapertura con fuori_tetto: il numero della chat a riposo, in pausa o non HIGH non apre; si salta solo questo lead", async () => {
    const F = { ...ACCESO, fuori_tetto: true };
    const riposo = mondo({ chat: VECCHIA, settings: F, tetti: { [ELIXIR]: 70, [N0047]: 0 } });
    expect(await enroll(riposo.deps)).toEqual(SALTA_SOLO_LUI);
    const pausa = mondo({ chat: VECCHIA, settings: F, qualita: qualitaOggi(ADESSO, {}, { [senzaPrefisso(N0047)]: true }) });
    expect(await enroll(pausa.deps)).toEqual(SALTA_SOLO_LUI);
    const medium = mondo({ chat: VECCHIA, settings: F, qualita: qualitaOggi(ADESSO, { [N0047]: 'MEDIUM' }) });
    expect(await enroll(medium.deps)).toEqual(SALTA_SOLO_LUI);
    for (const x of [riposo, pausa, medium]) {
      expect(x.chiamate.invia).toHaveLength(0);
      expect(x.chiamate.aggiorna).toHaveLength(0);
      expect(x.chiamate.registra).toHaveLength(0);
    }
  });

  it("quota delle riaperture piena: questo lead aspetta, il giro continua; le chat nuove non contano", async () => {
    const { deps, chiamate } = mondo({ chat: VECCHIA, settings: { ...ACCESO, riaperture_max_giorno: 10 }, riaperteOggi: 10 });
    expect(await enroll(deps)).toMatchObject({ tipo: 'rifiuto', motivo: 'database_chat_attiva', dettaglio: 'tetto_riaperture' });
    expect(chiamate.invia).toHaveLength(0);
    const nuova = mondo({ settings: { ...ACCESO, riaperture_max_giorno: 10 }, riaperteOggi: 10 });
    expect(await enroll(nuova.deps)).toMatchObject({ tipo: 'aperto' });
  });

  it("varianti_riapertura: sulle chat riaperte solo le varianti scelte", async () => {
    for (let id = 0; id < 5; id++) {
      const { deps } = mondo({ chat: { ...VECCHIA, conversationId: 900 + id }, settings: { ...ACCESO, varianti_riapertura: ['a'] } });
      expect(await enroll(deps)).toMatchObject({ tipo: 'aperto', variante: 'a' });
    }
  });

  it("solo_chi_ha_risposto: la chat di chi non ci ha mai scritto non si riapre", async () => {
    const no = mondo({ chat: VECCHIA, settings: { ...ACCESO, solo_chi_ha_risposto: true }, stato: { haRisposto: false } });
    expect(await enroll(no.deps)).toMatchObject({ tipo: 'rifiuto', motivo: 'database_chat_esistente', dettaglio: 'mai_risposto' });
    expect(no.chiamate.invia).toHaveLength(0);
    const si = mondo({ chat: VECCHIA, settings: { ...ACCESO, solo_chi_ha_risposto: true }, stato: { haRisposto: true } });
    expect(await enroll(si.deps)).toMatchObject({ tipo: 'aperto' });
    // Senza l'opzione la chat senza risposta si riapre (scelta di Bruno).
    const senza = mondo({ chat: VECCHIA, settings: ACCESO, stato: { haRisposto: false } });
    expect(await enroll(senza.deps)).toMatchObject({ tipo: 'aperto' });
  });

  it("regola pura: un APPUNTAMENTO del bot recente tiene la chat viva; vecchio no", () => {
    const s = {
      waNumber: N0047, ultimoMessaggioMs: ADESSO - 40 * GIORNO, pausata: false, chatGdo: false, lancioInCorso: false,
      botOutcome: 'APPUNTAMENTO', botOutcomeMs: ADESSO - 3 * GIORNO, optOut: false, senzaWhatsapp: false, haRisposto: false,
    };
    expect(motivoChatNonRiapribile(s, { nowMs: ADESSO, giorni: 14 })).toBe('chat_attiva');
    expect(motivoChatNonRiapribile({ ...s, botOutcomeMs: ADESSO - 40 * GIORNO }, { nowMs: ADESSO, giorni: 14 })).toBeNull();
  });

  it("impostazioni: giorni_fermo, riaperture_max_giorno, varianti_riapertura; assenti = come prima", () => {
    expect(parseSettingsDatabase({ attivo: true })).toMatchObject({ riprendiChatDopoGiorni: null, riapertureMaxGiorno: null, variantiRiapertura: null });
    expect(parseSettingsDatabase({ attivo: true, giorni_fermo: 14, riaperture_max_giorno: 10, varianti_riapertura: ['A', 'x'] }))
      .toMatchObject({ riprendiChatDopoGiorni: 14, riapertureMaxGiorno: 10, variantiRiapertura: ['a'] });
    expect(parseSettingsDatabase({ attivo: true, giorni_fermo: 0 }).riprendiChatDopoGiorni).toBeNull();
  });
});

describe("riapri_tutti: scrivere a tutti (PO 12/11/2026)", () => {
  const VECCHIA = { esiste: true as const, conversationId: 900, crmLeadId: 'lead-vecchio', crmFunnel: 'CORSO 10 ORE' };
  const TUTTI = { attivo: true, giorni_fermo: 7, riapri_tutti: true };

  it("assente = come prima; si legge solo il true esplicito", () => {
    expect(parseSettingsDatabase({ attivo: true }).riapriTutti).toBe(false);
    expect(parseSettingsDatabase({ attivo: true, riapri_tutti: 'true' }).riapriTutti).toBe(false);
    expect(parseSettingsDatabase(TUTTI).riapriTutti).toBe(true);
  });

  it.each([
    ['in pausa', { pausata: true }],
    ['di un GDO', { chatGdo: true }],
    ['del lancio rimasta a meta', { lancioInCorso: true }],
    ['scartata dal bot', { botOutcome: 'DA_SCARTARE' }],
  ])("chat %s: si riapre, e si toglie cio' che terrebbe Marta zitta", async (_n, stato) => {
    const { deps, chiamate } = mondo({ chat: VECCHIA, settings: TUTTI, stato });
    expect(await enroll(deps)).toMatchObject({ tipo: 'aperto', ok: true, conversationId: 900, numero: N0047, riaperta: true });
    expect(chiamate.creaChat).toHaveLength(0);
    expect(chiamate.invia).toHaveLength(1);
    const patch = chiamate.aggiorna[0].patch;
    expect(patch).toMatchObject({ ai_paused_at: null, gdo_agenda_at: null, ai_status: 'active', crm_funnel: FUNNEL_CHAT_DATABASE });
    expect('lancio_fase' in patch).toBe((stato as Partial<StatoChatEsistente>).lancioInCorso === true);
    // Il numero della chat puo' aprire: resta li', `wa_number` non si tocca.
    expect('wa_number' in patch).toBe(false);
  });

  it.each([
    ['opt_out', { optOut: true }],
    ['senza_whatsapp', { senzaWhatsapp: true }],
    ['gia_apertura_bf', { giaAperturaBf: true }],
  ])("%s: resta fuori per sempre anche con riapri_tutti", async (dettaglio, stato) => {
    const { deps, chiamate } = mondo({ chat: VECCHIA, settings: TUTTI, stato });
    expect(await enroll(deps)).toMatchObject({ tipo: 'rifiuto', motivo: 'database_chat_esistente', dettaglio });
    expect(chiamate.invia).toHaveLength(0);
    expect(chiamate.aggiorna).toHaveLength(0);
  });

  it("apertura Black Friday gia' ricevuta: fuori anche senza riapri_tutti (mai due volte)", async () => {
    const { deps, chiamate } = mondo({ chat: VECCHIA, settings: { attivo: true, giorni_fermo: 7 }, stato: { giaAperturaBf: true } });
    expect(await enroll(deps)).toMatchObject({ tipo: 'rifiuto', motivo: 'database_chat_esistente', dettaglio: 'gia_apertura_bf' });
    expect(chiamate.invia).toHaveLength(0);
  });

  it("chat viva (ha scritto 3 giorni fa): non si forza, si riprova piu' avanti", async () => {
    const { deps, chiamate } = mondo({ chat: VECCHIA, settings: TUTTI, stato: { pausata: true, ultimoMessaggioMs: ADESSO - 3 * 24 * 3600_000 } });
    expect(await enroll(deps)).toMatchObject({ tipo: 'rifiuto', motivo: 'database_chat_attiva', dettaglio: 'chat_attiva' });
    expect(chiamate.invia).toHaveLength(0);
  });

  it.each([
    ['a riposo (nessun tetto)', { tetti: { [ELIXIR]: 70, [N8061]: 70 } }],
    ['non HIGH', { qualita: qualitaOggi(ADESSO, { [N0047]: 'LOW' }) }],
    ['pieno', { aperture: { [N0047]: 70 } }],
  ])("numero della chat %s: l'apertura parte da un numero del giro e la chat lo segue", async (_n, extra) => {
    const { deps, chiamate, eventi } = mondo({ chat: VECCHIA, settings: TUTTI, ...extra });
    const r = await enroll(deps);
    expect(r).toMatchObject({ tipo: 'aperto', ok: true, conversationId: 900, numero: ELIXIR });
    expect(chiamate.creaChat).toHaveLength(0);
    expect(chiamate.invia[0]).toMatchObject({ from: ELIXIR, conversationId: 900 });
    expect(chiamate.aggiorna[0].patch).toMatchObject({ wa_number: ELIXIR });
    expect(chiamate.registra[0]).toMatchObject({ numero: ELIXIR });
    expect(eventi.find((e) => e.type === EVENTO_DATABASE_APERTURA)?.payload).toMatchObject({ riaperta: true, numero: ELIXIR, numeroPrima: N0047 });
  });

  it("chat senza numero: parte dal numero meno carico del giro", async () => {
    const { deps, chiamate } = mondo({ chat: VECCHIA, settings: TUTTI, stato: { waNumber: null }, databaseOggi: { [ELIXIR]: 2 } });
    expect(await enroll(deps)).toMatchObject({ tipo: 'aperto', numero: N8061 });
    expect(chiamate.aggiorna[0].patch).toMatchObject({ wa_number: N8061 });
  });

  it("il numero della chat ha gia' il suo scaglione database: si passa al prossimo (carico diviso)", async () => {
    const { deps } = mondo({ chat: VECCHIA, settings: { ...TUTTI, tetto_numero: 3 }, databaseOggi: { [N0047]: 3, [ELIXIR]: 1 } });
    expect(await enroll(deps)).toMatchObject({ tipo: 'aperto', numero: N8061 });
  });

  it("nessun numero puo' aprire: non adesso per tutti (il CRM ferma il giro), niente scritto", async () => {
    const { deps, chiamate } = mondo({ chat: VECCHIA, settings: TUTTI, tetti: {} });
    expect(await enroll(deps)).toMatchObject({ tipo: 'rifiuto', motivo: 'database_non_aperto', dettaglio: 'nessun_numero' });
    expect(chiamate.aggiorna).toHaveLength(0);
    expect(chiamate.invia).toHaveLength(0);
  });

  it("le regole pure: con `tutti` pausa/GDO/lancio/scarto non fermano, il resto si'", () => {
    const s: StatoChatEsistente = {
      waNumber: N0047, ultimoMessaggioMs: ADESSO - 40 * 24 * 3600_000, pausata: true, chatGdo: true, lancioInCorso: true,
      botOutcome: 'DA_SCARTARE', botOutcomeMs: ADESSO - 40 * 24 * 3600_000, optOut: false, senzaWhatsapp: false, haRisposto: false,
    };
    expect(motivoChatNonRiapribile(s, { nowMs: ADESSO, giorni: 7 })).toBe('pausa_manuale');
    expect(motivoChatNonRiapribile(s, { nowMs: ADESSO, giorni: 7, tutti: true })).toBeNull();
    expect(motivoChatNonRiapribile({ ...s, optOut: true }, { nowMs: ADESSO, giorni: 7, tutti: true })).toBe('opt_out');
    expect(motivoChatNonRiapribile({ ...s, giaAperturaBf: true }, { nowMs: ADESSO, giorni: 7, tutti: true })).toBe('gia_apertura_bf');
    expect(motivoChatNonRiapribile(s, { nowMs: ADESSO, giorni: 7, tutti: true, soloChiHaRisposto: true })).toBe('mai_risposto');
  });
});
