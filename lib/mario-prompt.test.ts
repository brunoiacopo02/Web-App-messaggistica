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

  // Task 4 (2026-09-22): il bot non fa più riscrivere giorno e ora quando li conosce
  // già (37 lead su 83 li avevano appena scritti loro stessi, due messaggi prima). Ora
  // si divide in CASO 1 (li sa già: conferma e basta) e CASO 2 (manca l'ora: la chiede,
  // e SOLO quella, da sola).
  it('CASO 1: se conosce già giorno e ora non li fa riscrivere al lead, conferma e chiude con ESITO', () => {
    expect(p).toContain('CASO 1');
    expect(p).toContain("NON chiedere niente: quella è la data");
    expect(p).not.toContain('Confermami tu giorno e ora della call');
  });

  it('CASO 2: se manca l\'ora chiede solo quella, da sola, prima di Noemi e del video', () => {
    expect(p).toContain('CASO 2');
    expect(p).toContain('che orario hai scelto sul form?');
    expect(p).toContain('Quel messaggio va da solo');
  });

  // Fix round 1 (C-1, Critical): la prima stesura instradava un orario diverso dichiarato
  // dal lead verso "uno spostamento normale", che in fondo al prompt (SE INSISTE PER
  // SPOSTARE) fa proporre al bot due slot SUOI e chiudere su un orario che il lead non ha
  // mai detto — l'opposto di "LA DATA DI UNA CALL GIÀ FISSATA NON SI CORREGGE". Tolta la
  // riconferma, questo è l'unico canale rimasto da cui la data vera del form può emergere.
  it('CASO 1: se il lead dice poi un orario diverso da quello concordato, prende per buona la sua e non lo tratta come uno spostamento da slot', () => {
    expect(p).toContain('quella è la sua call: prendi per buona la sua e richiudi con [ESITO:APPUNTAMENTO|<la data che ti dice lui>]');
    expect(p).toContain('non correggerla coi tuoi slot');
    expect(p).not.toContain('lo gestisci come uno spostamento normale');
  });

  // M-6: la riga più importante del blocco nuovo non aveva nessuna asserzione.
  it('vieta esplicitamente di scegliere tu un\'ora che il lead non ha detto, anche per chiudere prima', () => {
    expect(p).toContain("MAI scegliere tu un'ora che il lead non ti ha detto, nemmeno per chiudere prima");
  });

  // M-5: la vecchia riga "non scriverlo mai da solo, senza altro testo visibile" (sul tag
  // legacy) proteggeva una regola vera — un tag da solo significa visibleReply vuoto,
  // niente bolle inviate, appuntamento registrato ma lead senza messaggio — ed era sparita
  // insieme al testo che la portava. Rimessa al nuovo trigger.
  it('il tag [ESITO:APPUNTAMENTO|...] non esce mai da solo, in nessuno dei due casi', () => {
    expect(p).toContain('non esce mai da solo, né in CASO 1 né in CASO 2');
    expect(p).toContain('mai il tag come unico contenuto della bolla');
  });

  // I-2: "che ti ha appena confermato lui" non è vero in CASO 1 (la data l'ha affermata
  // il bot, non il lead), e sommato a "aspetta che te li confermi" nel blocco Noemi dava
  // al modello un appiglio per far ripartire la domanda che il task doveva eliminare.
  it('il calcolo di quando chiama Noemi non presume più una "conferma" appena data dal lead', () => {
    expect(p).toContain("calcolandolo dal giorno e dall'ora della call e con la regola del blocco CHI È NOEMI E QUANDO CHIAMA");
    expect(p).not.toContain('che ti ha appena confermato lui');
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

describe('C1: i passaggi 2, 3 e 4 della conferma post-appuntamento escono sempre insieme nello stesso turno', () => {
  const p = buildMarioSystem('Marta');

  // Task 4 (2026-09-22): il passaggio 1 (giorno e ora) non è più qui dentro, è nel
  // blocco CASO 1/CASO 2 subito dopo che il lead scrive "Noemi" — vedi describe
  // 'conferme: anticipo e micro-impegni'. Qui restano solo Noemi, video e FATTO, che
  // continuano a uscire sempre insieme, senza aspettare risposta fra loro.
  it('istruisce a mandare i passaggi 2, 3 e 4 sempre insieme senza aspettare risposta tra un passaggio e l\'altro', () => {
    expect(p).toContain('Escono sempre insieme, uno per riga');
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
    // una qualunque menzione della stringa "CONFERMA POST-APPUNTAMENTO": la regola
    // tassativa (REGOLE TASSATIVE, punto 4) la cita anche lei fuori dal blocco, e un
    // indexOf generico prenderebbe la prima occorrenza sbagliata.
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

  // Task 4 (2026-09-22): non si usa più il tag legacy [APPUNTAMENTO_FISSATO] (senza
  // data) a questo trigger — è proprio quello a generare l'evento
  // 'booked_without_outcome' quando il modello non riesce a parsare una data. Ora, sia
  // in CASO 1 che in CASO 2, si chiude sempre con [ESITO:APPUNTAMENTO|<data>], che porta
  // la data con sé.
  it('CASO 1 e CASO 2 chiudono sempre con [ESITO:APPUNTAMENTO|<data>], mai con [APPUNTAMENTO_FISSATO] da solo', () => {
    expect(p).toContain('[ESITO:APPUNTAMENTO|<quella data in ISO 8601 con fuso>]');
    expect(p).toContain('[ESITO:APPUNTAMENTO|<giorno concordato + ora che ti ha detto, in ISO 8601 con fuso>]');
    expect(p).not.toContain('scrivi [APPUNTAMENTO_FISSATO] insieme ai quattro passaggi');
    expect(p).not.toContain('Quando risponde, scrivi: [APPUNTAMENTO_FISSATO]');
  });

  // I-4 (fix round 1): il tag legacy restava elencato fra quelli "da non mostrare mai al
  // lead" senza che nessuna istruzione dicesse più quando usarlo — un token nel
  // vocabolario senza regola d'uso è un invito a emetterlo al posto di [ESITO:...], e il
  // parser lo accetta (mario.ts) impostando appointmentFixed=true SENZA data: riapre
  // 'booked_without_outcome', il bug che questa task chiude.
  it('[APPUNTAMENTO_FISSATO] non è più nell\'elenco dei tag da usare: una riga esplicita dice di non usarlo più', () => {
    expect(p).not.toMatch(/\[APPUNTAMENTO_FISSATO\],\s*\[PASSAGGIO_UMANO\]/);
    expect(p).toContain('Il tag [APPUNTAMENTO_FISSATO] non si usa più');
    expect(p).toContain('per un appuntamento, in qualunque punto del flusso, usa sempre [ESITO:APPUNTAMENTO|<data ISO 8601 con fuso>]');
  });

  it('la riga introduttiva della CONFERMA dichiara di essere l\'unica eccezione alla regola dell\'attesa fra un messaggio e l\'altro', () => {
    expect(p).toContain(
      "È l'unico punto del flusso in cui non vale la regola dell'attesa fra un messaggio e l'altro."
    );
  });

  it('REGOLE TASSATIVE, punto 4 (UNA SOLA DOMANDA): nomina esplicitamente l\'eccezione della CONFERMA POST-APPUNTAMENTO', () => {
    // I-3 (fix round 1): la prima stesura restringeva l'eccezione ai soli passaggi 2-4,
    // lasciando la riga di conferma del CASO 1 (che parte nello stesso turno dei passaggi
    // 2-4, per il blocco CONFERMA POST-APPUNTAMENTO poco sotto) senza nessuna eccezione a
    // una regola marcata "non violarle MAI": letta alla lettera, il bot si fermava dopo la
    // conferma e Noemi/video/FATTO non uscivano mai (ensureConfirmationBlock non li
    // aggiunge da sola: patcha solo un video link già presente). L'eccezione ora copre
    // esplicitamente anche la conferma del CASO 1, e nomina esplicitamente che la domanda
    // del CASO 2 NON ne fa parte — resta soggetta alla regola base, di proposito.
    expect(p).toContain(
      "Aspetta sempre la risposta prima di continuare. Unica eccezione: la conferma di giorno e ora del CASO 1 e i passaggi 2, 3 e 4 della CONFERMA POST-APPUNTAMENTO, che escono insieme nello stesso turno. In CASO 2 la domanda sull'ora NON è coperta da questa eccezione: aspetta la risposta."
    );
  });
});

describe('fix conferme: Noemi chiama da un cellulare (non un numero fisso)', () => {
  const p = buildMarioSystem('Marta');

  it('il passaggio 2 precisa che Noemi chiama da un cellulare e invita a richiamare su quel numero', () => {
    expect(p).toContain('ti chiama da un cellulare:');
    expect(p).toContain('richiamala pure su quel numero');
    expect(p).not.toContain('richiamala pure allo stesso numero');
  });
});

describe('appuntamento già fissato — gestione della disdetta', () => {
  const p = buildMarioSystem('Marta');

  it('vieta il bivio "sposto o annullo"', () => {
    expect(p).toContain('non mettergli MAI davanti il bivio');
    expect(p).toMatch(/non proporgli tu di annullare/i);
  });

  it('riporta alla chiamata di Noemi come passaggio che conferma', () => {
    expect(p).toMatch(/sentiti con Noemi/i);
    expect(p).toContain('è il passaggio che conferma');
  });

  it('non promette più che "ti ricontatta una collega"', () => {
    expect(p).not.toContain('ti ricontatta una collega');
  });

  it('i rilanci dipendono dalla fermezza del no, non dal motivo', () => {
    expect(p).toContain('QUANTE VOLTE RIPROVARE');
    expect(p).toMatch(/quanto è fermo il no/i);
    expect(p).toMatch(/una seconda volta/i);
  });

  it('nel dubbio si ferma', () => {
    expect(p).toMatch(/nel dubbio fermati/i);
  });

  it('chiede il motivo, con una domanda sola', () => {
    expect(p).toMatch(/chiedi cosa è successo/i);
    expect(p).toMatch(/una domanda sola/i);
  });

  // Fino al contratto v1.5 il bot aveva il divieto di toccare giorno e ora di una call
  // gia' fissata, perche' il CRM scartava in silenzio le date diverse. Da quando le
  // registra, il divieto e' diventato il vicolo cieco: adesso propone lui gli slot.
  it('propone lui i nuovi orari quando il lead insiste per spostare', () => {
    expect(p).toContain('SE INSISTE PER SPOSTARE, SPOSTALO TU');
    expect(p).not.toContain('giorno e ora non li gestisci tu');
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
    expect(p).toContain('SE VUOLE SPOSTARE O DISDIRE');
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

describe('secondo recapito del lead', () => {
  const p = buildMarioSystem('Marta');

  it('insegna il tag NOTA invece di rimbalzare il lead a Noemi', () => {
    expect(p).toContain('[NOTA|Secondo recapito del lead:');
    expect(p).not.toContain('diglielo a Noemi appena ti chiama');
  });

  it('dice che senza il tag non parte niente', () => {
    expect(p).toMatch(/senza tag non parte niente/i);
  });

  // [NOTA|...] stava cannibalizzando [PASSAGGIO_UMANO]: "puoi farmi chiamare su questo
  // numero, 392..." cadeva nell'intersezione fra le due righe, e la più specifica era
  // quella della nota — che per contratto non assegna la telefonata a nessuno.
  it('la NOTA da sola vale solo per una chiamata che il lead già aspetta', () => {
    expect(p).toContain('per una chiamata CHE GIÀ LO ASPETTA');
  });

  it('se è il lead a CHIEDERE di essere chiamato partono tutti e due i tag', () => {
    expect(p).toMatch(/È LUI A CHIEDERE DI ESSERE CHIAMATO[\s\S]{0,400}\[PASSAGGIO_UMANO\][\s\S]{0,200}\[NOTA\|Secondo recapito del lead:/);
    expect(p).toContain('Con la sola [NOTA|...] non lo chiama nessuno');
  });

  it('il tag NOTA non deve mai restare visibile al lead, come gli altri tag tecnici', () => {
    expect(p).toContain('[NOTA|...] non devono MAI essere visibili al lead');
  });

  // "un solo tag per messaggio" (senza qualifica) contraddiceva la regola qui sopra, che
  // impone [PASSAGGIO_UMANO] e [NOTA|...] insieme quando è il lead a chiedere di essere
  // chiamato: il modello poteva leggerla come un divieto e ometterne uno dei due.
  it('la regola sul tag unico riguarda solo [ESITO:...], e lascia liberi gli altri tag di accompagnarlo', () => {
    expect(p).toContain('un solo tag [ESITO:...] per messaggio');
    expect(p).not.toContain('un solo tag per messaggio');
    expect(p).toMatch(/restano liberi di accompagnarlo/);
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

// Task 8, fix round 1 (2026-09-22): questa regola non aveva NESSUNA asserzione
// in 790 righe di test — l'unica del blocco esiti che cambia cosa legge un
// cliente vero. Copre: il divieto di promettere un richiamo o un messaggio
// futuro (in ogni fascia, non solo quella lontana), il congedo oltre una
// settimana, l'assenza delle vecchie promesse false ("ti fai vivo tu", "ti fai
// sentire qui su WhatsApp" per un "quando" vicino), e l'eccezione per
// l'appuntamento già fissato.
describe('RICHIAMO: mai una promessa di richiamo o di un messaggio futuro del bot', () => {
  const p = buildMarioSystem('Marta');

  it('vieta esplicitamente, in forma di divieto, di promettere un richiamo o un messaggio futuro, in ogni fascia', () => {
    expect(p).toMatch(/NON PROMETTERE MAI un richiamo né un tuo messaggio futuro/);
    expect(p).toContain('in nessuna fascia');
  });

  it('dice che il tag comunica solo il "quando", non chi farà cosa', () => {
    expect(p).toContain('questo tag dice solo QUANDO lui vorrebbe, e a cosa farne ci pensa il sistema, non tu');
  });

  it('oltre una settimana congeda il lead invece di promettere di farsi vivo', () => {
    expect(p).toContain('oltre una settimana');
    expect(p).toContain('da qui non gli scrivi più tu');
    expect(p).toContain('può scrivere lui su questa chat');
  });

  // Fix round 1, C-1 (Critical): il codice applicava il congedo solo entro la
  // finestra "restituisci vs scarta" ma il prompt prometteva "ti fai vivo tu"
  // per QUALUNQUE "quando" vicino, anche quello che finiva restituito a un GDO
  // (chat chiusa, il bot non scrive più). Ora il prompt non fa più nessuna
  // promessa sul "quando" vicino: tace, e basta.
  it('per un "quando" entro la settimana non promette più di farsi vivo lui', () => {
    expect(p).not.toContain('ti fai vivo tu');
    expect(p).not.toMatch(/Il massimo che puoi dire è che ti fai sentire qui su WhatsApp/);
    expect(p).toContain('non aggiungere nient\'altro su chi scrive a chi');
  });

  it('non promette mai una telefonata o un messaggio a data precisa, in nessuna fascia', () => {
    expect(p).toMatch(/NON PROMETTERE MAI UNA TELEFONATA[\s\S]{0,80}né un tuo messaggio a una data precisa[\s\S]{0,60}in nessuna fascia/);
  });

  // Important: senza questa eccezione il congedo dice "non ti scriverò più" a
  // un lead che vuole solo spostare una call che ha già fissata (RICHIAMO ha un
  // significato diverso lì: vedi SE L'APPUNTAMENTO È GIÀ FISSATO).
  it('non si applica quando l\'appuntamento è già fissato', () => {
    expect(p).toMatch(/ECCEZIONE: se l'appuntamento è GIÀ FISSATO[\s\S]{0,250}va congedato/);
  });
});

describe('FASE 6 — un giorno alla volta', () => {
  const p = buildMarioSystem('Marta');

  it('propone un solo giorno per volta, partendo dal primo', () => {
    expect(p).toContain('Proponi UN GIORNO ALLA VOLTA');
    expect(p).toMatch(/parti sempre dal primo/i);
  });

  it('non propone più i due giorni insieme', () => {
    expect(p).not.toContain('Proponi tu i due giorni');
    expect(p).not.toContain('oppure [secondo giorno]');
  });

  it('prima cerca un orario dentro il primo giorno', () => {
    expect(p).toMatch(/prima prova a trovargli un orario dentro quel giorno/i);
  });
});

// Il punto in cui si perde più gente: su 360 lead a cui la call è stata proposta, solo
// il 18% è arrivato ad accettarla, e quasi nessuno aveva detto no — dicevano "ci penso",
// "ti contatto io", "ora lavoro", oppure facevano una domanda. Nelle chat vere è il BOT
// che chiude: "in bocca al lupo", "scrivimi quando vuoi", "prenditi il tempo che serve".
describe('SE RIMANDA LA CALL — il rimando prima del fissaggio', () => {
  const p = buildMarioSystem('Marta');

  it('esiste una sezione dedicata al rimando della call, distinta da quella sul giorno', () => {
    expect(p).toContain('SE RIMANDA LA CALL');
    expect(p.indexOf('SE RIMANDA LA CALL')).toBeLessThan(p.indexOf('SE IL LEAD NON PUÒ'));
  });

  it('vieta di chiudere la porta col saluto: l\'ultimo messaggio è un passo con un quando', () => {
    expect(p).toContain('non chiudere TU la porta');
    expect(p).toContain('non è un saluto');
  });

  it('tratta la domanda come una domanda, non come un rifiuto', () => {
    expect(p).toContain('UNA DOMANDA NON È UN NO');
  });

  it('separa il "non posso spendere" dalla call, che è gratuita e non impegna', () => {
    expect(p).toContain('la call è gratuita e non impegna');
  });

  it('sul rinvio al materiale prende un impegno con un giorno, invece di lasciare la palla al lead', () => {
    expect(p).toMatch(/PRIMA GUARDO IL CORSO[\s\S]{0,400}Non lasciarlo a "scrivimi tu/);
  });

  // Fix round 2, Minor: "Così mi faccio sentire dopo e ne parliamo" era una promessa
  // di un messaggio futuro del bot non coperta dal divieto del tag RICHIAMO (che
  // vietava solo le promesse "a una data precisa"): onesta se il lead rispondeva
  // "stasera o domani", falsa se rispondeva con un orizzonte di 4-7 giorni, perché lì
  // la chat si chiude (restituzione a un GDO) e il bot non scrive più.
  it('sul rinvio al materiale non promette più un messaggio futuro del bot', () => {
    expect(p).not.toContain('Così mi faccio sentire dopo e ne parliamo');
    expect(p).toMatch(/PRIMA GUARDO IL CORSO[\s\S]{0,400}vale la regola del RICHIAMO in ogni fascia/);
  });

  it('vieta esplicitamente fretta, scarsità e senso di colpa', () => {
    expect(p).toContain('Non usare mai la fretta, la scarsità o il senso di colpa');
  });

  it('applica la stessa regola sulla fermezza del no delle disdette: sul no fermo ci si ferma subito', () => {
    const sezione = p.slice(p.indexOf('SE RIMANDA LA CALL'), p.indexOf('SE IL LEAD NON PUÒ'));
    expect(sezione).toContain('quanto è fermo il no');
    expect(sezione).toContain('non insisti di un millimetro');
  });

  it('INTERROTTO non esce alla prima frase di rimando', () => {
    expect(p).toMatch(/\[ESITO:INTERROTTO\|<motivo breve>\][^\n]*NON alla prima frase/);
  });

  // Fix round 1, C-2 (Critical): "non chiudere TU la porta" e il congedo del
  // RICHIAMO oltre una settimana erano in contraddizione diretta (il congedo È
  // "scrivimi quando vuoi"), senza che nessuna delle due regole si facesse da
  // parte per l'altra. Serve un'eccezione esplicita qui, dentro la stessa
  // sezione che vieta di chiudere la porta.
  it('C-2: fa eccezione esplicita per il congedo del RICHIAMO oltre una settimana', () => {
    const sezione = p.slice(p.indexOf('SE RIMANDA LA CALL'), p.indexOf('SE IL LEAD NON PUÒ'));
    expect(sezione).toMatch(/ECCEZIONE[\s\S]{0,80}\[ESITO:RICHIAMO\|/);
    expect(sezione).toContain('oltre una settimana');
    expect(sezione).toContain('non conta come chiudere la porta');
  });

  // Fix round 1, "Important": la voce "CI PENSO / TI FACCIO SAPERE IO" prendeva
  // "quell'appuntamento a parola" come un impegno del bot — esattamente ciò che
  // la voce RICHIAMO del glossario vieta. Deve rimandare al tag, non a una
  // promessa propria.
  it('"CI PENSO / TI FACCIO SAPERE IO" non prende più un impegno a parola: rimanda al tag RICHIAMO', () => {
    expect(p).not.toContain("prendi quell'appuntamento a parola");
    expect(p).toMatch(/CI PENSO \/ TI FACCIO SAPERE IO[\s\S]{0,400}\[ESITO:RICHIAMO\|/);
  });
});

// Contratto v1.5: il bot puo' rifissare. Prima diceva "ti ricontatta una collega" e
// il lead restava con un appuntamento che non gli andava bene.
describe('buildMarioSystem — spostamento di una call gia\' fissata', () => {
  const p = () => buildMarioSystem('Marta');

  it('dice al bot di proporre lui i nuovi slot', () => {
    expect(p()).toContain('SE INSISTE PER SPOSTARE');
    expect(p()).toContain('SLOT APPUNTAMENTO');
  });

  it('lo spostamento si chiude con APPUNTAMENTO, non con RICHIAMO', () => {
    expect(p()).toContain('[ESITO:APPUNTAMENTO|<data ISO del nuovo orario>]');
  });

  it('non promette piu\' la collega per far spostare', () => {
    expect(p()).toContain('Non rimandarlo mai a una collega per farlo spostare');
  });

  it('tiene separato lo spostamento dal caso "mi dice quando e\' la call che ha"', () => {
    // Il bug del 26/08: il bot correggeva il giorno della call gia' fissata dal GDO
    // usando i propri slot e convinceva il lead della data sbagliata.
    expect(p()).toContain('LA DATA DI UNA CALL GIÀ FISSATA NON SI CORREGGE');
    expect(p()).toContain('SPOSTARE è quando il lead CHIEDE lui un altro giorno');
  });

  it('senza un quando resta un RICHIAMO', () => {
    expect(p()).toContain('se vuole spostare ma non ti dice quando');
  });
});

describe('CHI È NOEMI E QUANDO CHIAMA', () => {
  const p = buildMarioSystem('Marta');

  it('separa la preselezione dalla call col venditore', () => {
    expect(p).toContain('CHI È NOEMI E QUANDO CHIAMA');
    expect(p).toContain('Noemi fa la PRESELEZIONE, non la trattativa');
    expect(p).toContain('non chiamarla mai "la consulente" o "la tutor"');
  });

  it('lega l orario della chiamata all ora della call, con la soglia delle 15', () => {
    expect(p).toContain('call dalle 15:00 in poi');
    expect(p).toContain('call PRIMA DELLE 15:00');
    expect(p).toContain('il POMERIGGIO DEL GIORNO PRIMA');
  });

  // Noemi attacca alle 13:00 (quella resta la sua ora vera), ma "qualche ora prima" di
  // una call alle 13 o alle 14 cadrebbe prima delle 13, quando Noemi non c'è ancora: al
  // committente questo spostava la soglia fra i due rami da 13:00 a 15:00 (02/09).
  it("non promette mai un anticipo prima delle 13, quando Noemi non c'è", () => {
    expect(p).toContain("prima di quell'ora non chiama mai");
    expect(p).toContain('Mai la mattina');
  });

  it('copre esplicitamente le call delle 13 e delle 14 chiamando il giorno prima', () => {
    expect(p).toMatch(/call.*delle 13 e delle 14/);
  });

  it('vieta le frasi che fanno tenere il telefono nel momento sbagliato', () => {
    for (const frase of [
      'ti chiama poco prima',
      'ti chiama qualche minuto prima',
      'ti chiama la mattina stessa',
      'ti sta per chiamare',
    ]) {
      expect(p).toContain(frase);
    }
    expect(p).toContain('Queste frasi sono SBAGLIATE');
  });

  it('vieta di vendere la call come se fosse breve quanto Noemi', () => {
    expect(p).toContain('I 5-10 minuti sono di Noemi, non della call');
  });

  it('se giorno e ora non sono noti non si tira a indovinare', () => {
    expect(p).toContain('non tirare a indovinare');
  });
});

describe('fuori finestra non si fissa', () => {
  const p = buildMarioSystem('Marta');

  it('dice che fuori dai due giorni non si fissa, mai', () => {
    expect(p).toContain('Fuori da quei due giorni NON si fissa, mai');
  });

  it('chiede di insistere dentro la finestra prima di mollare', () => {
    expect(p).toContain('cerca il buco dentro quei due giorni');
  });

  it('vieta di confermare un giorno fuori finestra anche se lo propone il lead', () => {
    expect(p).toContain('anche se è il lead a proportelo');
  });
});
