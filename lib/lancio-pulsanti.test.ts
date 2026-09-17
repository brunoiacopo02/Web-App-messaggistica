import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DOMANDA_SCELTA_GIORNO, DOMANDA_SCELTA_NOTTE, SPINTA_CHIAMATA_NOTTE, testoScelta, buildLancioSystem } from './lancio-prompt';
import {
  eDomandaScelta, sidSceltaPulsanti, tapPulsanteScelta, pulsantiScelta, corpoSceltaPulsanti,
  PULSANTE_CHIAMA_ORA, PULSANTE_DOMANI_MATTINA, PULSANTE_FISSIAMO_DOMANI, PULSANTE_OGGI_POMERIGGIO,
} from './lancio-pulsanti';

afterEach(() => { vi.unstubAllEnvs(); });

describe('spinta alla chiamata immediata (delibera PO 17/09)', () => {
  it('di notte la domanda resta verbatim e la spinta le sta in coda; di giorno la spinta non esiste', () => {
    expect(testoScelta('notte')).toBe(`${DOMANDA_SCELTA_NOTTE} ${SPINTA_CHIAMATA_NOTTE}`);
    expect(testoScelta('notte').startsWith(DOMANDA_SCELTA_NOTTE)).toBe(true);
    expect(testoScelta('giorno')).toBe(DOMANDA_SCELTA_GIORNO);
    expect(testoScelta('giorno')).not.toContain(SPINTA_CHIAMATA_NOTTE);
  });

  it('nel prompt: di notte la regola della spinta c e, di giorno no', () => {
    const pp = (modo: 'notte' | 'giorno') =>
      buildLancioSystem({ fase: 'post_pitch', nome: 'Anna', eventoAt: '2026-10-05T21:00:00+02:00', modo, risposteRaccolte: 2, bloccoSlot: null });
    expect(pp('notte')).toContain(SPINTA_CHIAMATA_NOTTE);
    expect(pp('notte')).toMatch(/CONSIGLIA la chiamata subito/);
    expect(pp('notte')).toMatch(/in ordine di chiamata/);
    expect(pp('giorno')).not.toContain(SPINTA_CHIAMATA_NOTTE);
    expect(pp('giorno')).not.toMatch(/CONSIGLIA la chiamata subito/);
  });

  it('e una riga sola, dando del tu, senza cifre e senza promesse', () => {
    // Niente numeri: non esistono "restano 3 posti" ne' "200 persone in attesa", e un
    // prezzo non deve poter comparire in nessuna forma.
    expect(SPINTA_CHIAMATA_NOTTE).not.toMatch(/[0-9]/);
    expect(SPINTA_CHIAMATA_NOTTE).not.toContain('€');
    // Una frase sola: un solo segno di chiusura, in fondo.
    expect(SPINTA_CHIAMATA_NOTTE.match(/[.!?]/g) ?? []).toHaveLength(1);
    expect(SPINTA_CHIAMATA_NOTTE.length).toBeLessThan(200);
    // Del tu, non del lei.
    expect(SPINTA_CHIAMATA_NOTTE).toMatch(/\bti\b/i);

    const VIETATE = [
      'garantisc', 'garantit', 'garanzia', 'promett', 'promess', 'assicur',
      'sicuramente', 'certamente', 'gratis', 'sconto', 'offerta esclusiva',
      'ultimo posto', 'ultimi posti', 'rimborso', 'risultato garantito',
    ];
    const t = SPINTA_CHIAMATA_NOTTE.toLowerCase();
    for (const v of VIETATE) expect(t.includes(v), `la spinta non deve contenere "${v}"`).toBe(false);
  });
});

