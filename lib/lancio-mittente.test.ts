import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./twilio', () => ({ assertTemplateSendable: vi.fn(async () => undefined) }));
vi.mock('./template-account', () => ({
  traduciTemplate: vi.fn(async (sid: string) => ({ sid: `${sid}_2`, tradotto: true })),
}));

import {
  posizioneQuota,
  toccaAlSecondario,
  spedibileDa,
  mittenteBenvenutoLancio,
} from './lancio-mittente';
import { mittenteDiConversazione } from './mittente';
import { assertTemplateSendable } from './twilio';
import { traduciTemplate } from './template-account';

const PRIMARIO = 'whatsapp:+393520413199';
const SECONDO = 'whatsapp:+393522070047';
const WELCOME = 'HX_LANCIO_WELCOME';

/** Un telefono E.164 diverso per ogni indice, come un lotto di lead veri. */
const tel = (i: number) => `+3933${String(1000000 + i).padStart(7, '0')}`;

/** Il primo telefono che finisce in quota, per i test che ne vogliono uno di sicuro. */
const IN_QUOTA = (() => {
  for (let i = 0; i < 500; i++) if (toccaAlSecondario(tel(i), 9)) return tel(i);
  throw new Error('nessun telefono in quota: la funzione di posizione e cambiata');
})();
/** ...e uno che NON ci finisce. */
const FUORI_QUOTA = (() => {
  for (let i = 0; i < 500; i++) if (!toccaAlSecondario(tel(i), 9)) return tel(i);
  throw new Error('impossibile');
})();

/** Supabase finto: raccoglie gli eventi e risponde al conteggio del tetto bot2. */
function makeSupabase(aperturaOggiSulSecondo = 0, conteggioKo = false) {
  const eventi: any[] = [];
  const supabase: any = {
    from(table: string) {
      if (table === 'conversations') {
        return {
          select: () => ({
            eq: () => ({
              gte: () => Promise.resolve(
                conteggioKo
                  ? { count: null, error: { message: 'timeout' } }
                  : { count: aperturaOggiSulSecondo, error: null },
              ),
            }),
          }),
        };
      }
      return { insert: (riga: any) => { eventi.push(riga); return Promise.resolve({ error: null }); } };
    },
  };
  return { supabase, eventi };
}

const impostazioni = (quotaSecondario: number, sender: 'principale' | 'secondario' = 'principale') =>
  ({ sender, quotaSecondario }) as const;

const scegli = (supabase: any, chiave: string, settings: any, secondo: string | undefined = SECONDO) =>
  mittenteBenvenutoLancio(supabase, { settings, chiave, templateSid: WELCOME, primario: PRIMARIO, secondo });

beforeEach(() => {
  vi.mocked(assertTemplateSendable).mockReset().mockResolvedValue(undefined);
  vi.mocked(traduciTemplate).mockReset().mockImplementation(
    async (sid: string) => ({ sid: `${sid}_2`, tradotto: true }),
  );
});
afterEach(() => { vi.unstubAllEnvs(); });

describe('posizioneQuota / toccaAlSecondario', () => {
  it('e deterministica: lo stesso lead finisce sempre nello stesso posto', () => {
    const prima = posizioneQuota('+393331234567');
    for (let i = 0; i < 50; i++) expect(posizioneQuota('+393331234567')).toBe(prima);
    expect(prima).toBeGreaterThanOrEqual(0);
    expect(prima).toBeLessThan(100);
  });

  it('spazi e forma della chiave non spostano nessuno', () => {
    expect(posizioneQuota('  +393331234567 ')).toBe(posizioneQuota('+393331234567'));
  });

  it('quota 0 (o storta) = nessuno al numero nuovo, mai', () => {
    for (let i = 0; i < 300; i++) {
      expect(toccaAlSecondario(tel(i), 0)).toBe(false);
      expect(toccaAlSecondario(tel(i), Number.NaN)).toBe(false);
      expect(toccaAlSecondario(tel(i), -1)).toBe(false);
    }
  });

  it('quota 100 = tutti al numero nuovo', () => {
    for (let i = 0; i < 300; i++) expect(toccaAlSecondario(tel(i), 100)).toBe(true);
  });

  // Il rapporto chiesto dal PO: 1 dal numero nuovo ogni 10 dal vecchio.
  it('quota 9: su 110 lead ne escono ~10 dal numero nuovo', () => {
    let n = 0;
    for (let i = 0; i < 110; i++) if (toccaAlSecondario(tel(i), 9)) n++;
    expect(n).toBeGreaterThanOrEqual(6);
    expect(n).toBeLessThanOrEqual(15);
  });

  it('su un campione grande la quota e davvero il 9%', () => {
    let n = 0;
    for (let i = 0; i < 11000; i++) if (toccaAlSecondario(tel(i), 9)) n++;
    expect(n / 11000).toBeGreaterThan(0.08);
    expect(n / 11000).toBeLessThan(0.10);
  });
});

