import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mittentePerNuovaConversazione,
  mittenteDiConversazione,
  eNumeroDelBot,
  numeriDelBot,
  quotaSecondo,
} from './mittente';

const PRIMARIO = 'whatsapp:+393520413199';
const SECONDO = 'whatsapp:+393522070047';

const CHIAVI = [
  'TWILIO_WHATSAPP_NUMBER_FENICE',
  'TWILIO_WHATSAPP_NUMBER_FENICE_2',
  'FENICE_NUMERO2_QUOTA',
] as const;

let salvate: Record<string, string | undefined>;

beforeEach(() => {
  salvate = Object.fromEntries(CHIAVI.map((k) => [k, process.env[k]]));
  process.env.TWILIO_WHATSAPP_NUMBER_FENICE = PRIMARIO;
  process.env.TWILIO_WHATSAPP_NUMBER_FENICE_2 = SECONDO;
  delete process.env.FENICE_NUMERO2_QUOTA;
});

afterEach(() => {
  for (const k of CHIAVI) {
    if (salvate[k] === undefined) delete process.env[k];
    else process.env[k] = salvate[k];
  }
});

/** Un sorteggio fisso: `Math.random` che torna sempre lo stesso valore in [0, 1). */
const sorteggio = (v: number) => () => v;

describe('quotaSecondo', () => {
  it('assente o vuota vale 0', () => {
    expect(quotaSecondo()).toBe(0);
    process.env.FENICE_NUMERO2_QUOTA = '   ';
    expect(quotaSecondo()).toBe(0);
  });

  it('legge una percentuale, anche con spazi e decimali', () => {
    process.env.FENICE_NUMERO2_QUOTA = ' 30 ';
    expect(quotaSecondo()).toBe(30);
    process.env.FENICE_NUMERO2_QUOTA = '12.5';
    expect(quotaSecondo()).toBe(12.5);
  });

  // Fail-closed: una env scritta male non deve spostare traffico.
  it('illeggibile o fuori da 0-100 vale 0', () => {
    for (const v of ['abc', '30%', '-5', '101', 'NaN', 'Infinity']) {
      process.env.FENICE_NUMERO2_QUOTA = v;
      expect(quotaSecondo(), `quota "${v}"`).toBe(0);
    }
  });
});

describe('mittentePerNuovaConversazione', () => {
  it('quota assente: sempre il primario, qualunque sia il sorteggio', () => {
    expect(mittentePerNuovaConversazione(sorteggio(0))).toBe(PRIMARIO);
    expect(mittentePerNuovaConversazione(sorteggio(0.999))).toBe(PRIMARIO);
  });

  it('quota 0: sempre il primario', () => {
    process.env.FENICE_NUMERO2_QUOTA = '0';
    expect(mittentePerNuovaConversazione(sorteggio(0))).toBe(PRIMARIO);
  });

  it('quota 100: sempre il secondo', () => {
    process.env.FENICE_NUMERO2_QUOTA = '100';
    expect(mittentePerNuovaConversazione(sorteggio(0))).toBe(SECONDO);
    expect(mittentePerNuovaConversazione(sorteggio(0.999999))).toBe(SECONDO);
  });

  it('quota 30: il secondo sotto la soglia, il primario sopra', () => {
    process.env.FENICE_NUMERO2_QUOTA = '30';
    expect(mittentePerNuovaConversazione(sorteggio(0.29))).toBe(SECONDO);
    expect(mittentePerNuovaConversazione(sorteggio(0.3))).toBe(PRIMARIO);
    expect(mittentePerNuovaConversazione(sorteggio(0.9))).toBe(PRIMARIO);
  });

  it('secondo numero assente: il primario anche con quota alta', () => {
    delete process.env.TWILIO_WHATSAPP_NUMBER_FENICE_2;
    process.env.FENICE_NUMERO2_QUOTA = '100';
    expect(mittentePerNuovaConversazione(sorteggio(0))).toBe(PRIMARIO);
  });

  it('quota illeggibile: il primario', () => {
    process.env.FENICE_NUMERO2_QUOTA = 'cento';
    expect(mittentePerNuovaConversazione(sorteggio(0))).toBe(PRIMARIO);
  });

  it('senza nemmeno il primario torna undefined: chi chiama deve fallire', () => {
    delete process.env.TWILIO_WHATSAPP_NUMBER_FENICE;
    expect(mittentePerNuovaConversazione(sorteggio(0.5))).toBeUndefined();
  });

  it('di default sorteggia con Math.random e resta dentro i due numeri', () => {
    process.env.FENICE_NUMERO2_QUOTA = '50';
    for (let i = 0; i < 20; i++) {
      expect([PRIMARIO, SECONDO]).toContain(mittentePerNuovaConversazione());
    }
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