describe('tapPulsanteScelta — i quattro titoli', () => {
  it('"Chiamami subito" e CHIAMA_ORA, gli altri tre sono SLOTS', () => {
    expect(tapPulsanteScelta(PULSANTE_CHIAMA_ORA)).toBe('CHIAMA_ORA');
    expect(tapPulsanteScelta(PULSANTE_FISSIAMO_DOMANI)).toBe('SLOTS');
    expect(tapPulsanteScelta(PULSANTE_OGGI_POMERIGGIO)).toBe('SLOTS');
    expect(tapPulsanteScelta(PULSANTE_DOMANI_MATTINA)).toBe('SLOTS');
  });

  it('insensibile a maiuscole, accenti, punteggiatura, emoji e spazi', () => {
    expect(tapPulsanteScelta('  CHIAMAMI SUBITO  ')).toBe('CHIAMA_ORA');
    expect(tapPulsanteScelta('Chiamami subito!')).toBe('CHIAMA_ORA');
    expect(tapPulsanteScelta('Chiámami subito')).toBe('CHIAMA_ORA');
    expect(tapPulsanteScelta('Domani mattina 🚀')).toBe('SLOTS');
  });

  it('una frase che CONTIENE il titolo non e un tocco: la legge il modello', () => {
    expect(tapPulsanteScelta('domani mattina va bene?')).toBe(null);
    expect(tapPulsanteScelta('adessi')).toBe(null);
    expect(tapPulsanteScelta('')).toBe(null);
    expect(tapPulsanteScelta(null)).toBe(null);
  });
});

describe('eDomandaScelta', () => {
  it('riconosce la domanda del modo, anche con un attacco davanti o la spinta dietro', () => {
    expect(eDomandaScelta(DOMANDA_SCELTA_NOTTE, 'notte')).toBe(true);
    expect(eDomandaScelta(testoScelta('notte'), 'notte')).toBe(true);
    expect(eDomandaScelta(`Perfetto. ${DOMANDA_SCELTA_NOTTE}`, 'notte')).toBe(true);
    expect(eDomandaScelta(DOMANDA_SCELTA_GIORNO, 'giorno')).toBe(true);
  });
  it('non scambia la domanda dell altro modo, ne una domanda di riscaldamento', () => {
    expect(eDomandaScelta(DOMANDA_SCELTA_GIORNO, 'notte')).toBe(false);
    expect(eDomandaScelta(DOMANDA_SCELTA_NOTTE, 'giorno')).toBe(false);
    expect(eDomandaScelta('Cosa fai oggi nella vita?', 'notte')).toBe(false);
    expect(eDomandaScelta('', 'notte')).toBe(false);
  });
});

describe('env e corpi dei template', () => {
  it('sidSceltaPulsanti legge la env del modo; vuota o assente vale null', () => {
    vi.stubEnv('LANCIO_SCELTA_NOTTE_TEMPLATE_SID', 'HX_NOTTE');
    vi.stubEnv('LANCIO_SCELTA_GIORNO_TEMPLATE_SID', '  ');
    expect(sidSceltaPulsanti('notte')).toBe('HX_NOTTE');
    expect(sidSceltaPulsanti('giorno')).toBe(null);
  });

  it('i pulsanti del modo, tutti entro i 20 caratteri di WhatsApp', () => {
    expect(pulsantiScelta('notte')).toEqual([PULSANTE_CHIAMA_ORA, PULSANTE_FISSIAMO_DOMANI]);
    expect(pulsantiScelta('giorno')).toEqual([PULSANTE_OGGI_POMERIGGIO, PULSANTE_DOMANI_MATTINA]);
    for (const t of [...pulsantiScelta('notte'), ...pulsantiScelta('giorno')]) {
      expect(t.length, `"${t}"`).toBeLessThanOrEqual(20);
    }
  });

  it('il corpo del template e il testo della scelta, sotto i 1024 caratteri', () => {
    expect(corpoSceltaPulsanti('notte')).toBe(testoScelta('notte'));
    expect(corpoSceltaPulsanti('giorno')).toBe(testoScelta('giorno'));
    expect(corpoSceltaPulsanti('notte').length).toBeLessThanOrEqual(1024);
  });

  it('lo script che crea i template usa ESATTAMENTE questi testi e questi titoli', () => {
    // I due corpi vivono anche in un .mjs (non puo' importare TypeScript): se qui cambia
    // una virgola e la' no, il lead legge una cosa e in `messages` ne resta un'altra.
    const script = readFileSync(path.join(__dirname, '..', 'scripts', 'create-lancio-scelta-templates.mjs'), 'utf8');
    expect(script).toContain(testoScelta('notte'));
    expect(script).toContain(testoScelta('giorno'));
    for (const t of [...pulsantiScelta('notte'), ...pulsantiScelta('giorno')]) expect(script).toContain(t);
  });
});
