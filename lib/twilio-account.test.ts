import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { credenzialiPerMittente, eDelSecondoAccount, eSuAltroAccount, credenzialiSecondarie } from './twilio-account';

const CHIAVI = [
  'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN',
  'TWILIO_ACCOUNT_SID_2', 'TWILIO_AUTH_TOKEN_2',
  'TWILIO_WHATSAPP_NUMBERS_2',
  'TWILIO_ACCOUNT_SID_3', 'TWILIO_AUTH_TOKEN_3',
  'TWILIO_WHATSAPP_NUMBERS_3',
] as const;

let salvate: Record<string, string | undefined>;

beforeEach(() => {
  salvate = Object.fromEntries(CHIAVI.map((k) => [k, process.env[k]]));
  process.env.TWILIO_ACCOUNT_SID = 'AC_primo';
  process.env.TWILIO_AUTH_TOKEN = 'tok_primo';
  process.env.TWILIO_ACCOUNT_SID_2 = 'AC_secondo';
  process.env.TWILIO_AUTH_TOKEN_2 = 'tok_secondo';
  process.env.TWILIO_WHATSAPP_NUMBERS_2 = '+393522070047';
});

afterEach(() => {
  for (const k of CHIAVI) {
    if (salvate[k] === undefined) delete process.env[k];
    else process.env[k] = salvate[k];
  }
});

describe('credenzialiPerMittente', () => {
  it('un numero del secondo account usa le sue credenziali', () => {
    expect(credenzialiPerMittente('+393522070047')).toEqual({ sid: 'AC_secondo', token: 'tok_secondo' });
  });

  it('riconosce il numero anche col prefisso whatsapp:', () => {
    expect(credenzialiPerMittente('whatsapp:+393522070047')?.sid).toBe('AC_secondo');
  });

  it('un numero non elencato resta sul primo account', () => {
    expect(credenzialiPerMittente('+393520413199')?.sid).toBe('AC_primo');
  });

  it('senza mittente vale il primo account: e il comportamento di sempre', () => {
    expect(credenzialiPerMittente()?.sid).toBe('AC_primo');
    expect(credenzialiPerMittente(null)?.sid).toBe('AC_primo');
  });

  it('piu numeri sul secondo account, separati da virgola e con spazi', () => {
    process.env.TWILIO_WHATSAPP_NUMBERS_2 = ' +393522070047 , +393522660042 ';
    expect(credenzialiPerMittente('+393522660042')?.sid).toBe('AC_secondo');
    expect(credenzialiPerMittente('+393522070047')?.sid).toBe('AC_secondo');
  });

  it('senza elenco di numeri tutto resta sul primo account', () => {
    delete process.env.TWILIO_WHATSAPP_NUMBERS_2;
    expect(credenzialiPerMittente('+393522070047')?.sid).toBe('AC_primo');
  });

  // Caso storto: numero dichiarato del secondo account ma credenziali assenti.
  // Ripiegare sul primo darebbe comunque un 401 all'invio, ma almeno il resto
  // del traffico non si ferma e il log dice cos'e' successo.
  it('numero del secondo account senza credenziali: ripiega sul primo', () => {
    delete process.env.TWILIO_ACCOUNT_SID_2;
    delete process.env.TWILIO_AUTH_TOKEN_2;
    expect(credenzialiPerMittente('+393522070047')?.sid).toBe('AC_primo');
  });

  it('senza nemmeno le credenziali principali torna null: chi chiama deve fallire', () => {
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
    delete process.env.TWILIO_ACCOUNT_SID_2;
    delete process.env.TWILIO_AUTH_TOKEN_2;
    expect(credenzialiPerMittente('+393520413199')).toBeNull();
  });

  it('credenziali a meta non valgono come account configurato', () => {
    delete process.env.TWILIO_AUTH_TOKEN_2;
    expect(credenzialiPerMittente('+393522070047')?.sid).toBe('AC_primo');
  });
});

describe('eDelSecondoAccount', () => {
  it('true solo per i numeri elencati', () => {
    expect(eDelSecondoAccount('+393522070047')).toBe(true);
    expect(eDelSecondoAccount('whatsapp:+393522070047')).toBe(true);
    expect(eDelSecondoAccount('+393520413199')).toBe(false);
  });

  it('false senza numero', () => {
    expect(eDelSecondoAccount()).toBe(false);
    expect(eDelSecondoAccount('')).toBe(false);
    expect(eDelSecondoAccount(null)).toBe(false);
  });
});

describe('terzo account', () => {
  beforeEach(() => {
    process.env.TWILIO_ACCOUNT_SID_3 = 'AC_terzo';
    process.env.TWILIO_AUTH_TOKEN_3 = 'tok_terzo';
    process.env.TWILIO_WHATSAPP_NUMBERS_3 = 'whatsapp:+393522018718';
  });

  it('un numero del terzo account usa le sue credenziali', () => {
    expect(credenzialiPerMittente('+393522018718')).toEqual({ sid: 'AC_terzo', token: 'tok_terzo' });
    expect(credenzialiPerMittente('whatsapp:+393522018718')?.sid).toBe('AC_terzo');
  });

  it('il secondo account resta com era', () => {
    expect(credenzialiPerMittente('+393522070047')?.sid).toBe('AC_secondo');
  });

  it('un numero secondario che sta sul principale (8061) usa il principale e non e su un altro account', () => {
    expect(credenzialiPerMittente('whatsapp:+393520158061')?.sid).toBe('AC_primo');
    expect(eSuAltroAccount('whatsapp:+393520158061')).toBe(false);
  });

  it('eSuAltroAccount vale per secondo e terzo; eDelSecondoAccount e un alias', () => {
    expect(eSuAltroAccount('+393522018718')).toBe(true);
    expect(eSuAltroAccount('+393522070047')).toBe(true);
    expect(eDelSecondoAccount('+393522018718')).toBe(true);
  });

  it('terzo account senza credenziali: ripiega sul primo', () => {
    delete process.env.TWILIO_AUTH_TOKEN_3;
    expect(credenzialiPerMittente('+393522018718')?.sid).toBe('AC_primo');
  });

  it('credenzialiSecondarie elenca solo gli account configurati', () => {
    expect(credenzialiSecondarie().map((c) => c.sid)).toEqual(['AC_secondo', 'AC_terzo']);
    delete process.env.TWILIO_ACCOUNT_SID_2;
    expect(credenzialiSecondarie().map((c) => c.sid)).toEqual(['AC_terzo']);
  });
});
