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

describe('data di un appuntamento già fissato da altri', () => {
  const p = buildMarioSystem('Marta');

  it('la data che il lead riferisce è la verità e non si corregge con gli slot', () => {
    expect(p).toContain('La data che ti dice il lead è quella giusta');
    expect(p).toContain('NON usare i giorni del blocco SLOT APPUNTAMENTO per correggerlo');
  });

  it('i giorni relativi si calcolano dalla data di oggi', () => {
    expect(p).toContain('"domani"');
    expect(p).toContain('calcolalo dalla data di oggi');
  });

  it('nel dubbio chiede conferma invece di affermare una data', () => {
    expect(p).toContain('non affermare nessuna data');
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

  it('dice quanto dura davvero la preselezione', () => {
    expect(p).toContain('5-10 minuti');
    expect(p).not.toContain('preselezione di pochi minuti');
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

  it('nel blocco CONFERMA POST-APPUNTAMENTO ogni passaggio numerato inizia subito con le virgolette, salvo l\'unica eccezione nota (instradamento del link nel passaggio 3)', () => {
    // L'unica riga numerata ammessa a non iniziare con le virgolette è quella esatta,
    // nota e già approvata, che instrada quale link mandare in base al lead: non un
    // "tranne il 3" generico, altrimenti un preambolo di attesa reintrodotto nel
    // passaggio 3 (es. "3. Quando conferma di aver ricevuto:") passerebbe inosservato.
    const KNOWN_ROUTING_LINE = '3. Manda il link video giusto in base alla situazione del lead:';
    // Ancorato al solo titolo di sezione (preceduto e seguito da un a-capo), non a
    // una qualunque menzione della stringa "CONFERMA POST-APPUNTAMENTO": ora che la
    // regola tassativa e il tag [APPUNTAMENTO_FISSATO] la citano anche loro (fuori dal
    // blocco), un indexOf generico prenderebbe la prima occorrenza sbagliata.
    const block = p.slice(
      p.indexOf('\nCONFERMA POST-APPUNTAMENTO\n'),
      p.indexOf("SE L'APPUNTAMENTO È GIÀ FISSATO")
    );
    const numberedLines = block.match(/^\d\.\s.*/gm) ?? [];
    expect(numberedLines.length).toBeGreaterThan(0);
    expect(numberedLines).toContain(KNOWN_ROUTING_LINE);
    for (const line of numberedLines) {
      if (line === KNOWN_ROUTING_LINE) continue;
      expect(line).toMatch(/^\d\.\s"/);
    }
  });

  it('[APPUNTAMENTO_FISSATO] va nello stesso messaggio dei quattro passaggi, mai da solo', () => {
    expect(p).toContain(
      'scrivi [APPUNTAMENTO_FISSATO] insieme ai quattro passaggi della CONFERMA POST-APPUNTAMENTO qui sotto, nello stesso messaggio'
    );
    expect(p).toContain('non scriverlo mai da solo, senza altro testo visibile');
    expect(p).not.toContain('Quando risponde, scrivi: [APPUNTAMENTO_FISSATO]');
  });

  it('la riga introduttiva della CONFERMA dichiara di essere l\'unica eccezione alla regola dell\'attesa fra un messaggio e l\'altro', () => {
    expect(p).toContain(
      "È l'unico punto del flusso in cui non vale la regola dell'attesa fra un messaggio e l'altro."
    );
  });

  it('REGOLE TASSATIVE, punto 4 (UNA SOLA DOMANDA): nomina esplicitamente l\'eccezione della CONFERMA POST-APPUNTAMENTO', () => {
    // Senza questa eccezione una regola "non violarle MAI" ("aspetta sempre la
    // risposta prima di continuare") confligge con l'istruzione di mandare i quattro
    // passaggi della conferma nello stesso turno: il modello risolverebbe il conflitto
    // fermandosi dopo il primo passaggio, riaprendo il bug di C1.
    expect(p).toContain(
      "Aspetta sempre la risposta prima di continuare. Unica eccezione: i quattro passaggi della CONFERMA POST-APPUNTAMENTO, che escono tutti insieme nello stesso turno."
    );
  });
});

describe('fix conferme: Noemi chiama da un cellulare (non un numero fisso)', () => {
  const p = buildMarioSystem('Marta');

  it('il passaggio 2 precisa che Noemi chiama da un cellulare e invita a richiamare su quel numero', () => {
    expect(p).toContain('ti chiama prima della call da un cellulare:');
    expect(p).toContain('richiamala pure su quel numero');
    expect(p).not.toContain('richiamala pure allo stesso numero');
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

  it('registra spostamento o disdetta come nota per i colleghi invece di passarli a un umano', () => {
    expect(p).toContain('Se vuole spostare o disdire');
    expect(p).not.toContain('Se vuole spostare o disdire non gestirlo da solo');
    expect(p).not.toContain('usa [PASSAGGIO_UMANO]. Se fa una domanda sul percorso');
  });
});

describe('disdette a appuntamento fissato', () => {
  const p = buildMarioSystem('Marta');

  it('chiede di registrare il motivo con le parole del lead invece di passare a un umano', () => {
    expect(p).toContain('con le parole del lead');
    expect(p).not.toContain('Se vuole spostare o disdire non gestirlo da solo');
  });

  it('rassicura il lead che qualcuno lo ricontatta', () => {
    expect(p).toContain('ti ricontatta una collega');
  });
});

describe('I1 (revocato dal Task 3): [PASSAGGIO_UMANO] torna ristretto alla sola richiesta esplicita di un umano', () => {
  // Spostamento/disdetta di un appuntamento già fissato ora diventano una NOTA al
  // CRM (vedi describe 'disdette a appuntamento fissato'), non più un passaggio
  // umano: l'eccezione introdotta in REGOLE ASSOLUTE per quel caso va rimossa,
  // altrimenti resterebbe in contraddizione con la sezione SE L'APPUNTAMENTO
  // È GIÀ FISSATO.
  const p = buildMarioSystem('Marta');

  it('REGOLE ASSOLUTE non ammette più lo spostamento/disdetta come eccezione a [PASSAGGIO_UMANO]', () => {
    expect(p).toContain(
      '[PASSAGGIO_UMANO] va usato SOLO quando chiede esplicitamente di parlare con una persona.'
    );
    expect(p).not.toContain('o quando vuole spostare o disdire un appuntamento già fissato');
  });
});

describe('glossario esiti: eccezione esplicita per l\'appuntamento già fissato (mai INTERROTTO su una disdetta/spostamento)', () => {
  // Il glossario in fondo al prompt definisce INTERROTTO proprio con le parole di una
  // disdetta ("adesso non posso", "lascia stare per ora", "ti faccio sapere io") e
  // chiude con "nel dubbio NON chiudere": letto da solo, un modello davanti a "devo
  // annullare, non ce la faccio in questo periodo" su un appuntamento già fissato
  // sceglierebbe INTERROTTO, che produce una nota "conversazione interrotta" e nessuno
  // chiama per gestire la disdetta. Serve un'eccezione esplicita che rimandi alla
  // sezione SE L'APPUNTAMENTO È GIÀ FISSATO e disattivi lì la regola del dubbio.
  const p = buildMarioSystem('Marta');

  it('vieta INTERROTTO quando l\'appuntamento è già fissato, rimandando alla sezione dedicata', () => {
    expect(p).toContain("ECCEZIONE quando l'appuntamento è GIÀ FISSATO");
    expect(p).toContain("SE L'APPUNTAMENTO È GIÀ FISSATO");
    expect(p).toContain('usa SOLO SCARTO o RICHIAMO, MAI INTERROTTO');
  });

  it('sospende esplicitamente la regola "nel dubbio non chiudere" per quel caso', () => {
    expect(p).toContain('la regola "nel dubbio NON chiudere" NON vale');
  });

  it('l\'antecedente di "in quel caso" è esplicito: non basta che l\'appuntamento sia fissato, il lead deve dire che non ce la fa o che vuole spostare/disdire (altrimenti un "ok grazie" qualsiasi rischierebbe un tag SCARTO)', () => {
    expect(p).toContain(
      "ECCEZIONE quando l'appuntamento è GIÀ FISSATO e il lead ti dice che non ce la fa più o che vuole spostare/disdire"
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

describe('niente promesse di telefonate: Mario non puo chiamare nessuno', () => {
  // Il 27/07 una lead ha scritto "se vuole mi chiami ora" e il bot ha risposto
  // "Certo, ti chiamo subito!": Mario è un'IA su WhatsApp, non può telefonare, e la
  // lead è rimasta ad aspettare una chiamata che nessuno le aveva promesso. Stessa
  // famiglia della regola "non fingersi umano": non promettere un'azione che non
  // sei in grado di compiere. La regola va nel blocco REGOLE ASSOLUTE (non in una
  // FASE specifica), perché vale sempre, indipendentemente dal punto del funnel.
  const p = buildMarioSystem('Marta');

  it('il prompt vieta esplicitamente di promettere una chiamata propria', () => {
    expect(p).toMatch(/non (puoi|devi) mai (promettere|dire).{0,60}(chiam)/i);
  });

  it('indica l alternativa corretta: fa richiamare una collega', () => {
    expect(p).toContain('ti faccio richiamare da una collega');
  });

  it('la promessa della richiamata da parte di una collega chiude col tag [PASSAGGIO_UMANO], cosi non resta una promessa vuota come "ti chiamo subito"', () => {
    // Senza instradamento reale a un umano, "ti faccio richiamare da una collega"
    // sarebbe la stessa identica falsa promessa di "ti chiamo subito": nessuno
    // avviserebbe davvero una collega, e il lead resterebbe comunque ad aspettare.
    expect(p).toMatch(/ti faccio richiamare da una collega["'\s\S]{0,80}\[PASSAGGIO_UMANO\]/);
  });

  it('non entra in conflitto col percorso di disdetta/spostamento su un appuntamento gia fissato, che usa gia i tag [ESITO:...]', () => {
    // Quel percorso (sezione "SE L'APPUNTAMENTO È GIÀ FISSATO") promette anch'esso
    // "ti ricontatta una collega", ma instrada già col tag ESITO verso il CRM: la
    // nuova regola su [PASSAGGIO_UMANO] deve esplicitamente farsi da parte lì,
    // altrimenti il modello si troverebbe davanti a due tag diversi per lo stesso
    // messaggio e potrebbe scegliere quello sbagliato.
    expect(p).toMatch(/ECCEZIONE.{0,40}GIÀ FISSATO.{0,60}NON usare \[PASSAGGIO_UMANO\]/i);
  });

  it('la regola sta nelle REGOLE ASSOLUTE, non in una fase specifica', () => {
    // "FASE 1" precede REGOLE ASSOLUTE in questo prompt (non la segue), quindi non è
    // un marcatore di fine blocco valido qui: si usa il primo titolo di sezione che
    // segue davvero REGOLE ASSOLUTE, cioè il glossario dei tag di esito.
    // Ancorato a "\nREGOLE ASSOLUTE\n" (il titolo di sezione su riga propria), non a
    // una qualunque occorrenza della stringa: FASE 6 contiene già un rimando testuale
    // "(vedi REGOLE ASSOLUTE)" prima del vero blocco, e un indexOf generico
    // prenderebbe quello, includendo nella slice tutta la CONFERMA POST-APPUNTAMENTO
    // (che parla di Noemi che "chiama" il lead) e facendo passare il test a vuoto.
    const regole = p.slice(
      p.indexOf('\nREGOLE ASSOLUTE\n'),
      p.indexOf('QUANDO LA CONVERSAZIONE ARRIVA A UN ESITO')
    );
    expect(regole).toMatch(/chiamare|telefon/i);
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

describe('rientro sul tema: la chat non diventa una chiacchierata personale', () => {
  // Il 1/08 una conversazione GDO è andata avanti due ore su musica, concerti e un
  // cortometraggio del lead, senza mai tornare al video di preparazione né alla call.
  // Il bot ha assecondato ogni deviazione ("mandalo pure, lo guardo con piacere",
  // "sto lavorando un po'"), alimentando un rapporto personale con una persona che
  // non esiste. Il prompt non aveva NESSUNA regola di rientro.
  const p = buildMarioSystem('Marta');

  it('esiste una sezione dedicata alle conversazioni che escono dal tema', () => {
    expect(p).toContain('SE LA CONVERSAZIONE ESCE DAL TEMA');
  });

  it('concede al massimo due scambi fuori tema, poi impone il rientro', () => {
    expect(p).toMatch(/al massimo due (scambi|messaggi) fuori tema/i);
    expect(p).toMatch(/riporta(lo)? (al|sul) (punto|tema)/i);
  });

  it('vieta di raccontare attività o gusti personali che non hai', () => {
    // "sto lavorando", "lo guardo stasera", "anche a me piace": sono bugie, e la
    // regola dell'onestà del prompt (non affermare di essere una persona reale) le
    // vieta già nello spirito. Qui diventa esplicita.
    expect(p).toMatch(/non raccontare mai attività, gusti o esperienze personali tue/i);
    expect(p).toMatch(/non promettere di guardare, leggere o ascoltare/i);
  });

  it('vieta di alimentare la confidenza con complimenti sulla persona', () => {
    expect(p).toMatch(/non fare complimenti alla persona/i);
  });

  it('passa la chat a un umano se il lead insiste sul personale o cerca un rapporto affettivo', () => {
    // Ancorato DENTRO la sezione: il prompt contiene già un "non insistere più di 2
    // volte sulla stessa obiezione, poi usa [PASSAGGIO_UMANO]" nella gestione
    // obiezioni, che farebbe passare il test senza che la regola nuova esista.
    const sezione = p.slice(p.indexOf('SE LA CONVERSAZIONE ESCE DAL TEMA'));
    const blocco = sezione.slice(0, sezione.indexOf('\n---'));
    expect(blocco).toContain('[PASSAGGIO_UMANO]');
    expect(blocco).toMatch(/insiste|affettiv|intim/i);
  });

  it('la regola vale anche quando l\'appuntamento è già fissato (caso GDO postino)', () => {
    expect(p).toContain('Vale anche a appuntamento già fissato');
  });
});

describe('date del richiamo — mai dedotte', () => {
  const p = buildMarioSystem('Marta');

  it('non autorizza più a usare la data dell\'appuntamento come ripiego', () => {
    expect(p).not.toContain('altrimenti la data dell\'appuntamento');
  });

  it('vieta esplicitamente di inventare giorno e ora', () => {
    expect(p).toContain('MAI INVENTARE UNA DATA');
  });

  it('dice di chiedere giorno e fascia oraria quando il lead non li dice', () => {
    expect(p).toMatch(/chiedigli.*che giorno/i);
  });

  it('permette di mettere nel tag le parole del lead al posto della data', () => {
    expect(p).toContain('le sue parole testuali');
  });

  it('senza una data detta dal lead la conversazione resta aperta', () => {
    expect(p).toContain('non emettere nessun tag');
  });
});
