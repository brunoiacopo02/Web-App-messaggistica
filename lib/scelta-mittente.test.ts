import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./spedibilita', () => ({ spedibileDa: vi.fn(async (sid: string) => ({ ok: true, sidTradotto: sid })) }));
vi.mock('./bot2-tetto', async (orig) => ({ ...(await orig<typeof import('./bot2-tetto')>()), apertureMarioOggi: vi.fn(async () => 0) }));
vi.mock('./tetti-numeri', async (orig) => ({ ...(await orig<typeof import('./tetti-numeri')>()), getTettiNumeri: vi.fn(), getStatoQualitaNumeri: vi.fn() }));

import { scegliMittenteNuovo, sidAperturaMario, conCodaMarketing, registraAperturaMario, numeriTrabocco } from './scelta-mittente';
import { spedibileDa } from './spedibilita';
import { apertureMarioOggi } from './bot2-tetto';
import { getTettiNumeri, getStatoQualitaNumeri, parseTettiNumeri } from './tetti-numeri';
import { OPENING_ENV_KEYS } from './persona';

const P = 'whatsapp:+393520413199';
const ELIXIR = 'whatsapp:+393522018718';
const N8061 = 'whatsapp:+393520158061';
const N0047 = 'whatsapp:+393522070047';

/**
 * Un finto Supabase: `insert` registra le righe di event_log; il conteggio
 * `select(..., head).eq().eq().gte()` (la guardia "una riga mittente_tetto per
 * numero al giorno") conta le righe gia' registrate con quei filtri, e ricorda i
 * filtri usati. `conteggioRotto` fa fallire il conteggio.
 */
function supa(o: { conteggioRotto?: boolean } = {}) {
  const eventi: any[] = [];
  const filtri: [string, unknown][][] = [];
  const s = {
    from: () => ({
      insert: (r: any) => { eventi.push(r); return Promise.resolve({ error: null }); },
      select: () => {
        const f: [string, unknown][] = [];
        filtri.push(f);
        const catena: any = {
          eq: (k: string, v: unknown) => { f.push([k, v]); return catena; },
          gte: async (k: string, v: unknown) => {
            f.push([k, v]);
            if (o.conteggioRotto) return { count: null, error: { message: 'giu' } };
            const tipo = f.find(([c]) => c === 'type')?.[1];
            const numero = f.find(([c]) => c === 'payload->>numero')?.[1];
            return { count: eventi.filter((e) => e.type === tipo && e.payload?.numero === numero).length, error: null };
          },
        };
        return catena;
      },
    }),
  } as any;
  return { eventi, filtri, s };
}
/** Il 06/11/2026 alle 15 a Roma: "oggi" per lo storico della qualita'. */
const ADESSO = new Date('2026-11-06T14:00:00Z');
const OGGI = '2026-11-06';
const IERI = '2026-11-05';
const tutti = (q: string) => Object.fromEntries([P, ELIXIR, N8061, N0047].map((n) => [n.replace('whatsapp:', ''), { [OGGI]: q }]));
const qualita = (storico: Record<string, Record<string, string>>, pause: Record<string, unknown> = {}) =>
  vi.mocked(getStatoQualitaNumeri).mockResolvedValue({ storico, pause });
const tetti = (o: Record<string, number>) => vi.mocked(getTettiNumeri).mockResolvedValue(parseTettiNumeri(o));
const scegli = (s: any, extra: Partial<Parameters<typeof scegliMittenteNuovo>[1]> = {}) =>
  scegliMittenteNuovo(s, { templateSids: ['HX_A'], chiave: '+393331234567', adesso: ADESSO, ...extra });

