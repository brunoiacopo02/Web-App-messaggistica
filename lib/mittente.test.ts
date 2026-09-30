import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mittentePerNuovaConversazione,
  mittenteDiConversazione,
  eNumeroDelBot,
  numeriDelBot,
  numeriSecondari,
} from './mittente';

const PRIMARIO = 'whatsapp:+393520413199';
const SECONDO = 'whatsapp:+393522070047';

const CHIAVI = [
  'TWILIO_WHATSAPP_NUMBER_FENICE',
  'TWILIO_WHATSAPP_NUMBER_FENICE_2',
  'FENICE_NUMERO2_QUOTA',
  'BOT_NUMERI_SECONDARI',
  'TWILIO_WHATSAPP_NUMBERS_2',
  'TWILIO_WHATSAPP_NUMBERS_3',
] as const;

let salvate: Record<string, string | undefined>;

beforeEach(() => {
  salvate = Object.fromEntries(CHIAVI.map((k) => [k, process.env[k]]));
  process.env.TWILIO_WHATSAPP_NUMBER_FENICE = PRIMARIO;
  process.env.TWILIO_WHATSAPP_NUMBER_FENICE_2 = SECONDO;
  delete process.env.FENICE_NUMERO2_QUOTA;
  delete process.env.BOT_NUMERI_SECONDARI;
  delete process.env.TWILIO_WHATSAPP_NUMBERS_2;
  delete process.env.TWILIO_WHATSAPP_NUMBERS_3;
});

afterEach(() => {
  for (const k of CHIAVI) {
    if (salvate[k] === undefined) delete process.env[k];
    else process.env[k] = salvate[k];
  }
});

/** Un sorteggio fisso: `Math.random` che torna sempre lo stesso valore in [0, 1). */
const sorteggio = (v: number) => () => v;

// Il sorteggio FENICE_NUMERO2_QUOTA e' stato tolto da mittentePerNuovaConversazione
// (vedi describe piu' sotto e il commento nel modulo): quotaSecondo() e' sparita con lui.

describe('mittentePerNuovaConversazione', () => {
  it('sempre il primario, qualunque sia il sorteggio o la quota', () => {
    process.env.FENICE_NUMERO2_QUOTA = '100';
    expect(mittentePerNuovaConversazione(sorteggio(0))).toBe(PRIMARIO);
    expect(mittentePerNuovaConversazione(sorteggio(0.999))).toBe(PRIMARIO);
  });

  it('secondo numero assente: resta il primario', () => {
    delete process.env.TWILIO_WHATSAPP_NUMBER_FENICE_2;
    process.env.FENICE_NUMERO2_QUOTA = '100';
    expect(mittentePerNuovaConversazione(sorteggio(0))).toBe(PRIMARIO);
  });

  it('senza nemmeno il primario torna undefined: chi chiama deve fallire', () => {
    delete process.env.TWILIO_WHATSAPP_NUMBER_FENICE;
    expect(mittentePerNuovaConversazione(sorteggio(0.5))).toBeUndefined();
  });

  it('di default (senza sorteggio esplicito) resta il primario', () => {
    process.env.FENICE_NUMERO2_QUOTA = '50';
    for (let i = 0; i < 20; i++) {
      expect(mittentePerNuovaConversazione()).toBe(PRIMARIO);
    }
  });
});

