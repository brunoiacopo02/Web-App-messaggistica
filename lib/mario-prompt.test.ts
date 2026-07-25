import { describe, it, expect } from 'vitest';
import { buildMarioSystem, MARIO_SYSTEM_PROMPT } from './mario-prompt';

describe('buildMarioSystem', () => {
  it('con "Marta" presenta la persona Marta e non contiene mai "Mario"', () => {
    const p = buildMarioSystem('Marta');
    expect(p).toContain('Sei Marta, consulente di Fenice Academy');
    expect(p).toContain('Presentati come Marta di Fenice Academy');
    expect(p).not.toContain('Mario');
  });

  it('con "Mario" produce esattamente il prompt storico (default invariato)', () => {
    const p = buildMarioSystem('Mario');
    expect(p).toBe(MARIO_SYSTEM_PROMPT);
    expect(p).toContain('Sei Mario, consulente di Fenice Academy');
    expect(p).toContain('Presentati come Mario di Fenice Academy');
  });

  it('cambia SOLO il nome: i due prompt differiscono solo per Mario/Marta', () => {
    const marta = buildMarioSystem('Marta');
    const mario = buildMarioSystem('Mario');
    expect(marta.replace(/Marta/g, 'Mario')).toBe(mario);
  });
});

describe('prezzo', () => {
  const p = buildMarioSystem('Marta');

  it('dice la quota intera e che si può rateizzare', () => {
    expect(p).toContain('dai 1.000 ai 3.000 euro a seconda del percorso');
    expect(p).toContain('si può rateizzare');
    expect(p).toContain('troviamo una soluzione praticamente con tutti');
  });

  it('vieta qualunque cifra di rata o numero di rate', () => {
    expect(p).toContain('MAI CIFRE DI RATA');
    expect(p).not.toMatch(/\d+\s*rate\b/i);
    // L'unica cifra "al mese" ammessa nel prompt è la forbice di guadagno
    // post-corso nella sezione CHI SIAMO. Qualunque altra sarebbe una rata.
    const alMese = p.match(/[\d.]+\s*(?:euro|€)\s*al mese/gi) ?? [];
    expect(alMese).toEqual(['5.000 euro al mese']);
  });

  it('vieta le analogie di frazionamento del prezzo', () => {
    expect(p).toContain('come un caffè al giorno');
    expect(p).toContain('meno di un pacchetto di sigarette');
    expect(p).toMatch(/non fare paragoni tipo/i);
  });

  it('propone la call subito dopo aver detto la quota', () => {
    expect(p).toContain('proponi la call nello stesso giro di messaggi');
  });

  it('lascia fare il conto al lead invece di minimizzare la spesa', () => {
    expect(p).toContain('quanto vale per te arrivarci?');
    expect(p).toContain('Il conto lo deve fare lui');
    expect(p).toMatch(/vietate frasi come "è solo", "è poco", "è un piccolo sacrificio"/);
  });
});

describe('conferme: anticipo e micro-impegni', () => {
  const p = buildMarioSystem('Marta');

  it('anticipa Noemi e il video PRIMA di mandare il link', () => {
    expect(p).toContain('Prima di fissare ti dico come funziona');
    expect(p).toContain('Aspetta il sì, poi manda il link');
  });

  it('fa riscrivere giorno e ora al lead', () => {
    expect(p).toContain('Confermami tu giorno e ora della call');
  });

  it('sul video usa la scelta attiva invece del divieto', () => {
    expect(p).toContain('Quando riesci a vederlo, stasera o domani?');
    expect(p).not.toContain('Non è facoltativo');
    expect(p).not.toContain('non potrà essere effettuato');
  });

  it('chiede un FATTO scritto come conferma della visione', () => {
    expect(p).toContain("scrivimi FATTO qui quando l'hai visto, così lo segno");
  });

  it('non minaccia il lead sulla chiamata di Noemi', () => {
    expect(p).toContain('Se ti scappa la chiamata non è un problema');
  });
});