describe('spedibileDa', () => {
  it('template tradotto e non bloccato = spedibile, col SID dell altro account', async () => {
    const esito = await spedibileDa(WELCOME, SECONDO);
    expect(esito).toEqual({ ok: true, sidTradotto: `${WELCOME}_2` });
    expect(assertTemplateSendable).toHaveBeenCalledWith(`${WELCOME}_2`, SECONDO, WELCOME);
  });

  it('template che su quell account non esiste = NON spedibile', async () => {
    vi.mocked(traduciTemplate).mockResolvedValueOnce({ sid: WELCOME, tradotto: false });
    const esito = await spedibileDa(WELCOME, SECONDO);
    expect(esito.ok).toBe(false);
    expect(esito).toMatchObject({ motivo: 'template_non_tradotto' });
    // Non si chiede nemmeno la categoria: il SID sarebbe quello dell'altro account.
    expect(assertTemplateSendable).not.toHaveBeenCalled();
  });

  it('template bloccato dal presidio UTILITY_ONLY = NON spedibile, col motivo', async () => {
    vi.mocked(assertTemplateSendable).mockRejectedValueOnce(
      new Error('template HX_2 bloccato: categoria MARKETING con UTILITY_ONLY attivo.'),
    );
    const esito = await spedibileDa(WELCOME, SECONDO);
    expect(esito).toMatchObject({ ok: false, motivo: 'template_bloccato' });
    expect((esito as { errore: string }).errore).toContain('MARKETING');
  });

  it('una traduzione esplosa vale NON spedibile (fail-closed)', async () => {
    vi.mocked(traduciTemplate).mockRejectedValueOnce(new Error('rete giu'));
    expect(await spedibileDa(WELCOME, SECONDO)).toMatchObject({ ok: false, motivo: 'template_non_tradotto' });
  });
});

