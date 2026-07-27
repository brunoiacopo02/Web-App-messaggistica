import { describe, it, expect } from 'vitest';
import { sanitizeOutbound, unknownFeniceLinks, KNOWN_LINKS } from './outbound-sanitize';

describe('sanitizeOutbound: ripara i link noti spezzati dal modello', () => {
  it('richiude uno spazio dentro l URL del video lungo', () => {
    const t = 'Quando riesci a vederlo? 👉 https://corso.feniceacademy.it/conferenza-ax msbn9r50';
    expect(sanitizeOutbound(t)).toBe('Quando riesci a vederlo? 👉 https://corso.feniceacademy.it/conferenza-axmsbn9r50');
  });

  it('richiude piu spazi e tab dentro lo stesso URL', () => {
    const t = 'https://corso.feniceacademy.it/conferenza-ax\tmsbn9r 50 ecco';
    expect(sanitizeOutbound(t)).toBe('https://corso.feniceacademy.it/conferenza-axmsbn9r50 ecco');
  });

  it('ripara anche il link JotForm', () => {
    const t = 'Clicca qui 👉 https://form.jotform.com/2407556 54585063';
    expect(sanitizeOutbound(t)).toBe('Clicca qui 👉 https://form.jotform.com/240755654585063');
  });

  it('non tocca gli URL gia corretti', () => {
    for (const link of KNOWN_LINKS) {
      expect(sanitizeOutbound(`ecco ${link} ok`)).toBe(`ecco ${link} ok`);
    }
  });

  it('non unisce due bolle diverse: non attraversa gli a-capo', () => {
    const t = 'https://corso.feniceacademy.it/conferenza-\nbx';
    expect(sanitizeOutbound(t)).toBe('https://corso.feniceacademy.it/conferenza-\nbx');
  });

  it('lascia intatto un testo senza link', () => {
    expect(sanitizeOutbound('Perfetto, a domani 😊')).toBe('Perfetto, a domani 😊');
  });

  it('non confonde due URL noti diversi sulla stessa riga', () => {
    const t = 'video https://corso.feniceacademy.it/conferenza-dx e form https://form.jotform.com/240755654585063';
    expect(sanitizeOutbound(t)).toBe(t);
  });
});

describe('unknownFeniceLinks: segnala i link Fenice non riconosciuti', () => {
  it('elenca un URL conferenza fuori dalla lista ufficiale', () => {
    const t = 'guarda https://corso.feniceacademy.it/conferenza-zz9 qui';
    expect(unknownFeniceLinks(t)).toEqual(['https://corso.feniceacademy.it/conferenza-zz9']);
  });

  it('non segnala nulla quando gli URL sono quelli ufficiali', () => {
    expect(unknownFeniceLinks('https://corso.feniceacademy.it/conferenza-bx')).toEqual([]);
  });

  it('non segnala nulla dopo la sanificazione di un URL spezzato', () => {
    const t = sanitizeOutbound('https://corso.feniceacademy.it/conferenza-ax msbn9r50');
    expect(unknownFeniceLinks(t)).toEqual([]);
  });

  it('non segnala un link ufficiale seguito da un punto di fine frase', () => {
    const t = 'guarda qui: https://corso.feniceacademy.it/conferenza-bx.';
    expect(unknownFeniceLinks(t)).toEqual([]);
  });

  it('non segnala un link ufficiale seguito da virgola o parentesi chiusa', () => {
    expect(unknownFeniceLinks('video (https://corso.feniceacademy.it/conferenza-dx), guardalo')).toEqual([]);
    expect(unknownFeniceLinks('ecco https://corso.feniceacademy.it/conferenza-ex, a presto')).toEqual([]);
  });

  it('segnala comunque un link davvero sconosciuto seguito da un punto, senza il punto in coda', () => {
    const t = 'guarda https://corso.feniceacademy.it/conferenza-zz9.';
    expect(unknownFeniceLinks(t)).toEqual(['https://corso.feniceacademy.it/conferenza-zz9']);
  });
});