describe('numeri secondari', () => {
  it('senza BOT_NUMERI_SECONDARI vale il solo numero 2 di sempre', () => {
    delete process.env.BOT_NUMERI_SECONDARI;
    process.env.TWILIO_WHATSAPP_NUMBER_FENICE_2 = 'whatsapp:+393522070047';
    expect(numeriSecondari()).toEqual(['whatsapp:+393522070047']);
  });

  it('con BOT_NUMERI_SECONDARI vale l elenco, pulito da spazi e vuoti', () => {
    process.env.BOT_NUMERI_SECONDARI = ' whatsapp:+393522070047, whatsapp:+393522018718 ,,whatsapp:+393520158061 ';
    expect(numeriSecondari()).toEqual([
      'whatsapp:+393522070047', 'whatsapp:+393522018718', 'whatsapp:+393520158061',
    ]);
  });

  it('il primario non compare due volte anche se messo per errore fra i secondari', () => {
    process.env.BOT_NUMERI_SECONDARI = 'whatsapp:+393520413199,whatsapp:+393522018718';
    // Il 0047 in coda: fuori dai sceglibili ma riconosciuto, perche' sta in FENICE_2.
    expect(numeriDelBot()).toEqual(['whatsapp:+393520413199', 'whatsapp:+393522018718', 'whatsapp:+393522070047']);
    expect(numeriSecondari()).toEqual(['whatsapp:+393522018718']);
  });

  it('eNumeroDelBot riconosce tutti i secondari, con e senza prefisso', () => {
    process.env.BOT_NUMERI_SECONDARI = 'whatsapp:+393522018718,whatsapp:+393520158061';
    expect(eNumeroDelBot('whatsapp:+393522018718')).toBe(true);
    expect(eNumeroDelBot('+393520158061')).toBe(true);
    expect(eNumeroDelBot('whatsapp:+15559919332')).toBe(false);
  });

  it('una chat nuova senza scelta esplicita nasce sempre sul primario, qualunque quota', () => {
    process.env.FENICE_NUMERO2_QUOTA = '100';
    expect(mittentePerNuovaConversazione(() => 0)).toBe('whatsapp:+393520413199');
  });
});

describe('mittenteDiConversazione', () => {
  it('con wa_number vale quello, anche se la quota direbbe altro', () => {
    process.env.FENICE_NUMERO2_QUOTA = '100';
    expect(mittenteDiConversazione({ wa_number: PRIMARIO })).toBe(PRIMARIO);
    process.env.FENICE_NUMERO2_QUOTA = '0';
    expect(mittenteDiConversazione({ wa_number: SECONDO })).toBe(SECONDO);
  });

  it('senza wa_number vale il primario: sono le conversazioni nate prima', () => {
    expect(mittenteDiConversazione({ wa_number: null })).toBe(PRIMARIO);
    expect(mittenteDiConversazione({ wa_number: '' })).toBe(PRIMARIO);
    expect(mittenteDiConversazione({})).toBe(PRIMARIO);
    expect(mittenteDiConversazione(null)).toBe(PRIMARIO);
    expect(mittenteDiConversazione(undefined)).toBe(PRIMARIO);
  });

  // Il DB e' condiviso con campagne e Serenamente: un `wa_number` che non e' del bot
  // non deve far partire Mario da quel numero.
  it('un wa_number che non e del bot ripiega sul primario', () => {
    expect(mittenteDiConversazione({ wa_number: 'whatsapp:+390000000000' })).toBe(PRIMARIO);
  });

  it('il secondo numero resta valido finche sta in env: tolto, si ripiega', () => {
    delete process.env.TWILIO_WHATSAPP_NUMBER_FENICE_2;
    expect(mittenteDiConversazione({ wa_number: SECONDO })).toBe(PRIMARIO);
  });

  it('torna il valore come sta a DB, senza rinormalizzarlo', () => {
    // `sendTemplate` lo passa a Twilio cosi' com'e': deve restare `whatsapp:+…`.
    expect(mittenteDiConversazione({ wa_number: SECONDO })).toBe(SECONDO);
  });
});

describe('eNumeroDelBot', () => {
  it('true su entrambi i numeri, con e senza prefisso whatsapp:', () => {
    expect(eNumeroDelBot(PRIMARIO)).toBe(true);
    expect(eNumeroDelBot(SECONDO)).toBe(true);
    expect(eNumeroDelBot('+393520413199')).toBe(true);
    expect(eNumeroDelBot('+393522070047')).toBe(true);
  });

  it('false su un numero estraneo', () => {
    expect(eNumeroDelBot('whatsapp:+390000000000')).toBe(false);
  });

  it('false su null, undefined e vuoto', () => {
    expect(eNumeroDelBot(null)).toBe(false);
    expect(eNumeroDelBot(undefined)).toBe(false);
    expect(eNumeroDelBot('')).toBe(false);
  });

  it('senza il secondo numero in env conosce solo il primario', () => {
    delete process.env.TWILIO_WHATSAPP_NUMBER_FENICE_2;
    expect(eNumeroDelBot(PRIMARIO)).toBe(true);
    expect(eNumeroDelBot(SECONDO)).toBe(false);
  });

  it('senza nessun numero in env non riconosce niente', () => {
    delete process.env.TWILIO_WHATSAPP_NUMBER_FENICE;
    delete process.env.TWILIO_WHATSAPP_NUMBER_FENICE_2;
    expect(eNumeroDelBot(PRIMARIO)).toBe(false);
  });
});

