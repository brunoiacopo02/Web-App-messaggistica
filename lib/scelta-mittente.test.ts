import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./spedibilita', () => ({ spedibileDa: vi.fn(async (sid: string) => ({ ok: true, sidTradotto: sid })) }));
vi.mock('./bot2-tetto', () => ({ chatNateOggi: vi.fn(async () => 0) }));
vi.mock('./tetti-numeri', async (orig) => ({ ...(await orig<typeof import('./tetti-numeri')>()), getTettiNumeri: vi.fn() }));

import { scegliMittenteNuovo, sidAperturaMario } from './scelta-mittente';
import { spedibileDa } from './spedibilita';
import { chatNateOggi } from './bot2-tetto';
import { getTettiNumeri, parseTettiNumeri } from './tetti-numeri';

const P = 'whatsapp:+393520413199';
const ELIXIR = 'whatsapp:+393522018718';
const N8061 = 'whatsapp:+393520158061';
const N0047 = 'whatsapp:+393522070047';

function supa() {
  const eventi: any[] = [];
  return { eventi, s: { from: () => ({ insert: (r: any) => { eventi.push(r); return Promise.resolve({ error: null }); } }) } as any };
}
const tetti = (o: Record<string, number>) => vi.mocked(getTettiNumeri).mockResolvedValue(parseTettiNumeri(o));
const scegli = (s: any, extra: Partial<Parameters<typeof scegliMittenteNuovo>[1]> = {}) =>
  scegliMittenteNuovo(s, { templateSids: ['HX_A'], chiave: '+393331234567', ...extra });

beforeEach(() => {
  process.env.TWILIO_WHATSAPP_NUMBER_FENICE = P;
  process.env.BOT_NUMERI_SECONDARI = `${N0047},${ELIXIR},${N8061}`;
  vi.mocked(spedibileDa).mockReset().mockImplementation(async (sid: string) => ({ ok: true, sidTradotto: sid }));
  vi.mocked(chatNateOggi).mockReset().mockResolvedValue(0);
  // Anche questo va azzerato a ogni test: senza reset le chiamate si sommano fra i
  // test (nessun `clearMocks` globale in vitest.config.ts) e il test "nessun
  // secondario configurato" — che verifica una NON chiamata — vede quelle di prima.
  vi.mocked(getTettiNumeri).mockReset();
});
afterEach(() => { delete process.env.BOT_NUMERI_SECONDARI; });

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
    process.env.BOT_NUMERI_SECONDARI = '';
    tetti({});
    const r = await scegli(supa().s);
    expect(r).toMatchObject({ from: P, motivo: 'nessun_secondario' });
    expect(getTettiNumeri).not.toHaveBeenCalled();
  });

  it('ignoraTetti: sceglie anche un numero pieno o a tetto zero, ma non uno con template mancante', async () => {
    tetti({ [ELIXIR]: 0 });
    vi.mocked(spedibileDa).mockImplementation(async (sid, n) =>
      n === N0047 ? { ok: false, motivo: 'template_bloccato', sidTradotto: sid, errore: 'x' } : { ok: true, sidTradotto: sid });
    const r = await scegli(supa().s, { ignoraTetti: true });
    expect([ELIXIR, N8061]).toContain(r.from);
  });

  it('senza template da verificare: 3199 (non si apre un numero alla cieca)', async () => {
    tetti({ [ELIXIR]: 150 });
    expect((await scegli(supa().s, { templateSids: [] })).from).toBe(P);
  });
});

describe('sidAperturaMario', () => {
  afterEach(() => { for (const k of Object.keys(process.env)) if (k.startsWith('OPENING_SID_')) delete process.env[k]; delete process.env.NEW_OPENING_ENABLED; });
  it('con le aperture A/B accese: tutti gli OPENING_SID_* presenti', () => {
    process.env.NEW_OPENING_ENABLED = '1';
    process.env.OPENING_SID_C1 = 'HX1'; process.env.OPENING_SID_T2 = 'HX2';
    expect(sidAperturaMario().sort()).toEqual(['HX1', 'HX2']);
  });
  it('spente: il template legacy', () => {
    process.env.FENICE_OPENING_TEMPLATE_SID = 'HX_LEG';
    expect(sidAperturaMario()).toEqual(['HX_LEG']);
  });
});
