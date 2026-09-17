import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { templatePerMittente, traduciTemplate, _svuotaCacheTemplate } from './template-account';

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

// La lista di sblocco `UTILITY_ONLY_ALLOW` parla la lingua dell'account storico.
// Se non valesse anche per il SID di partenza, ogni apertura dal secondo numero
// verrebbe bloccata pur essendo lo stesso messaggio gia' autorizzato altrove:
// e' successo davvero, 32 aperture su 32 al primo giro del riscaldamento.
describe('lista di sblocco fra i due account', () => {
  it('sblocca anche quando in lista c e solo il SID di partenza', async () => {
    const { assertTemplateSendable } = await import('./twilio');
    const salva = { u: process.env.UTILITY_ONLY, a: process.env.UTILITY_ONLY_ALLOW };
    process.env.UTILITY_ONLY = '1';
    process.env.UTILITY_ONLY_ALLOW = 'HXoriginale';
    try {
      // `HXtradotto` non e' in lista, ma `HXoriginale` si: non deve lanciare.
      await expect(assertTemplateSendable('HXtradotto', '+393522070047', 'HXoriginale')).resolves.toBeUndefined();
    } finally {
      if (salva.u === undefined) delete process.env.UTILITY_ONLY; else process.env.UTILITY_ONLY = salva.u;
      if (salva.a === undefined) delete process.env.UTILITY_ONLY_ALLOW; else process.env.UTILITY_ONLY_ALLOW = salva.a;
    }
  });
});


describe('traduciTemplate: dice se ha tradotto davvero', () => {
  it('template presente sul secondo account: tradotto', async () => {
    fingiApi({ nomeSuAccount1: 'fenice_open_v1', contenutiAccount2: [{ friendly_name: 'fenice_open_v1', sid: 'HXtradotto' }] });
    expect(await traduciTemplate('HXoriginale', SECONDO)).toEqual({ sid: 'HXtradotto', tradotto: true });
  });

  it('template ASSENTE sul secondo account: NON tradotto, cosi chi chiama puo ripiegare', async () => {
    fingiApi({ nomeSuAccount1: 'fenice_agenda_gdo_v3', contenutiAccount2: [{ friendly_name: 'fenice_open_v1', sid: 'HXaltro' }] });
    expect(await traduciTemplate('HXagenda', SECONDO)).toEqual({ sid: 'HXagenda', tradotto: false });
  });

  it('nome non leggibile sull account di origine: NON tradotto', async () => {
    fingiApi({ nomeSuAccount1: null });
    expect(await traduciTemplate('HXoriginale', SECONDO)).toEqual({ sid: 'HXoriginale', tradotto: false });
  });

  it('dal numero storico non c e niente da tradurre, e non e un fallimento', async () => {
    fingiApi({ nomeSuAccount1: 'x' });
    expect(await traduciTemplate('HXoriginale', PRIMARIO)).toEqual({ sid: 'HXoriginale', tradotto: true });
  });

  it('un indice vuoto NON resta in cache: un errore di rete non deve avvelenare l istanza', async () => {
    // Primo giro: l'API del secondo account non torna niente.
    fingiApi({ nomeSuAccount1: 'fenice_open_v1', contenutiAccount2: [] });
    expect((await traduciTemplate('HXoriginale', SECONDO)).tradotto).toBe(false);
    // Secondo giro: l'API si e' ripresa. Se l'indice vuoto fosse rimasto in
    // cache, questa traduzione fallirebbe per sempre.
    fingiApi({ nomeSuAccount1: 'fenice_open_v1', contenutiAccount2: [{ friendly_name: 'fenice_open_v1', sid: 'HXtradotto' }] });
    expect(await traduciTemplate('HXoriginale', SECONDO)).toEqual({ sid: 'HXtradotto', tradotto: true });
  });
});


// Lo stesso template puo' avere categorie diverse sui due account: e' Meta a
// deciderla alla sottomissione, e la copia sul secondo account e' stata
// sottomessa a parte. `fenice_agenda_gdo_v3` e' UTILITY sull'account storico e
// MARKETING su quello nuovo, con lo stesso identico testo.
describe('presidio UTILITY_ONLY fra i due account', () => {
  /** Finge le due API: categorie diverse per lo stesso template sui due account. */
  function fingiCategorie(catSecondo: string, catOriginale: string) {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: any) => {
      const auth = String(init?.headers?.Authorization ?? '');
      const eSecondo = auth.includes(Buffer.from('AC_secondo:tok_secondo').toString('base64'));
      if (url.includes('/ApprovalRequests')) {
        return { ok: true, status: 200, json: async () => ({ whatsapp: { category: eSecondo ? catSecondo : catOriginale } }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    }));
  }

  async function conPresidio(fn: () => Promise<void>) {
    const salva = { u: process.env.UTILITY_ONLY, a: process.env.UTILITY_ONLY_ALLOW };
    process.env.UTILITY_ONLY = '1';
    process.env.UTILITY_ONLY_ALLOW = '';
    try { await fn(); } finally {
      if (salva.u === undefined) delete process.env.UTILITY_ONLY; else process.env.UTILITY_ONLY = salva.u;
      if (salva.a === undefined) delete process.env.UTILITY_ONLY_ALLOW; else process.env.UTILITY_ONLY_ALLOW = salva.a;
    }
  }

  it('MARKETING sul secondo ma UTILITY sull originale: PASSA, decide l originale', async () => {
    const { assertTemplateSendable } = await import('./twilio');
    fingiCategorie('MARKETING', 'UTILITY');
    await conPresidio(async () => {
      await expect(assertTemplateSendable('HXagendaDue', SECONDO, 'HXagendaUno')).resolves.toBeUndefined();
    });
  });

  it('MARKETING su ENTRAMBI: resta bloccato, il presidio non si sfonda', async () => {
    const { assertTemplateSendable } = await import('./twilio');
    fingiCategorie('MARKETING', 'MARKETING');
    await conPresidio(async () => {
      await expect(assertTemplateSendable('HXapreDue', SECONDO, 'HXapreUno')).rejects.toThrow(/bloccato/);
    });
  });

  it('senza traduzione (un solo account) la categoria originale non si consulta', async () => {
    const { assertTemplateSendable } = await import('./twilio');
    fingiCategorie('MARKETING', 'UTILITY');
    await conPresidio(async () => {
      // stesso SID: non c e stata traduzione, quindi niente seconda opinione.
      await expect(assertTemplateSendable('HXuguale', SECONDO, 'HXuguale')).rejects.toThrow(/bloccato/);
    });
  });
});
