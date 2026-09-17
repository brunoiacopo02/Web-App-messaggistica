import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { templatePerMittente, _svuotaCacheTemplate } from './template-account';

const CHIAVI = [
  'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN',
  'TWILIO_ACCOUNT_SID_2', 'TWILIO_AUTH_TOKEN_2',
  'TWILIO_WHATSAPP_NUMBERS_2',
] as const;

let salvate: Record<string, string | undefined>;
const PRIMARIO = '+393520413199';
const SECONDO = '+393522070047';

/** Le risposte che darebbe l'API Content dei due account. */
function fingiApi(opts: { nomeSuAccount1?: string | null; contenutiAccount2?: Array<{ friendly_name: string; sid: string }> }) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: any) => {
    const auth = String(init?.headers?.Authorization ?? '');
    const eSecondo = auth.includes(Buffer.from('AC_secondo:tok_secondo').toString('base64'));

    if (!eSecondo && url.includes('/Content/')) {
      if (opts.nomeSuAccount1 === null) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ friendly_name: opts.nomeSuAccount1 }) };
    }
    if (eSecondo && url.includes('/Content?')) {
      return { ok: true, status: 200, json: async () => ({ contents: opts.contenutiAccount2 ?? [], meta: {} }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  }));
}

beforeEach(() => {
  salvate = Object.fromEntries(CHIAVI.map((k) => [k, process.env[k]]));
  process.env.TWILIO_ACCOUNT_SID = 'AC_primo';
  process.env.TWILIO_AUTH_TOKEN = 'tok_primo';
  process.env.TWILIO_ACCOUNT_SID_2 = 'AC_secondo';
  process.env.TWILIO_AUTH_TOKEN_2 = 'tok_secondo';
  process.env.TWILIO_WHATSAPP_NUMBERS_2 = SECONDO;
  _svuotaCacheTemplate();
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of CHIAVI) {
    if (salvate[k] === undefined) delete process.env[k];
    else process.env[k] = salvate[k];
  }
});

describe('templatePerMittente', () => {
  it('dal numero storico non traduce e non tocca la rete', async () => {
    const spia = vi.fn();
    vi.stubGlobal('fetch', spia);
    expect(await templatePerMittente('HXoriginale', PRIMARIO)).toBe('HXoriginale');
    expect(spia).not.toHaveBeenCalled();
  });

  it('senza mittente non traduce', async () => {
    const spia = vi.fn();
    vi.stubGlobal('fetch', spia);
    expect(await templatePerMittente('HXoriginale')).toBe('HXoriginale');
    expect(spia).not.toHaveBeenCalled();
  });

  it('dal secondo numero traduce sul SID omonimo', async () => {
    fingiApi({
      nomeSuAccount1: 'fenice_agenda_gdo_v3',
      contenutiAccount2: [
        { friendly_name: 'fenice_open_c1_marta_v1', sid: 'HXaltro' },
        { friendly_name: 'fenice_agenda_gdo_v3', sid: 'HXtradotto' },
      ],
    });
    expect(await templatePerMittente('HXoriginale', SECONDO)).toBe('HXtradotto');
  });

  it('riconosce il numero anche col prefisso whatsapp:', async () => {
    fingiApi({
      nomeSuAccount1: 'fenice_agenda_gdo_v3',
      contenutiAccount2: [{ friendly_name: 'fenice_agenda_gdo_v3', sid: 'HXtradotto' }],
    });
    expect(await templatePerMittente('HXoriginale', `whatsapp:${SECONDO}`)).toBe('HXtradotto');
  });

  // Meglio un 404 visibile nei log che un messaggio diverso da quello previsto.
  it('se il template non esiste sul secondo account torna il SID originale', async () => {
    fingiApi({ nomeSuAccount1: 'fenice_mai_copiato_v1', contenutiAccount2: [] });
    expect(await templatePerMittente('HXoriginale', SECONDO)).toBe('HXoriginale');
  });

  it('se il nome non e leggibile sull account di origine torna il SID originale', async () => {
    fingiApi({ nomeSuAccount1: null });
    expect(await templatePerMittente('HXoriginale', SECONDO)).toBe('HXoriginale');
  });

  it('la seconda traduzione non richiama la rete', async () => {
    fingiApi({
      nomeSuAccount1: 'fenice_agenda_gdo_v3',
      contenutiAccount2: [{ friendly_name: 'fenice_agenda_gdo_v3', sid: 'HXtradotto' }],
    });
    await templatePerMittente('HXoriginale', SECONDO);
    const chiamatePrima = (globalThis.fetch as any).mock.calls.length;
    expect(await templatePerMittente('HXoriginale', SECONDO)).toBe('HXtradotto');
    expect((globalThis.fetch as any).mock.calls.length).toBe(chiamatePrima);
  });

  it('senza credenziali del secondo account non traduce', async () => {
    delete process.env.TWILIO_ACCOUNT_SID_2;
    delete process.env.TWILIO_AUTH_TOKEN_2;
    const spia = vi.fn();
    vi.stubGlobal('fetch', spia);
    expect(await templatePerMittente('HXoriginale', SECONDO)).toBe('HXoriginale');
    expect(spia).not.toHaveBeenCalled();
  });
});
