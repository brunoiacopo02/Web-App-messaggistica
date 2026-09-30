import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./spedibilita', () => ({ spedibileDa: vi.fn(async (sid: string) => ({ ok: true, sidTradotto: sid })) }));
vi.mock('./bot2-tetto', async (orig) => ({ ...(await orig<typeof import('./bot2-tetto')>()), chatNateOggi: vi.fn(async () => 0) }));
vi.mock('./tetti-numeri', async (orig) => ({ ...(await orig<typeof import('./tetti-numeri')>()), getTettiNumeri: vi.fn() }));

import { scegliMittenteNuovo, sidAperturaMario } from './scelta-mittente';
import { spedibileDa } from './spedibilita';
import { chatNateOggi } from './bot2-tetto';
import { getTettiNumeri, parseTettiNumeri } from './tetti-numeri';
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
const tetti = (o: Record<string, number>) => vi.mocked(getTettiNumeri).mockResolvedValue(parseTettiNumeri(o));
const scegli = (s: any, extra: Partial<Parameters<typeof scegliMittenteNuovo>[1]> = {}) =>
  scegliMittenteNuovo(s, { templateSids: ['HX_A'], chiave: '+393331234567', ...extra });

beforeEach(() => {
  vi.stubEnv('TWILIO_WHATSAPP_NUMBER_FENICE', P);
  vi.stubEnv('BOT_NUMERI_SECONDARI', `${N0047},${ELIXIR},${N8061}`);
  vi.stubEnv('TWILIO_ACCOUNT_SID', 'AC_primo');
  vi.stubEnv('TWILIO_AUTH_TOKEN', 'tok_primo');
  vi.stubEnv('TWILIO_WHATSAPP_NUMBERS_2', '');
  vi.stubEnv('TWILIO_WHATSAPP_NUMBERS_3', '');
  vi.mocked(spedibileDa).mockReset().mockImplementation(async (sid: string) => ({ ok: true, sidTradotto: sid }));
  vi.mocked(chatNateOggi).mockReset().mockResolvedValue(0);
  // Anche questo va azzerato a ogni test: senza reset le chiamate si sommano fra i
  // test (nessun `clearMocks` globale in vitest.config.ts) e il test "nessun
  // secondario configurato" — che verifica una NON chiamata — vede quelle di prima.
  vi.mocked(getTettiNumeri).mockReset();
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('scegliMittenteNuovo', () => {
  it('prende il secondario con meno chat oggi', async () => {
    tetti({ [ELIXIR]: 150, [N8061]: 150, [N0047]: 0 });
    vi.mocked(chatNateOggi).mockImplementation(async (_s, n) => (n === ELIXIR ? 40 : 12));
    const { s } = supa();
    const r = await scegli(s);
    expect(r).toMatchObject({ from: N8061, secondario: true, motivo: 'scelto' });
  });

  it('a parita vince l ordine della lista', async () => {
    tetti({ [ELIXIR]: 150, [N8061]: 150 });
    expect((await scegli(supa().s)).from).toBe(ELIXIR);
  });

  it('tetto zero o assente: il numero non e nemmeno contato', async () => {
    tetti({ [ELIXIR]: 150 });
    await scegli(supa().s);
    expect(vi.mocked(chatNateOggi).mock.calls.map((c) => c[1])).toEqual([ELIXIR]);
  });

  it('tutti pieni: 3199, e un evento info per numero', async () => {
    tetti({ [ELIXIR]: 150, [N8061]: 150 });
    vi.mocked(chatNateOggi).mockResolvedValue(150);
    const { s, eventi } = supa();
    const r = await scegli(s);
    expect(r).toMatchObject({ from: P, secondario: false, motivo: 'nessun_candidato' });
    expect(eventi.filter((e) => e.type === 'mittente_tetto')).toHaveLength(2);
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
    vi.mocked(chatNateOggi).mockImplementation(async (_s, n) => (n === ELIXIR ? null : 3));
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
    vi.mocked(chatNateOggi).mockResolvedValue(150);
    const r = await scegli(supa().s, { ignoraTetti: true });
    expect(r).toMatchObject({ from: ELIXIR, secondario: true, motivo: 'scelto' });
    expect(chatNateOggi).not.toHaveBeenCalled();
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
    vi.mocked(chatNateOggi).mockResolvedValue(150);
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
    tetti({ [ELIXIR]: 150 });
    vi.mocked(chatNateOggi).mockResolvedValue(150);
    const { s, eventi } = supa({ conteggioRotto: true });
    const r = await scegli(s);
    expect(r.from).toBe(P);
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
