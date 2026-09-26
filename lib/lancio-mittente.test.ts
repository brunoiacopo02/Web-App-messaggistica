import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./twilio', () => ({ assertTemplateSendable: vi.fn(async () => undefined) }));
vi.mock('./template-account', () => ({
  traduciTemplate: vi.fn(async (sid: string) => ({ sid: `${sid}_2`, tradotto: true })),
}));
vi.mock('./scelta-mittente', () => ({ scegliMittenteNuovo: vi.fn() }));

import {
  posizioneQuota,
  toccaAlSecondario,
  spedibileDa,
  mittenteBenvenutoLancio,
} from './lancio-mittente';
import { mittenteDiConversazione } from './mittente';
import { assertTemplateSendable } from './twilio';
import { traduciTemplate } from './template-account';
import { scegliMittenteNuovo } from './scelta-mittente';

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

const impostazioni = (quotaSecondario: number, sender: 'principale' | 'secondario' = 'principale') =>
  ({ sender, quotaSecondario }) as const;

beforeEach(() => {
  vi.mocked(assertTemplateSendable).mockReset().mockResolvedValue(undefined);
  vi.mocked(traduciTemplate).mockReset().mockImplementation(
    async (sid: string) => ({ sid: `${sid}_2`, tradotto: true }),
  );
  vi.mocked(scegliMittenteNuovo).mockReset();
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
  const ELIXIR = 'whatsapp:+393522018718';
  /** Supabase finto: raccoglie le righe di `event_log`. */
  let eventi: any[];
  let supabase: any;

  beforeEach(() => {
    eventi = [];
    supabase = {
      from: (table: string) => ({
        insert: (riga: any) => { eventi.push({ table, ...riga }); return Promise.resolve({ error: null }); },
      }),
    };
  });

  const scegli = (settings: any, chiave = IN_QUOTA) =>
    mittenteBenvenutoLancio(supabase, { settings, chiave, templateSid: WELCOME, primario: PRIMARIO, crmLeadId: 'crm-1' });

  it('principale e fuori quota: primario, senza chiedere niente a nessuno', async () => {
    const r = await scegli(impostazioni(0, 'principale'));
    expect(r).toEqual({ from: PRIMARIO, secondario: false, scelta: 'principale', ripiego: null });
    expect(scegliMittenteNuovo).not.toHaveBeenCalled();
  });

  it('in quota: chiede la scelta rispettando i tetti', async () => {
    vi.mocked(scegliMittenteNuovo).mockResolvedValueOnce({ from: ELIXIR, secondario: true, scartati: [], motivo: 'scelto' });
    const r = await scegli(impostazioni(9));
    expect(r).toMatchObject({ from: ELIXIR, secondario: true, scelta: 'quota', ripiego: null });
    expect(vi.mocked(scegliMittenteNuovo).mock.calls[0][1]).toMatchObject({ templateSids: [WELCOME], ignoraTetti: false });
  });

  it('sender secondario: ignora i tetti', async () => {
    vi.mocked(scegliMittenteNuovo).mockResolvedValueOnce({ from: ELIXIR, secondario: true, scartati: [], motivo: 'scelto' });
    const r = await scegli(impostazioni(0, 'secondario'), FUORI_QUOTA);
    expect(r).toEqual({ from: ELIXIR, secondario: true, scelta: 'sender', ripiego: null });
    expect(vi.mocked(scegliMittenteNuovo).mock.calls[0][1]).toMatchObject({ ignoraTetti: true });
  });

  it('nessun candidato: primario con il motivo', async () => {
    vi.mocked(scegliMittenteNuovo).mockResolvedValueOnce({ from: PRIMARIO, secondario: false, scartati: [], motivo: 'nessun_candidato' });
    expect(await scegli(impostazioni(9))).toMatchObject({ from: PRIMARIO, secondario: false, ripiego: 'nessun_candidato' });
  });

  // I tre motivi di `scegliMittenteNuovo` sulla mancata scelta: la mappatura verso
  // `MotivoRipiego` non li confonde tra loro.
  it('tetti illeggibili: primario con il motivo', async () => {
    vi.mocked(scegliMittenteNuovo).mockResolvedValueOnce({ from: PRIMARIO, secondario: false, scartati: [], motivo: 'tetti_illeggibili' });
    expect(await scegli(impostazioni(9))).toMatchObject({ from: PRIMARIO, secondario: false, ripiego: 'tetti_illeggibili' });
  });

  it('nessun secondario configurato: primario con il motivo', async () => {
    vi.mocked(scegliMittenteNuovo).mockResolvedValueOnce({ from: PRIMARIO, secondario: false, scartati: [], motivo: 'nessun_secondario' });
    expect(await scegli(impostazioni(9))).toMatchObject({ from: PRIMARIO, secondario: false, ripiego: 'nessun_secondario' });
  });

  // Fix round 1 (revisione Task 6): un ripiego silenzioso sul lancio e' un benvenuto che
  // cambia numero senza che nessuno se ne accorga. Solo qui, non su `scegliMittenteNuovo`:
  // su Mario "nessun secondario" e' lo stato ordinario e non sarebbe una notizia.
  describe('event_log: lancio_mittente_ripiego', () => {
    it('a) in quota ma scegliMittenteNuovo non ha un secondario: una riga warn, scelta quota', async () => {
      vi.mocked(scegliMittenteNuovo).mockResolvedValueOnce(
        { from: PRIMARIO, secondario: false, scartati: [], motivo: 'nessun_secondario' },
      );
      await scegli(impostazioni(9));
      expect(eventi).toHaveLength(1);
      expect(eventi[0]).toMatchObject({ table: 'event_log', type: 'lancio_mittente_ripiego', level: 'warn' });
      expect(eventi[0].payload).toMatchObject({
        chiave: IN_QUOTA, crmLeadId: 'crm-1', scelta: 'quota', motivo: 'nessun_secondario', scartati: [],
      });
    });

    it('b) sender ma nessun candidato spedibile: la riga porta scelta sender e gli scartati', async () => {
      const scartati = [{ numero: ELIXIR, motivo: 'tetto_raggiunto' as const, oggi: 5, tetto: 5 }];
      vi.mocked(scegliMittenteNuovo).mockResolvedValueOnce(
        { from: PRIMARIO, secondario: false, scartati, motivo: 'nessun_candidato' },
      );
      await scegli(impostazioni(0, 'secondario'), FUORI_QUOTA);
      expect(eventi).toHaveLength(1);
      expect(eventi[0].payload).toMatchObject({ scelta: 'sender', motivo: 'nessun_candidato', scartati });
    });

    it('c) scegliMittenteNuovo sceglie un secondario: nessuna riga', async () => {
      vi.mocked(scegliMittenteNuovo).mockResolvedValueOnce({ from: ELIXIR, secondario: true, scartati: [], motivo: 'scelto' });
      await scegli(impostazioni(9));
      expect(eventi).toHaveLength(0);
    });

    it('d) fuori quota: nessuna riga, e scegliMittenteNuovo non si chiama nemmeno', async () => {
      await scegli(impostazioni(9), FUORI_QUOTA);
      expect(eventi).toHaveLength(0);
      expect(scegliMittenteNuovo).not.toHaveBeenCalled();
    });
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