describe('numeriDelBot', () => {
  // Grezzi, col prefisso: e' la forma di `wa_number` a DB, quella che serve ai filtri.
  it('elenca i numeri come stanno in env, primario per primo', () => {
    expect(numeriDelBot()).toEqual([PRIMARIO, SECONDO]);
  });

  it('salta quelli assenti', () => {
    delete process.env.TWILIO_WHATSAPP_NUMBER_FENICE_2;
    expect(numeriDelBot()).toEqual([PRIMARIO]);
  });
});

// Riconosciuto (il webhook sveglia Mario, la chat continua dal suo numero) e
// sceglibile (puo' far nascere chat nuove) sono due cose diverse: dimenticare un
// numero in BOT_NUMERI_SECONDARI non deve rompere le chat vive che ha gia'.
describe('riconosciuti vs sceglibili', () => {
  const ELIXIR = 'whatsapp:+393522018718';
  const N8061 = 'whatsapp:+393520158061';

  it('0047 non in BOT_NUMERI_SECONDARI ma in FENICE_2: riconosciuto, la sua chat continua da li', () => {
    process.env.BOT_NUMERI_SECONDARI = ELIXIR;
    expect(numeriSecondari()).toEqual([ELIXIR]);
    expect(eNumeroDelBot(SECONDO)).toBe(true);
    expect(mittenteDiConversazione({ wa_number: SECONDO })).toBe(SECONDO);
  });

  it('un numero dichiarato solo in TWILIO_WHATSAPP_NUMBERS_3 e riconosciuto (anche senza prefisso)', () => {
    process.env.BOT_NUMERI_SECONDARI = '';
    process.env.TWILIO_WHATSAPP_NUMBERS_3 = '+393522018718';
    expect(eNumeroDelBot(ELIXIR)).toBe(true);
    expect(numeriDelBot()).toContain(ELIXIR);
    expect(numeriSecondari()).toEqual([]);
  });

  it('BOT_NUMERI_SECONDARI vuota: nessun sceglibile, ma il 0047 di FENICE_2 resta riconosciuto', () => {
    process.env.BOT_NUMERI_SECONDARI = '';
    expect(numeriSecondari()).toEqual([]);
    expect(eNumeroDelBot(SECONDO)).toBe(true);
    expect(mittenteDiConversazione({ wa_number: SECONDO })).toBe(SECONDO);
  });

  it('numeriDelBot: unione deduplicata, primario per primo, tutti in forma whatsapp:+', () => {
    process.env.BOT_NUMERI_SECONDARI = `${ELIXIR},+393520158061`;
    process.env.TWILIO_WHATSAPP_NUMBERS_2 = '+393522070047';
    process.env.TWILIO_WHATSAPP_NUMBERS_3 = `+393522018718, ${PRIMARIO}`;
    expect(numeriDelBot()).toEqual([PRIMARIO, ELIXIR, N8061, SECONDO]);
  });

  it('una voce senza prefisso in BOT_NUMERI_SECONDARI diventa whatsapp:+…', () => {
    process.env.BOT_NUMERI_SECONDARI = '+393522018718, whatsapp:+393520158061';
    expect(numeriSecondari()).toEqual([ELIXIR, N8061]);
  });

  it('anche il ripiego FENICE_2 senza prefisso viene normalizzato', () => {
    process.env.TWILIO_WHATSAPP_NUMBER_FENICE_2 = '+393522070047';
    expect(numeriSecondari()).toEqual([SECONDO]);
    expect(numeriDelBot()).toEqual([PRIMARIO, SECONDO]);
  });
});
