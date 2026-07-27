import { describe, it, expect } from 'vitest';
import { ensureConfirmationBlock, STEP4_TEXT, VIDEO_PITCH_TEXT } from './confirmation-block';

const step1 = 'Perfetto, allora ci siamo. Confermami tu giorno e ora della call come li hai scelti, così sono sicura che siamo allineati';
const step2 = 'Noemi è la collega della preselezione, ti chiama prima della call da un cellulare: è il passaggio che conferma l\'appuntamento, quindi tieni il telefono a portata';
const step3 = `Qui dentro ci sono le professioni, i pacchetti e le quote di investimento. Sono 20 minuti. https://corso.feniceacademy.it/conferenza-dx`;

describe('ensureConfirmationBlock: il blocco post-appuntamento esce sempre completo', () => {
  it('lascia intatto un blocco gia completo', () => {
    const r = ensureConfirmationBlock([step1, step2, step3, STEP4_TEXT]);
    expect(r.parts).toEqual([step1, step2, step3, STEP4_TEXT]);
    expect(r.added).toEqual([]);
    expect(r.missingVideoLink).toBe(false);
  });

  it('aggiunge il passaggio FATTO quando manca', () => {
    const r = ensureConfirmationBlock([step1, step2, step3]);
    expect(r.parts).toEqual([step1, step2, step3, STEP4_TEXT]);
    expect(r.added).toEqual(['step4']);
  });

  it('aggiunge il testo del video quando esce solo il link nudo', () => {
    const r = ensureConfirmationBlock([step1, step2, 'https://corso.feniceacademy.it/conferenza-dx', STEP4_TEXT]);
    expect(r.parts[2]).toBe(`${VIDEO_PITCH_TEXT} https://corso.feniceacademy.it/conferenza-dx`);
    expect(r.added).toEqual(['videoPitch']);
    expect(r.missingVideoLink).toBe(false);
  });

  it('segnala il link video mancante senza inventarne uno', () => {
    const r = ensureConfirmationBlock([step1, step2]);
    expect(r.missingVideoLink).toBe(true);
    expect(r.parts.join(' ')).not.toContain('conferenza-');
    expect(r.parts).toContain(STEP4_TEXT);
  });

  it('riconosce il passaggio FATTO anche se il modello lo ha riformulato', () => {
    const variante = 'poi scrivimi FATTO qui sotto quando l\'hai guardato';
    const r = ensureConfirmationBlock([step1, step2, step3, variante]);
    expect(r.added).toEqual([]);
    expect(r.parts).toHaveLength(4);
  });

  it('non duplica il passaggio FATTO quando e gia presente in altra forma', () => {
    const r = ensureConfirmationBlock([step1, step2, step3, 'scrivimi FATTO quando l\'hai visto così lo segno']);
    expect(r.parts.filter((p) => /FATTO/i.test(p))).toHaveLength(1);
  });

  it('aggiunge sia testo video sia FATTO quando mancano entrambi', () => {
    const r = ensureConfirmationBlock([step1, step2, 'https://corso.feniceacademy.it/conferenza-bx']);
    expect(r.added).toEqual(['videoPitch', 'step4']);
    expect(r.parts).toHaveLength(4);
  });
});