describe('mittenteBenvenutoLancio', () => {
  it('quota 0: tutti dal numero storico, e non si tocca nemmeno la rete', async () => {
    const { supabase, eventi } = makeSupabase();
    for (let i = 0; i < 200; i++) {
      const esito = await scegli(supabase, tel(i), impostazioni(0));
      expect(esito).toEqual({ from: PRIMARIO, secondario: false, scelta: 'principale', ripiego: null });
    }
    expect(traduciTemplate).not.toHaveBeenCalled();
    expect(assertTemplateSendable).not.toHaveBeenCalled();
    expect(eventi).toHaveLength(0);
  });

  it('quota 9: chi e in quota parte dal numero nuovo, gli altri dal vecchio', async () => {
    const { supabase, eventi } = makeSupabase();
    expect(await scegli(supabase, IN_QUOTA, impostazioni(9))).toEqual(
      { from: SECONDO, secondario: true, scelta: 'quota', ripiego: null },
    );
    expect(await scegli(supabase, FUORI_QUOTA, impostazioni(9))).toEqual(
      { from: PRIMARIO, secondario: false, scelta: 'principale', ripiego: null },
    );
    expect(eventi).toHaveLength(0);
  });

  it('e stabile: lo stesso lead ha sempre lo stesso numero, run dopo run', async () => {
    const { supabase } = makeSupabase();
    for (let i = 0; i < 20; i++) {
      expect((await scegli(supabase, IN_QUOTA, impostazioni(9))).from).toBe(SECONDO);
      expect((await scegli(supabase, FUORI_QUOTA, impostazioni(9))).from).toBe(PRIMARIO);
    }
  });

  it('template non spedibile dal numero nuovo: si ripiega sul vecchio e resta scritto', async () => {
    vi.mocked(assertTemplateSendable).mockRejectedValue(
      new Error('template bloccato: categoria MARKETING con UTILITY_ONLY attivo.'),
    );
    const { supabase, eventi } = makeSupabase();
    const esito = await scegli(supabase, IN_QUOTA, impostazioni(9));
    expect(esito).toEqual({ from: PRIMARIO, secondario: false, scelta: 'quota', ripiego: 'template_bloccato' });
    expect(eventi).toHaveLength(1);
    expect(eventi[0]).toMatchObject({ type: 'lancio_mittente_ripiego', level: 'warn' });
    expect(eventi[0].payload).toMatchObject({
      motivo: 'template_bloccato', numero: SECONDO, templateSid: WELCOME, sidTradotto: `${WELCOME}_2`,
    });
    expect(String(eventi[0].payload.errore)).toContain('MARKETING');
  });

  it('template che sul secondo account non esiste: stesso ripiego, motivo diverso', async () => {
    vi.mocked(traduciTemplate).mockResolvedValue({ sid: WELCOME, tradotto: false });
    const { supabase, eventi } = makeSupabase();
    expect(await scegli(supabase, IN_QUOTA, impostazioni(9))).toMatchObject(
      { from: PRIMARIO, ripiego: 'template_non_tradotto' },
    );
    expect(eventi[0].payload).toMatchObject({ motivo: 'template_non_tradotto' });
  });

  it('numero nuovo non configurato: numero storico, e l avviso resta nei log', async () => {
    // Niente `secondo` iniettato e env vuota: e' il caso "non configurato".
    vi.stubEnv('TWILIO_WHATSAPP_NUMBER_FENICE_2', '');
    const { supabase, eventi } = makeSupabase();
    const esito = await mittenteBenvenutoLancio(supabase, {
      settings: impostazioni(9), chiave: IN_QUOTA, templateSid: WELCOME, primario: PRIMARIO,
    });
    expect(esito).toMatchObject({ from: PRIMARIO, ripiego: 'numero_assente' });
    expect(eventi[0]).toMatchObject({ type: 'lancio_mittente_ripiego' });
  });

  it('tetto giornaliero del numero nuovo raggiunto: la quota si ferma li', async () => {
    const { supabase, eventi } = makeSupabase(150);
    expect(await scegli(supabase, IN_QUOTA, impostazioni(9))).toEqual(
      { from: PRIMARIO, secondario: false, scelta: 'quota', ripiego: 'tetto_bot2' },
    );
    expect(eventi[0].payload).toMatchObject({
      motivo: 'tetto_bot2', tettoMotivo: 'tetto_raggiunto', tetto: 150, oggi: 150,
    });
  });

  it('conteggio del tetto illeggibile: numero storico (fail-closed)', async () => {
    const { supabase } = makeSupabase(0, true);
    expect(await scegli(supabase, IN_QUOTA, impostazioni(9))).toMatchObject({ ripiego: 'tetto_bot2' });
  });

  it('lancio_sender=secondario vince sulla quota: va tutto sul numero nuovo', async () => {
    const { supabase } = makeSupabase();
    for (const chiave of [IN_QUOTA, FUORI_QUOTA]) {
      expect(await scegli(supabase, chiave, impostazioni(0, 'secondario'))).toEqual(
        { from: SECONDO, secondario: true, scelta: 'sender', ripiego: null },
      );
    }
  });

  it('lancio_sender=secondario passa comunque dalla verifica del template', async () => {
    vi.mocked(assertTemplateSendable).mockRejectedValue(new Error('bloccato'));
    const { supabase, eventi } = makeSupabase();
    expect(await scegli(supabase, FUORI_QUOTA, impostazioni(0, 'secondario'))).toMatchObject(
      { from: PRIMARIO, scelta: 'sender', ripiego: 'template_bloccato' },
    );
    expect(eventi[0].type).toBe('lancio_mittente_ripiego');
  });

  // Il tetto e' la manopola del riscaldamento ordinario: una scelta umana dal pannello
  // non se la deve vedere rimangiare a meta' giornata, in silenzio.
  it('lancio_sender=secondario non passa dal tetto del riscaldamento', async () => {
    const { supabase } = makeSupabase(150);
    expect(await scegli(supabase, FUORI_QUOTA, impostazioni(0, 'secondario'))).toMatchObject(
      { from: SECONDO, secondario: true },
    );
  });
});

describe('una chat che esiste gia non cambia numero', () => {
  it('la quota non entra nemmeno in gioco: comanda wa_number', () => {
    vi.stubEnv('TWILIO_WHATSAPP_NUMBER_FENICE', PRIMARIO);
    vi.stubEnv('TWILIO_WHATSAPP_NUMBER_FENICE_2', SECONDO);
    // Un lead che la quota manderebbe sul numero nuovo, ma la cui chat e' nata sul
    // vecchio: resta sul vecchio. E viceversa.
    expect(toccaAlSecondario(IN_QUOTA, 100)).toBe(true);
    expect(mittenteDiConversazione({ wa_number: PRIMARIO })).toBe(PRIMARIO);
    expect(mittenteDiConversazione({ wa_number: SECONDO })).toBe(SECONDO);
    // Nata prima che si scrivesse il numero alla nascita: numero storico, non la quota.
    expect(mittenteDiConversazione({ wa_number: null })).toBe(PRIMARIO);
  });
});
