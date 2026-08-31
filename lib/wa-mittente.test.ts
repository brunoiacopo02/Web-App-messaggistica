import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { numeroMittente, assegnaNumeroMittente, eNumeroDelBot } from './wa-mittente';

const PRIMARIO = 'whatsapp:+393520413199';
const SECONDO = 'whatsapp:+393520158061';

describe('numero mittente', () => {
  const env = { ...process.env };
  beforeEach(() => {
    process.env.TWILIO_WHATSAPP_NUMBER_FENICE = PRIMARIO;
    process.env.TWILIO_WHATSAPP_NUMBER_FENICE_2 = SECONDO;
    delete process.env.FENICE_NUMERO2_QUOTA;
  });
  afterEach(() => { process.env = { ...env }; });

  // La regola che conta: un lead deve vedere sempre lo stesso numero. Cambiarlo a
  // meta' conversazione la spezza in due thread e chiude la finestra 24h aperta.
  it('risponde dal numero con cui la conversazione e\' gia\' iniziata', () => {
    expect(numeroMittente({ wa_number: SECONDO })).toBe(SECONDO);
  });

  it('senza numero salvato usa il primario', () => {
    expect(numeroMittente({ wa_number: null })).toBe(PRIMARIO);
    expect(numeroMittente(null)).toBe(PRIMARIO);
  });

  it('a quota zero assegna sempre il primario, anche col secondo configurato', () => {
    expect(assegnaNumeroMittente(() => 0.01)).toBe(PRIMARIO);
  });

  it('con quota 50 manda al secondo numero solo i sorteggi sotto soglia', () => {
    process.env.FENICE_NUMERO2_QUOTA = '50';
    expect(assegnaNumeroMittente(() => 0.1)).toBe(SECONDO);
    expect(assegnaNumeroMittente(() => 0.9)).toBe(PRIMARIO);
    expect(assegnaNumeroMittente(() => 0.5)).toBe(PRIMARIO);
  });

  // Fail-closed: una quota alzata per sbaglio senza il numero in env non deve
  // produrre invii da un mittente vuoto.
  it('se il secondo numero non e\' configurato resta tutto sul primario', () => {
    process.env.FENICE_NUMERO2_QUOTA = '100';
    delete process.env.TWILIO_WHATSAPP_NUMBER_FENICE_2;
    expect(assegnaNumeroMittente(() => 0.1)).toBe(PRIMARIO);
  });
});

describe('e un numero del bot', () => {
  const env = { ...process.env };
  beforeEach(() => {
    process.env.TWILIO_WHATSAPP_NUMBER_FENICE = PRIMARIO;
    process.env.TWILIO_WHATSAPP_NUMBER_FENICE_2 = SECONDO;
  });
  afterEach(() => { process.env = { ...env }; });

  // Il webhook decide da questo se svegliare il bot. Se il secondo numero non fosse
  // riconosciuto, i lead spostati li' scriverebbero nel vuoto.
  it('riconosce entrambi i numeri del bot', () => {
    expect(eNumeroDelBot(PRIMARIO)).toBe(true);
    expect(eNumeroDelBot(SECONDO)).toBe(true);
  });

  it('non riconosce il numero delle campagne ne un valore mancante', () => {
    expect(eNumeroDelBot('whatsapp:+399999999999')).toBe(false);
    expect(eNumeroDelBot(null)).toBe(false);
    expect(eNumeroDelBot(undefined)).toBe(false);
  });

  it('col secondo numero non configurato riconosce solo il primario', () => {
    delete process.env.TWILIO_WHATSAPP_NUMBER_FENICE_2;
    expect(eNumeroDelBot(PRIMARIO)).toBe(true);
    expect(eNumeroDelBot(SECONDO)).toBe(false);
  });
});