beforeEach(() => {
  vi.stubEnv('TWILIO_WHATSAPP_NUMBER_FENICE', P);
  vi.stubEnv('BOT_NUMERI_SECONDARI', `${N0047},${ELIXIR},${N8061}`);
  vi.stubEnv('TWILIO_ACCOUNT_SID', 'AC_primo');
  vi.stubEnv('TWILIO_AUTH_TOKEN', 'tok_primo');
  vi.stubEnv('TWILIO_WHATSAPP_NUMBERS_2', '');
  vi.stubEnv('TWILIO_WHATSAPP_NUMBERS_3', '');
  vi.mocked(spedibileDa).mockReset().mockImplementation(async (sid: string) => ({ ok: true, sidTradotto: sid }));
  vi.mocked(apertureMarioOggi).mockReset().mockResolvedValue(0);
  // Anche questo va azzerato a ogni test: senza reset le chiamate si sommano fra i
  // test (nessun `clearMocks` globale in vitest.config.ts) e il test "nessun
  // secondario configurato" — che verifica una NON chiamata — vede quelle di prima.
  vi.mocked(getTettiNumeri).mockReset();
  vi.mocked(getStatoQualitaNumeri).mockReset().mockResolvedValue({ storico: tutti('HIGH'), pause: {} });
  vi.stubEnv('BOT_NUMERI_TRABOCCO', '');
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('scegliMittenteNuovo', () => {
  it('prende il secondario con meno chat oggi', async () => {
    tetti({ [ELIXIR]: 150, [N8061]: 150, [N0047]: 0 });
    vi.mocked(apertureMarioOggi).mockImplementation(async (_s, n) => (n === ELIXIR ? 40 : 12));
    const { s } = supa();
    const r = await scegli(s);
    expect(r).toMatchObject({ from: N8061, secondario: true, motivo: 'scelto' });
  });

  it('Black Friday: HIGH meno carico anche oltre il tetto, mai un LOW ne un numero a riposo (PO 07/11/2026)', async () => {
    tetti({ [P]: 15, [ELIXIR]: 50, [N8061]: 15, [N0047]: 0 });
    // Tutti oltre il tetto; l'8061 e' il meno carico ma LOW, il 0047 e' a riposo.
    vi.mocked(apertureMarioOggi).mockImplementation(async (_s, n) => (n === N8061 ? 1 : n === ELIXIR ? 60 : n === P ? 30 : 0));
    qualita({ ...tutti('HIGH'), '+393520158061': { [OGGI]: 'LOW' } });
    const { s, eventi } = supa();
    const r = await scegli(s, { senzaTettiSoloHigh: true, includiPrimario: true });
    expect(r).toMatchObject({ from: P, motivo: 'scelto' });
    expect(eventi.find((e) => e.type === 'mittente_black_friday')?.payload.numero).toBe(P);
  });

  it('Black Friday con escludiPrimario (PO 12/11/2026): il 3199, anche HIGH e il meno carico, resta fuori', async () => {
    tetti({ [P]: 15, [ELIXIR]: 50, [N8061]: 15, [N0047]: 0 });
    vi.mocked(apertureMarioOggi).mockImplementation(async (_s, n) => (n === P ? 0 : n === ELIXIR ? 60 : 20));
    const { s, eventi } = supa();
    // Senza la regola vincerebbe il 3199 (0 aperture oggi).
    expect((await scegli(s, { senzaTettiSoloHigh: true, includiPrimario: true })).from).toBe(P);
    const r = await scegli(s, { senzaTettiSoloHigh: true, includiPrimario: true, escludiPrimario: true });
    expect(r).toMatchObject({ from: N8061, secondario: true, motivo: 'scelto' });
    expect(eventi.filter((e) => e.type === 'mittente_black_friday').at(-1)?.payload.numero).toBe(N8061);
  });

  it('Black Friday con escludiPrimario e nessun secondario HIGH: giro di sempre senza il 3199', async () => {
    tetti({ [P]: 15, [ELIXIR]: 150, [N8061]: 150, [N0047]: 0 });
    // Solo il 3199 e' HIGH: non si prende lo stesso, ne' dalla scelta HIGH ne' dal giro.
    qualita({ ...tutti('LOW'), '+393520413199': { [OGGI]: 'HIGH' } });
    const { s } = supa();
    const r = await scegli(s, { senzaTettiSoloHigh: true, includiPrimario: true, escludiPrimario: true });
    expect([ELIXIR, N8061]).toContain(r.from);
    expect(r.secondario).toBe(true);
  });

  it('Black Friday senza nessun numero HIGH: regola di sempre', async () => {
    tetti({ [ELIXIR]: 150, [N8061]: 150, [N0047]: 0 });
    qualita(tutti('LOW'));
    const { s } = supa();
    const r = await scegli(s, { senzaTettiSoloHigh: true });
    expect(r.motivo).toBe('scelto');
    expect([ELIXIR, N8061]).toContain(r.from);
  });

  it('a parita vince l ordine della lista', async () => {
    tetti({ [ELIXIR]: 150, [N8061]: 150 });
    expect((await scegli(supa().s)).from).toBe(ELIXIR);
  });

  it('tetto zero o assente: il numero non e nemmeno contato', async () => {
    tetti({ [ELIXIR]: 150 });
    await scegli(supa().s);
    expect(vi.mocked(apertureMarioOggi).mock.calls.map((c) => c[1])).toEqual([ELIXIR]);
  });

  it('tutti pieni: il trabocco va solo all 8061 fra i secondari, non a elixir (PO 06/11/2026)', async () => {
    tetti({ [ELIXIR]: 50, [N8061]: 15 });
    vi.mocked(apertureMarioOggi).mockImplementation(async (_s, n) => (n === ELIXIR ? 50 : 40));
    const { s, eventi } = supa();
    const r = await scegli(s);
    expect(r).toMatchObject({ from: N8061, secondario: true, motivo: 'scelto' });
    expect(eventi.filter((e) => e.type === 'mittente_tetto')).toHaveLength(2);
    expect(eventi.filter((e) => e.type === 'mittente_trabocco')).toHaveLength(1);
  });

  it('trabocco: un numero a riposo (tetto 0) non prende mai il trabocco', async () => {
    tetti({ [ELIXIR]: 10, [N8061]: 0 });
    vi.mocked(apertureMarioOggi).mockResolvedValue(10);
    const { s, eventi } = supa();
    const r = await scegli(s);
    expect(r).toMatchObject({ from: P, motivo: 'nessun_candidato' });
    expect(vi.mocked(apertureMarioOggi).mock.calls.map((c) => c[1])).toEqual([ELIXIR]);
    expect(eventi.find((e) => e.type === 'mittente_trabocco_senza_numero')?.level).toBe('warn');
  });

  it('trabocco: un numero pieno ma non spedibile resta fuori, si torna al 3199', async () => {
    tetti({ [N8061]: 10 });
    vi.mocked(apertureMarioOggi).mockResolvedValue(10);
    vi.mocked(spedibileDa).mockResolvedValue({ ok: false, motivo: 'template_bloccato', sidTradotto: 'HX_A', errore: 'x' } as any);
    const r = await scegli(supa().s);
    expect(r).toMatchObject({ from: P, motivo: 'nessun_candidato' });
  });

  // Review Focus 1: elixir prima che Meta approvi i template.
  it('template non esistente sull account di elixir: elixir scartato, si usa il 8061', async () => {
    tetti({ [ELIXIR]: 150, [N8061]: 150 });
    vi.mocked(spedibileDa).mockImplementation(async (sid, n) =>
      n === ELIXIR ? { ok: false, motivo: 'template_non_tradotto', sidTradotto: sid, errore: '404' } : { ok: true, sidTradotto: sid });
    const { s, eventi } = supa();
    const r = await scegli(s);
    expect(r.from).toBe(N8061);
    expect(eventi.find((e) => e.type === 'mittente_ripiego')?.payload).toMatchObject({ numero: ELIXIR, motivo: 'template_non_tradotto' });
  });

  it('basta UN template non spedibile per scartare il numero', async () => {
    tetti({ [ELIXIR]: 150 });
    vi.mocked(spedibileDa).mockImplementation(async (sid) =>
      sid === 'HX_B' ? { ok: false, motivo: 'template_bloccato', sidTradotto: sid, errore: 'MARKETING' } : { ok: true, sidTradotto: sid });
    expect((await scegli(supa().s, { templateSids: ['HX_A', 'HX_B'] })).from).toBe(P);
  });

  // Review Focus 4
  it('conteggio fallito su un numero: scartato quello, l altro resta', async () => {
    tetti({ [ELIXIR]: 150, [N8061]: 150 });
    vi.mocked(apertureMarioOggi).mockImplementation(async (_s, n) => (n === ELIXIR ? null : 3));
    expect((await scegli(supa().s)).from).toBe(N8061);
  });

  it('tetti illeggibili: 3199 e un warn', async () => {
    vi.mocked(getTettiNumeri).mockResolvedValue(null);
    const { s, eventi } = supa();
    const r = await scegli(s);
    expect(r).toMatchObject({ from: P, motivo: 'tetti_illeggibili' });
    expect(eventi[0]).toMatchObject({ type: 'mittente_ripiego', level: 'warn' });
  });

  it('nessun secondario configurato: 3199 senza query', async () => {
    vi.stubEnv('BOT_NUMERI_SECONDARI', '');
    tetti({});
    const r = await scegli(supa().s);
    expect(r).toMatchObject({ from: P, motivo: 'nessun_secondario' });
    expect(getTettiNumeri).not.toHaveBeenCalled();
  });

  // ignoraTetti (lancio_sender='secondario') scavalca i tetti giornalieri, NON il
  // riposo: un numero a tetto 0 o assente dalla mappa resta fuori.
  it('ignoraTetti: un numero a tetto zero o assente resta escluso', async () => {
    tetti({ [ELIXIR]: 0, [N8061]: 150 });
    const r = await scegli(supa().s, { ignoraTetti: true });
    expect(r.from).toBe(N8061);
    expect(r.scartati).toEqual(expect.arrayContaining([
      { numero: ELIXIR, motivo: 'tetto_zero' },
      { numero: N0047, motivo: 'tetto_zero' },
    ]));
  });

  it('ignoraTetti: un numero pieno viene scelto lo stesso, senza contare', async () => {
    tetti({ [ELIXIR]: 150 });
    vi.mocked(apertureMarioOggi).mockResolvedValue(150);
    const r = await scegli(supa().s, { ignoraTetti: true });
    expect(r).toMatchObject({ from: ELIXIR, secondario: true, motivo: 'scelto' });
    expect(apertureMarioOggi).not.toHaveBeenCalled();
  });

  it('ignoraTetti: non sceglie un numero con template mancante', async () => {
    tetti({ [N0047]: 150, [ELIXIR]: 150, [N8061]: 150 });
    vi.mocked(spedibileDa).mockImplementation(async (sid, n) =>
      n === N0047 ? { ok: false, motivo: 'template_bloccato', sidTradotto: sid, errore: 'x' } : { ok: true, sidTradotto: sid });
    // Nessun conteggio: tutti a `oggi: 0`, vince il primo spedibile nell'ordine della lista.
    expect((await scegli(supa().s, { ignoraTetti: true })).from).toBe(ELIXIR);
  });

  it('ignoraTetti con tetti illeggibili: 3199 e un warn, come nel caso normale', async () => {
    vi.mocked(getTettiNumeri).mockResolvedValue(null);
    const { s, eventi } = supa();
    const r = await scegli(s, { ignoraTetti: true });
    expect(r).toMatchObject({ from: P, secondario: false, motivo: 'tetti_illeggibili' });
    expect(eventi).toMatchObject([{ type: 'mittente_ripiego', level: 'warn', payload: { motivo: 'tetti_illeggibili' } }]);
  });

  // Spec §4.3: una sola riga mittente_tetto per numero per giorno di Roma.
  it('mittente_tetto: la prima volta si scrive, la seconda nello stesso giorno no', async () => {
    tetti({ [ELIXIR]: 150 });
    vi.mocked(apertureMarioOggi).mockResolvedValue(150);
    const { s, eventi, filtri } = supa();
    await scegli(s);
    await scegli(s);
    expect(eventi.filter((e) => e.type === 'mittente_tetto')).toHaveLength(1);
    expect(filtri[0]).toEqual([
      ['type', 'mittente_tetto'],
      ['payload->>numero', ELIXIR],
      ['created_at', expect.stringMatching(/T00:00:00[+-]\d{2}:\d{2}$/)],
    ]);
  });

  it('mittente_tetto: se il conteggio fallisce non si scrive (e solo un log)', async () => {
    tetti({ [N8061]: 150 });
    vi.mocked(apertureMarioOggi).mockResolvedValue(150);
    const { s, eventi } = supa({ conteggioRotto: true });
    const r = await scegli(s);
    // Pieno ma numero del trabocco e HIGH: lo prende lui (PO 06/11/2026).
    expect(r.from).toBe(N8061);
    expect(eventi.filter((e) => e.type === 'mittente_tetto')).toHaveLength(0);
  });

  // Numero dichiarato sull'account elixir ma senza SID/TOKEN dello slot: le
  // credenziali ripiegano sul principale, che non possiede il numero (401).
  it('credenziali dello slot mancanti: scartato prima della verifica template', async () => {
    tetti({ [ELIXIR]: 150, [N8061]: 150 });
    vi.stubEnv('TWILIO_WHATSAPP_NUMBERS_3', ELIXIR);
    vi.stubEnv('TWILIO_ACCOUNT_SID_3', '');
    vi.stubEnv('TWILIO_AUTH_TOKEN_3', '');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { s, eventi } = supa();
    const r = await scegli(s);
    expect(r.from).toBe(N8061);
    expect(r.scartati).toContainEqual({ numero: ELIXIR, motivo: 'credenziali_mancanti' });
    expect(vi.mocked(spedibileDa).mock.calls.map((c) => c[1])).not.toContain(ELIXIR);
    expect(eventi.find((e) => e.type === 'mittente_ripiego')).toMatchObject({
      level: 'warn', payload: { numero: ELIXIR, motivo: 'credenziali_mancanti' },
    });
  });

  it('credenziali dello slot presenti: il numero resta candidato', async () => {
    tetti({ [ELIXIR]: 150 });
    vi.stubEnv('TWILIO_WHATSAPP_NUMBERS_3', ELIXIR);
    vi.stubEnv('TWILIO_ACCOUNT_SID_3', 'AC_terzo');
    vi.stubEnv('TWILIO_AUTH_TOKEN_3', 'tok_terzo');
    expect((await scegli(supa().s)).from).toBe(ELIXIR);
  });

  it('senza template da verificare: 3199 (non si apre un numero alla cieca)', async () => {
    tetti({ [ELIXIR]: 150 });
    const { s, eventi } = supa();
    const r = await scegli(s, { templateSids: [] });
    expect(r.from).toBe(P);
    expect(eventi).toMatchObject([{ type: 'mittente_ripiego', level: 'warn', payload: { motivo: 'nessun_template' } }]);
  });
});

describe('aperture di Mario: la riga che conta il tetto (PO 06/11/2026)', () => {
  it('registraAperturaMario scrive mittente_apertura col numero, e il conteggio vero la ritrova', async () => {
    const { s, eventi } = supa();
    await registraAperturaMario(s, { numero: P, conversationId: 9, crmLeadId: 'L1' });
    expect(eventi).toMatchObject([{ type: 'mittente_apertura', payload: { numero: P, conversationId: 9, crmLeadId: 'L1' } }]);
    // Un'agenda GDO o una chat aperta dal lead non scrivono questa riga: non contano.
    eventi.push({ type: 'gdo_agenda_chat_su_numero_storico', payload: { numero: P } });
    const vero = (await vi.importActual<typeof import('./bot2-tetto')>('./bot2-tetto')).apertureMarioOggi;
    expect(await vero(s, P, ADESSO)).toBe(1);
    expect(await vero(s, N8061, ADESSO)).toBe(0);
  });

  it('conteggio in errore: null (il numero esce dal giro)', async () => {
    const vero = (await vi.importActual<typeof import('./bot2-tetto')>('./bot2-tetto')).apertureMarioOggi;
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await vero(supa({ conteggioRotto: true }).s, P, ADESSO)).toBeNull();
  });
});

describe('sidAperturaMario', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('A/B acceso, tutte le OPENING_ENV_KEYS valorizzate: solo quelle, mai il legacy', () => {
    vi.stubEnv('NEW_OPENING_ENABLED', '1');
    vi.stubEnv('FENICE_OPENING_TEMPLATE_SID', 'HX_LEG');
    OPENING_ENV_KEYS.forEach((k, i) => vi.stubEnv(k, `HX${i}`));
    expect(sidAperturaMario().sort()).toEqual(OPENING_ENV_KEYS.map((_, i) => `HX${i}`).sort());
  });

  it('A/B acceso, una OPENING_ENV_KEYS manca: quel lead puo prendere il legacy, si verifica anche lui', () => {
    vi.stubEnv('NEW_OPENING_ENABLED', '1');
    vi.stubEnv('FENICE_OPENING_TEMPLATE_SID', 'HX_LEG');
    const [, ...resto] = OPENING_ENV_KEYS; // la prima chiave resta non configurata
    resto.forEach((k, i) => vi.stubEnv(k, `HX${i}`));
    const attese = [...resto.map((_, i) => `HX${i}`), 'HX_LEG'];
    expect(sidAperturaMario().sort()).toEqual(attese.sort());
  });

  it('spente: il template legacy', () => {
    vi.stubEnv('FENICE_OPENING_TEMPLATE_SID', 'HX_LEG');
    expect(sidAperturaMario()).toEqual(['HX_LEG']);
  });
});

