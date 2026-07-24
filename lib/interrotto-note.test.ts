import { describe, expect, it } from 'vitest';
import { parseInterruptedVerdict } from './interrotto-note';

const FALLBACK = { lastLeadMsg: 'ok ci sentiamo' };

describe('parseInterruptedVerdict', () => {
  it('parses clean JSON and builds the rich note', () => {
    const raw = JSON.stringify({
      discard: false,
      discardReason: null,
      stage: 'dopo la domanda sul lavoro',
      lastLeadQuote: 'ci devo pensare',
    });
    const v = parseInterruptedVerdict(raw, FALLBACK);
    expect(v.discard).toBe(false);
    expect(v.discardReason).toBeUndefined();
    expect(v.note).toBe(
      'Interrotta dopo la domanda sul lavoro. Ultima frase del lead: "ci devo pensare"'
    );
  });

  it('extracts the first JSON block embedded in surrounding text', () => {
    const raw =
      'Ecco il verdetto richiesto:\n{"discard":true,"discardReason":"non interessato dichiarato","stage":"dopo il prezzo","lastLeadQuote":"non mi interessa, non scrivetemi più"}\nFine.';
    const v = parseInterruptedVerdict(raw, FALLBACK);
    expect(v.discard).toBe(true);
    expect(v.discardReason).toBe('non interessato dichiarato');
    expect(v.note).toBe(
      'Interrotta dopo il prezzo. Ultima frase del lead: "non mi interessa, non scrivetemi più"'
    );
  });

  it('falls back on malformed JSON without throwing', () => {
    const v = parseInterruptedVerdict('{"discard": true, "stage": ...boom', FALLBACK);
    expect(v).toEqual({
      discard: false,
      note: 'Chat interrotta. Ultimo messaggio del lead: "ok ci sentiamo"',
    });
  });

  it('falls back on plain text with no JSON at all', () => {
    const v = parseInterruptedVerdict('Non posso rispondere in JSON.', FALLBACK);
    expect(v).toEqual({
      discard: false,
      note: 'Chat interrotta. Ultimo messaggio del lead: "ok ci sentiamo"',
    });
  });

  it('falls back on empty input', () => {
    const v = parseInterruptedVerdict('', FALLBACK);
    expect(v.discard).toBe(false);
    expect(v.note).toBe('Chat interrotta. Ultimo messaggio del lead: "ok ci sentiamo"');
  });

  it('forces discard:false when discard:true has null discardReason', () => {
    const raw = JSON.stringify({
      discard: true,
      discardReason: null,
      stage: 'dopo il pitch',
      lastLeadQuote: 'mah',
    });
    const v = parseInterruptedVerdict(raw, FALLBACK);
    expect(v.discard).toBe(false);
    expect(v.discardReason).toBeUndefined();
    expect(v.note).toBe('Interrotta dopo il pitch. Ultima frase del lead: "mah"');
  });

  it('forces discard:false when discardReason is empty/whitespace', () => {
    const raw = JSON.stringify({
      discard: true,
      discardReason: '   ',
      stage: 'dopo il prezzo',
      lastLeadQuote: 'vediamo',
    });
    const v = parseInterruptedVerdict(raw, FALLBACK);
    expect(v.discard).toBe(false);
    expect(v.discardReason).toBeUndefined();
  });

  it('falls back when JSON parses but stage/lastLeadQuote are missing', () => {
    const raw = JSON.stringify({ discard: false, discardReason: null });
    const v = parseInterruptedVerdict(raw, FALLBACK);
    expect(v).toEqual({
      discard: false,
      note: 'Chat interrotta. Ultimo messaggio del lead: "ok ci sentiamo"',
    });
  });

  it('handles a lastLeadQuote containing a closing brace', () => {
    const raw = '{"discard":false,"discardReason":null,"stage":"dopo il prezzo","lastLeadQuote":"ok :} sentiamoci"}';
    const v = parseInterruptedVerdict(raw, FALLBACK);
    expect(v.discard).toBe(false);
    expect(v.note).toBe('Interrotta dopo il prezzo. Ultima frase del lead: "ok :} sentiamoci"');
  });

  it('never throws on weird truthy/other types for discard', () => {
    const raw = JSON.stringify({
      discard: 'yes',
      discardReason: 'x',
      stage: 'dopo il prezzo',
      lastLeadQuote: 'boh',
    });
    const v = parseInterruptedVerdict(raw, FALLBACK);
    expect(v.discard).toBe(false);
  });
});