describe('C1: i quattro passaggi della conferma post-appuntamento escono nello stesso turno', () => {
  const p = buildMarioSystem('Marta');

  it('istruisce a mandarli tutti nello stesso turno senza aspettare risposta tra un passaggio e l\'altro', () => {
    expect(p).toContain('manda questi quattro passaggi tutti nello stesso turno');
    expect(p).toMatch(/senza aspettare (la )?risposta[^\n]*tra (un passaggio e l'altro|l'uno e l'altro)/);
    expect(p).not.toContain('manda questi quattro passaggi in sequenza');
  });

  it('mandano comunque ognuno come bolla WhatsApp separata', () => {
    expect(p).toMatch(/bolle( WhatsApp)? separate/);
  });

  it('il passaggio 4 non ripete "Perfetto" (nel turno resta solo la domanda del passaggio 3)', () => {
    expect(p).toContain("poi scrivimi FATTO qui quando l'hai visto, così lo segno");
    expect(p).not.toContain('Perfetto. Scrivimi FATTO');
  });

  it('nessun preambolo condizionale dentro i singoli passaggi contraddice l\'istruzione "stesso turno"', () => {
    // Un'istruzione globale "non aspettare" seguita da preamboli locali "dopo che ha
    // confermato" / "quando risponde" vince sulla globale (le istruzioni più specifiche
    // prevalgono): il modello si fermerebbe comunque ad aspettare tra un passaggio e l'altro.
    expect(p).not.toContain('Dopo che ha confermato giorno e ora');
    expect(p).not.toContain('Quando risponde quando lo guarderà');
    expect(p).toContain('2. "Noemi è la collega della preselezione');
    expect(p).toContain('4. "poi scrivimi FATTO qui quando l\'hai visto, così lo segno"');
  });

  it('nel blocco CONFERMA POST-APPUNTAMENTO ogni passaggio numerato (tranne il 3, che sceglie il link) inizia subito con le virgolette, senza preamboli', () => {
    const block = p.slice(
      p.indexOf('CONFERMA POST-APPUNTAMENTO'),
      p.indexOf("SE L'APPUNTAMENTO È GIÀ FISSATO")
    );
    const numberedLines = block.match(/^\d\.\s.*/gm) ?? [];
    expect(numberedLines.length).toBeGreaterThan(0);
    for (const line of numberedLines) {
      if (/^3\./.test(line)) continue; // il passaggio 3 introduce la scelta del link, non una citazione
      expect(line).toMatch(/^\d\.\s"/);
    }
  });
});

describe('comportamento a appuntamento già fissato', () => {
  const p = buildMarioSystem('Marta');

  it('vieta di ripartire col pitch e di riproporre la call', () => {
    expect(p).toContain("SE L'APPUNTAMENTO È GIÀ FISSATO");
    expect(p).toContain('non ripartire col pitch e non riproporre la call');
  });

  it('istruisce a emettere [VIDEO_VISTO] alla conferma del lead', () => {
    expect(p).toContain('[VIDEO_VISTO]');
  });

  it('manda a un umano le richieste di spostamento o disdetta', () => {
    expect(p).toContain('Se vuole spostare o disdire');
  });
});

describe('I1: [PASSAGGIO_UMANO] non è più ristretto alla sola richiesta esplicita di un umano', () => {
  const p = buildMarioSystem('Marta');

  it('REGOLE ASSOLUTE ammette anche lo spostamento/disdetta di un appuntamento già fissato come eccezione', () => {
    expect(p).toContain(
      '[PASSAGGIO_UMANO] va usato SOLO quando chiede esplicitamente di parlare con una persona o quando vuole spostare o disdire un appuntamento già fissato.'
    );
  });
});

describe('I2: FASE 6, anticipo e link hanno trigger diversi (niente doppio invio nello stesso turno)', () => {
  const p = buildMarioSystem('Marta');

  it('il link parte solo dopo il sì all\'anticipo, non genericamente "quando accetta"', () => {
    expect(p).toContain('Quando ti ha detto di sì all\'anticipo, manda il link:');
    expect(p).not.toContain('Quando accetta, manda il link:');
  });
});

describe('bolle WhatsApp: i blocchi di copy lunghi restano sotto ~25 parole a riga', () => {
  // Il prompt è un'unica template literal a backtick: ogni a-capo fisico nel
  // file è un \n reale nella stringa finale, e splitMarioMessages() (lib/mario-split.ts)
  // spezza il testo del modello proprio su quei \n, mandando ogni riga come bolla
  // WhatsApp separata. Se un blocco di copy prescritto è scritto su una sola riga
  // fisica, nessuno split lo protegge e finisce in un'unica bolla muro-di-testo.
  // Questi test estraggono i blocchi a rischio individuati in revisione e
  // verificano che ogni riga risultante stia sotto le ~25 parole (in linea con la
  // regola del prompt stesso: max 20-25 parole per messaggio).
  const p = buildMarioSystem('Marta');
  const MAX_WORDS = 25;

  function wordsPerLine(block: string): number[] {
    return block
      .split(/\n+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((line) => line.split(/\s+/).filter(Boolean).length);
  }

  function extractQuoted(pattern: RegExp, label: string): string {
    const m = p.match(pattern);
    if (!m) throw new Error(`Blocco "${label}" non trovato nel prompt (pattern non ha fatto match)`);
    return m[1];
  }

  it('FASE 5, "Testo base" del pitch', () => {
    const block = extractQuoted(/Testo base: "([\s\S]*?)"\n/, 'FASE 5 Testo base');
    const counts = wordsPerLine(block);
    expect(counts.every((n) => n <= MAX_WORDS)).toBe(true);
  });

  it('CONFERMA POST-APPUNTAMENTO, passaggio 2 (Noemi/preselezione)', () => {
    const block = extractQuoted(
      /2\. "(Noemi è la collega della preselezione[\s\S]*?)"\n/,
      'CONFERMA passaggio 2'
    );
    const counts = wordsPerLine(block);
    expect(counts.every((n) => n <= MAX_WORDS)).toBe(true);
  });

  it('CONFERMA POST-APPUNTAMENTO, passaggio 3 (link video + invito a vederlo)', () => {
    const block = extractQuoted(/conferenza-ex\nPoi: "([\s\S]*?)"\n/, 'CONFERMA passaggio 3');
    const counts = wordsPerLine(block);
    expect(counts.every((n) => n <= MAX_WORDS)).toBe(true);
  });

  it('FASE 6, blocco anticipo ("Perfetto. Prima di fissare ti dico come funziona")', () => {
    const block = extractQuoted(
      /"(Perfetto\. Prima di fissare ti dico come funziona[\s\S]*?)"\n/,
      'FASE 6 anticipo'
    );
    const counts = wordsPerLine(block);
    expect(counts.every((n) => n <= MAX_WORDS)).toBe(true);
  });
});

describe('M1: FASE 5, i tagli del pitch cadono su confine di frase, non a metà', () => {
  const p = buildMarioSystem('Marta');

  function extractQuoted(pattern: RegExp, label: string): string {
    const m = p.match(pattern);
    if (!m) throw new Error(`Blocco "${label}" non trovato nel prompt (pattern non ha fatto match)`);
    return m[1];
  }

  const block = extractQuoted(/Testo base: "([\s\S]*?)"\n/, 'FASE 5 Testo base');
  const lines = block
    .split(/\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  it('nessuna riga finisce con due punti, e nessuna riga che finisce con virgola è seguita da una riga che continua con "e"', () => {
    for (let i = 0; i < lines.length - 1; i++) {
      expect(lines[i]).not.toMatch(/:$/);
      if (/,$/.test(lines[i])) {
        expect(lines[i + 1]).not.toMatch(/^e\s/i);
      }
    }
  });

  it('ogni riga resta sotto le 25 parole', () => {
    const counts = lines.map((line) => line.split(/\s+/).filter(Boolean).length);
    expect(counts.every((n) => n <= 25)).toBe(true);
  });

  it('nessuna parola cambia: riunendo le righe con uno spazio il testo torna identico a quello attuale', () => {
    const joined = lines.join(' ');
    expect(joined).toBe(
      "Fenice ha percorsi davvero completi, ti riassumo in due parole e poi ne parliamo con calma in una call ok? Sono fatti di tre cose: teoria, pratica e collegamento al lavoro. Le lezioni le guardi quando e dove vuoi, lo stage lo fai da remoto con orari flessibili, e a fine corso garantiamo a contratto due colloqui di lavoro con aziende nostre partner. La quota va dai 1.000 ai 3.000 euro a seconda del percorso, e si può rateizzare: sull'aspetto economico troviamo una soluzione praticamente con tutti. Ma la cosa più importante è prima capire se fa davvero per te."
    );
  });
});