describe('scegliMittenteNuovo con includiPrimario (PO 23/10/2026: il 3199 torna nel giro)', () => {
  it('primario con tetto > 0 e meno chat oggi: vince il primario', async () => {
    tetti({ [P]: 100000, [ELIXIR]: 100000, [N8061]: 100000, [N0047]: 100000 });
    vi.mocked(apertureMarioOggi).mockImplementation(async (_s, n) => (n === P ? 3 : 20));
    const r = await scegli(supa().s, { includiPrimario: true });
    expect(r).toMatchObject({ from: P, secondario: false, motivo: 'scelto' });
  });

  it('primario con piu chat oggi: vince il secondario meno carico', async () => {
    tetti({ [P]: 100000, [ELIXIR]: 100000, [N8061]: 100000, [N0047]: 100000 });
    vi.mocked(apertureMarioOggi).mockImplementation(async (_s, n) => (n === P ? 30 : n === N8061 ? 5 : 20));
    const r = await scegli(supa().s, { includiPrimario: true });
    expect(r).toMatchObject({ from: N8061, secondario: true, motivo: 'scelto' });
  });

  it('a parita il secondario passa davanti al primario', async () => {
    tetti({ [P]: 100000, [ELIXIR]: 100000 });
    const r = await scegli(supa().s, { includiPrimario: true });
    expect(r.from).toBe(ELIXIR);
  });

  it('primario senza tetto in tetti_numeri: resta fuori, come prima', async () => {
    tetti({ [ELIXIR]: 100000 });
    vi.mocked(apertureMarioOggi).mockImplementation(async (_s, n) => (n === ELIXIR ? 50 : 0));
    const r = await scegli(supa().s, { includiPrimario: true });
    expect(r).toMatchObject({ from: ELIXIR, secondario: true });
    expect(vi.mocked(apertureMarioOggi).mock.calls.map((c) => c[1])).not.toContain(P);
  });

  it('senza includiPrimario il tetto del primario e ignorato (lancio e altri chiamanti)', async () => {
    tetti({ [P]: 100000, [ELIXIR]: 100000 });
    vi.mocked(apertureMarioOggi).mockImplementation(async (_s, n) => (n === P ? 0 : 50));
    const r = await scegli(supa().s);
    expect(r).toMatchObject({ from: ELIXIR, secondario: true });
  });

  it('primario pieno e secondari pieni: trabocco fra 3199 e 8061, il meno carico', async () => {
    tetti({ [P]: 15, [ELIXIR]: 50, [N8061]: 15 });
    vi.mocked(apertureMarioOggi).mockImplementation(async (_s, n) => (n === P ? 18 : n === N8061 ? 21 : 50));
    const r = await scegli(supa().s, { includiPrimario: true });
    expect(r).toMatchObject({ from: P, secondario: false, motivo: 'scelto' });
    vi.mocked(apertureMarioOggi).mockImplementation(async (_s, n) => (n === P ? 22 : n === N8061 ? 21 : 50));
    const r2 = await scegli(supa().s, { includiPrimario: true });
    expect(r2).toMatchObject({ from: N8061, secondario: true });
  });

  it('trabocco a turno: 10 lead oltre i tetti si dividono 5 e 5 fra 3199 e 8061', async () => {
    tetti({ [P]: 15, [ELIXIR]: 50, [N8061]: 15, [N0047]: 20 });
    const conta: Record<string, number> = { [P]: 15, [N8061]: 15, [ELIXIR]: 50, [N0047]: 20 };
    vi.mocked(apertureMarioOggi).mockImplementation(async (_s, n) => conta[n]);
    const presi: string[] = [];
    for (let k = 0; k < 10; k++) {
      const r = await scegli(supa().s, { includiPrimario: true });
      conta[r.from] += 1;
      presi.push(r.from);
    }
    expect(presi.filter((n) => n === P)).toHaveLength(5);
    expect(presi.filter((n) => n === N8061)).toHaveLength(5);
  });

  it('trabocco: il 3199 non HIGH resta fuori, va tutto all 8061', async () => {
    tetti({ [P]: 15, [N8061]: 15 });
    qualita({ ...tutti('HIGH'), '+393520413199': { [OGGI]: 'LOW' } });
    vi.mocked(apertureMarioOggi).mockImplementation(async (_s, n) => (n === P ? 15 : 30));
    const r = await scegli(supa().s, { includiPrimario: true });
    expect(r.from).toBe(N8061);
  });

  it('trabocco: 8061 non HIGH e 3199 LOW: warn e ripiego; 8061 in pausa: va al 3199 HIGH', async () => {
    tetti({ [P]: 15, [N8061]: 15 });
    qualita({ ...tutti('HIGH'), '+393520413199': { [OGGI]: 'LOW' }, '+393520158061': { [OGGI]: 'MEDIUM' } });
    vi.mocked(apertureMarioOggi).mockResolvedValue(15);
    const { s, eventi } = supa();
    const r = await scegli(s, { includiPrimario: true });
    expect(r).toMatchObject({ from: P, motivo: 'nessun_candidato' });
    expect(eventi.find((e) => e.type === 'mittente_trabocco_senza_numero')).toBeTruthy();
    qualita(tutti('HIGH'), { '+393520158061': { fino: '2026-11-09' } });
    vi.mocked(apertureMarioOggi).mockImplementation(async (_s, n) => (n === P ? 40 : 15));
    const r2 = await scegli(supa().s, { includiPrimario: true });
    expect(r2).toMatchObject({ from: P, motivo: 'scelto' });
  });

  it('trabocco: senza lettura di oggi vale quella di ieri; piu vecchia = non HIGH', async () => {
    tetti({ [N8061]: 15 });
    vi.mocked(apertureMarioOggi).mockResolvedValue(15);
    qualita({ '+393520158061': { [IERI]: 'HIGH' } });
    expect((await scegli(supa().s)).from).toBe(N8061);
    qualita({ '+393520158061': { '2026-11-04': 'HIGH' } });
    expect((await scegli(supa().s)).from).toBe(P);
  });

  it('trabocco: stato qualita illeggibile = nessun numero HIGH', async () => {
    tetti({ [N8061]: 15 });
    vi.mocked(apertureMarioOggi).mockResolvedValue(15);
    vi.mocked(getStatoQualitaNumeri).mockResolvedValue(null);
    expect((await scegli(supa().s)).motivo).toBe('nessun_candidato');
  });

  it('coda marketing oltre i tetti: trabocco solo sull 8061, mai il 3199', async () => {
    tetti({ [P]: 15, [N8061]: 15, [ELIXIR]: 50 });
    vi.mocked(apertureMarioOggi).mockImplementation(async (_s, n) => (n === P ? 0 : n === N8061 ? 30 : 50));
    const r = await scegli(supa().s, { includiPrimario: true, codaMarketing: true });
    expect(r).toMatchObject({ from: N8061, secondario: true });
  });

  it('BOT_NUMERI_TRABOCCO cambia i numeri del trabocco', async () => {
    vi.stubEnv('BOT_NUMERI_TRABOCCO', '+393522018718');
    expect(numeriTrabocco()).toEqual(['+393522018718']);
    tetti({ [ELIXIR]: 50, [N8061]: 15 });
    vi.mocked(apertureMarioOggi).mockResolvedValue(60);
    expect((await scegli(supa().s)).from).toBe(ELIXIR);
  });

  it('3199 a tetto 15: le agende non contano, apre finche le sue aperture di Mario sono sotto 15', async () => {
    tetti({ [P]: 15, [ELIXIR]: 50, [N8061]: 15 });
    vi.mocked(apertureMarioOggi).mockImplementation(async (_s, n) => (n === P ? 3 : 20));
    const r = await scegli(supa().s, { includiPrimario: true });
    expect(r).toMatchObject({ from: P, motivo: 'scelto' });
  });

  it('conteggio del primario fallito: primario fuori dal giro, si sceglie fra i secondari', async () => {
    tetti({ [P]: 100000, [ELIXIR]: 100000 });
    vi.mocked(apertureMarioOggi).mockImplementation(async (_s, n) => (n === P ? null : 40));
    const r = await scegli(supa().s, { includiPrimario: true });
    expect(r).toMatchObject({ from: ELIXIR, secondario: true });
  });
});

