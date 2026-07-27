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

  it('segnala il link video mancante senza inventarne uno e senza chiedere di confermare un video mai ricevuto', () => {
    const r = ensureConfirmationBlock([step1, step2]);
    expect(r.missingVideoLink).toBe(true);
    expect(r.parts.join(' ')).not.toContain('conferenza-');
    // Il passaggio FATTO chiede al lead di confermare di aver visto un video che
    // non gli e mai arrivato: senza link non va aggiunto.
    expect(r.parts).not.toContain(STEP4_TEXT);
    expect(r.parts.join(' ')).not.toContain('FATTO');
    expect(r.added).toEqual([]);
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

  it('riconosce il pitch anche se è distribuito su più bolle attorno al link (conv 3312)', () => {
    const bolle = [
      'Qui dentro ci sono le professioni, i pacchetti e le quote di investimento.',
      'https://corso.feniceacademy.it/conferenza-dx',
      'Sono 20 minuti e servono perché in call partiamo dal tuo caso invece che dalle basi.',
      'Quando riesci a vederlo, stasera o domani mattina prima del lavoro?',
      STEP4_TEXT,
    ];
    const r = ensureConfirmationBlock(bolle);
    expect(r.added).toEqual([]);
    expect(r.parts).toEqual(bolle);
  });

  it('riconosce il pitch quando è fuso col link in un unica bolla (conv 3349)', () => {
    const fusa =
      "Qui dentro ci sono le professioni, i pacchetti e le quote di investimento. Sono 20 minuti e servono perché in call partiamo dal tuo caso invece che dalle basi. Quando riesci a vederlo, stasera o domani? 👉 https://corso.feniceacademy.it/conferenza-axmsbn9r50";
    const r = ensureConfirmationBlock([step1, step2, fusa, STEP4_TEXT]);
    expect(r.added).toEqual([]);
    expect(r.parts[2]).toBe(fusa);
  });

  it('aggiunge il pitch quando il link e accompagnato solo da parole di riempimento', () => {
    const riempimento = "Dacci un'occhiata quando puoi 👉 https://corso.feniceacademy.it/conferenza-ex";
    const r = ensureConfirmationBlock([step1, step2, riempimento]);
    expect(r.added).toContain('videoPitch');
    expect(r.parts[2]).toBe(`${VIDEO_PITCH_TEXT} ${riempimento}`);
  });

  it('aggiunge il pitch quando il link e nudo in una bolla propria e nessun altra bolla lo contiene', () => {
    const r = ensureConfirmationBlock([step1, step2, 'https://corso.feniceacademy.it/conferenza-ex']);
    expect(r.added).toContain('videoPitch');
    expect(r.parts[2]).toBe(`${VIDEO_PITCH_TEXT} https://corso.feniceacademy.it/conferenza-ex`);
  });

  it('non scambia le quote del pagamento per il pitch del video', () => {
    const pagamento = 'Confermiamo le quote del pagamento domani?';
    const r = ensureConfirmationBlock([step1, step2, pagamento, 'https://corso.feniceacademy.it/conferenza-ex']);
    expect(r.added).toContain('videoPitch');
    expect(r.parts[3]).toBe(`${VIDEO_PITCH_TEXT} https://corso.feniceacademy.it/conferenza-ex`);
  });

  it('riconosce il pitch riformulato con "venti minuti" in lettere', () => {
    const riformulata =
      'Dentro trovi le professioni e le quote, sono venti minuti, quando riesci a guardarlo? https://corso.feniceacademy.it/conferenza-ex';
    const r = ensureConfirmationBlock([step1, step2, riformulata]);
    expect(r.added).not.toContain('videoPitch');
    expect(r.parts[2]).toBe(riformulata);
  });

  it('riconosce "investimento" da solo come marcatore del pitch, senza pretendere quote o pacchetti', () => {
    const riformulata =
      "Il video spiega bene l'investimento necessario, dura 20 minuti, quando lo guardi mi dici https://corso.feniceacademy.it/conferenza-ex";
    const r = ensureConfirmationBlock([step1, step2, riformulata]);
    expect(r.added).not.toContain('videoPitch');
    expect(r.parts[2]).toBe(riformulata);
  });
});