describe('scegliMittenteNuovo con la coda marketing (PO 29/10/2026)', () => {
  it('mai il primario, anche se ha un tetto e meno chat', async () => {
    tetti({ [P]: 100000, [ELIXIR]: 100000, [N8061]: 100000 });
    vi.mocked(apertureMarioOggi).mockImplementation(async (_s, n) => (n === P ? 0 : 50));
    const { s, eventi } = supa();
    const r = await scegli(s, { includiPrimario: true, codaMarketing: true });
    expect(r).toMatchObject({ from: ELIXIR, secondario: true });
    expect(eventi.filter((e) => e.type === 'mittente_coda_marketing')).toHaveLength(1);
  });

  it('divide alla pari: 30 lead della coda fanno 10 per numero, anche con chat diverse', async () => {
    tetti({ [P]: 100000, [ELIXIR]: 100000, [N8061]: 100000, [N0047]: 100000 });
    vi.mocked(apertureMarioOggi).mockImplementation(async (_s, n) => (n === ELIXIR ? 5 : n === N8061 ? 40 : 80));
    const { s, eventi } = supa();
    for (let k = 0; k < 30; k++) await scegli(s, { includiPrimario: true, codaMarketing: true });
    const per = (n: string) => eventi.filter((e) => e.type === 'mittente_coda_marketing' && e.payload.numero === n).length;
    expect([per(ELIXIR), per(N8061), per(N0047), per(P)]).toEqual([10, 10, 10, 0]);
  });

  it('dal contesto della richiesta (conCodaMarketing), senza argomento', async () => {
    tetti({ [P]: 100000, [ELIXIR]: 100000 });
    vi.mocked(apertureMarioOggi).mockImplementation(async (_s, n) => (n === P ? 0 : 50));
    const r = await conCodaMarketing(true, () => scegli(supa().s, { includiPrimario: true }));
    expect(r.from).toBe(ELIXIR);
    const fuori = await scegli(supa().s, { includiPrimario: true });
    expect(fuori.from).toBe(P);
  });

  it('nessun secondario utilizzabile: nasce sul primario con un warn', async () => {
    tetti({ [P]: 100000 });
    const { s, eventi } = supa();
    const r = await scegli(s, { includiPrimario: true, codaMarketing: true });
    expect(r).toMatchObject({ from: P, motivo: 'nessun_candidato' });
    expect(eventi.find((e) => e.type === 'mittente_coda_marketing_sul_primario')?.level).toBe('warn');
  });

  it('un lead ordinario non scrive la riga della coda', async () => {
    tetti({ [ELIXIR]: 100000 });
    const { s, eventi } = supa();
    await scegli(s);
    expect(eventi.filter((e) => e.type === 'mittente_coda_marketing')).toHaveLength(0);
  });
});
