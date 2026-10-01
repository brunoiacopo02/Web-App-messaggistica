import type { ClasseLancio } from './lancio-fase';
import { sanitizeOutbound } from './outbound-sanitize';

/**
 * Classificazione deterministica del messaggio del lead nella fase di attesa (spec §5.2):
 * le regex decidono i casi netti, il modello (con i tag) decide il resto. L'ordine
 * conta: il rifiuto esplicito vince su tutto, poi chi non puo' esserci quella sera (o chiede
 * la registrazione), poi una domanda vince sul "no" generico
 * ("c'è un investimento iniziale sì o no" chiede una cosa, non congeda), poi il no; e
 * un punto di domanda vince sempre su un sì.
 */

function normalizza(body: string): string {
  return body
    .toLowerCase()
    .replace(/[’]/g, "'") // apostrofo tipografico (’) come apostrofo dritto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}?']+/gu, ' ')
    .trim();
}

const NO_SECCO = /^(no|nope|nah|no grazie|no grazie!?)$/;
/**
 * Il rifiuto ESPLICITO: chi scrive così vuole uscire, anche se ci mette un punto di
 * domanda ("non mi interessa, chiaro?"). Vince su tutto, domanda compresa.
 */
const NO_ESPLICITO = new RegExp(
  '\\b(' +
    [
      // "piu": "Ciao, non sono più interessata" restava incerto e andava al modello.
      'non (mi|ci) interessa', 'non sono (piu )?interessat[oa]',
      'togli(mi|etemi|temi)', 'cancell(ami|atemi)', 'rimuov(imi|etemi)', 'elimin(ami|atemi)',
      'non (mi )?scriv(ere|ete|etemi|ermi)( piu)?', 'non voglio piu ricevere',
      'lasciat?e?mi (in pace|stare)', 'lasciami (in pace|stare)', 'numero sbagliato', 'sbagliato numero',
      // `\w*`: col `\b` finale un "disiscriv" nudo non prendeva mai "disiscrivimi"
      'disiscriv\\w*', 'annulla(re|te)? (l )?iscrizione',
      // "ti chiedo di cancellare la mia iscrizione in quanto non potrò partecipare": chi
      // chiede di cancellarsi esce, anche se il motivo e' l'orario (vince sulla
      // registrazione). L'apostrofo resta nel testo normalizzato: "l'iscrizione".
      "(annull|cancell)(a|are|ate) (l'|l |la )?(mia )?iscrizione",
    ].join('|') +
    ')\\b',
);
/**
 * Il "no" meno netto: è un rifiuto quando il messaggio è solo quello, ma una domanda lo
 * batte — chi chiede qualcosa sta ancora parlando con noi, e risponde il modello.
 */
const NO_FRASI = new RegExp(
  '\\b(' +
    [
      // "non voglio piu" e basta: il vecchio `non voglio( piu)?` leggeva come rifiuto
      // "non voglio perdermela!" e "non voglio partecipare e poi trovarmi costretta a
      // comprare" (che e' una domanda). "non voglio piu ricevere" e' gia' in NO_ESPLICITO.
      'no grazie', "non e per me", 'non fa per me', 'non voglio piu', 'stop',
      'non (mi sono|ho) (mai )?iscritt[oa]',
    ].join('|') +
    ')\\b',
);
/**
 * "basta" è un rifiuto solo quando è (quasi) tutto il messaggio: "basta", "basta così",
 * "basta messaggi", "basta scrivermi". Dentro una frase è quasi sempre "è sufficiente"
 * ("basta un collegamento audio?", "basta digitarlo sul pc?"), e il vecchio `basta`
 * dentro NO_FRASI congedava proprio chi chiedeva come collegarsi.
 */
const BASTA_INTERO =
  /^(ok |ora |adesso |dai |e )?basta( cosi| messaggi| con (i|questi) messaggi| scriver(mi|e)| mandarmi messaggi)?( grazie| per favore)?$/;
/**
 * Non puo' esserci quella sera, o chiede la registrazione (decisione PO 01/10/2026): non
 * e' un congedo, gli si promette la registrazione. Viene DOPO il rifiuto esplicito ("non
 * mi interessa più, annullate l'iscrizione" resta un no) e PRIMA della domanda: "Sarà
 * disponibile registrazione?" chiede proprio questo, non una cosa generica. Solo i casi
 * netti, presi dai messaggi veri della lista d'attesa: il resto lo decide il modello col
 * tag [LANCIO:REGISTRAZIONE].
 *
 * Vale per il turno dell'attesa (B1). In assistenza (la sera, col link in mano) "non
 * riesco a collegarmi" e' un problema tecnico: li' questa regex non si applica e decide
 * il modello.
 */
const REGISTRAZIONE = new RegExp(
  [
    // "registrazione", ma non quella del sito: "ho fatto la registrazione", "la mia registrazione".
    '(?<!(fatto|completato|confermato|finito|terminato) (la )?)(?<!mia )\\bregistrazion[ei]\\b',
    // "si potrà vedere anche registrato?", e non "mi sono registrata" (= iscritta).
    '\\b(vedere|vederl[ao]|guardare|guardarl[ao]|rivedere|rivederl[ao]|disponibile|sara|verra|viene) (anche )?registrat[ao]\\b',
    '\\breplay\\b', '\\bdifferita\\b', '\\brivederl[ao]\\b',
    "\\brivedere (la |il |l')?(live|webinar|diretta|evento|video)\\b",
    // non posso / non riesco / non potrò esserci, partecipare, collegarmi, seguirla, venire...
    '\\bnon (ci )?(posso|potro|riesco|riusciro|ce la faccio|ce la faro) (a )?(esserci|essere presente|partecipar(e|ci|vi)|collegarmi|connettermi|seguir(e|la|lo)|venire|presenziare)\\b',
    '\\bnon (ci )?(posso|potro) essere\\b', '\\bnon ci saro\\b',
    // il giorno o l'ora, poi il no: "Purtroppo lunedì non riesco.", "è alle 21, non posso".
    "\\b(lunedi|il 5|5 ottobre|quella sera|quel giorno|quell'ora|alle 21|alle nove) (purtroppo )?non (posso|riesco|potro|riusciro|ci sono|ci saro)\\b",
    // e al contrario: "non posso alle 21", "non riesco lunedì".
    "\\bnon (posso|riesco|potro|riusciro|ci sono|ci saro) (lunedi|il 5|alle 21|quella sera|quel giorno|a quell'ora)\\b",
    // "non posso, mi dispiace" in chiusura del messaggio: a una lista d'attesa e' l'orario.
    '\\bnon (posso|riesco)( purtroppo)?( mi (di)?spiace)?$',
    // impegni: "ho già un altro impegno", "sono impegnata"; mai "non ho altri impegni".
    '(?<!non )\\bho (gia )?(un |degli |altri )?(altr[oi] )?impegn[oi]\\b', '\\b(sono|saro) (gia )?impegnat[oa]\\b',
    // lavoro e turni: "il 5 sono fuori per lavoro", "sarò in turno", "lavorerò".
    '\\b(saro|sono) (fuori|al lavoro|a lavoro|in turno|di turno|in viaggio)\\b', '\\blavorero\\b',
    "\\blavoro (quella sera|lunedi|il 5|alle 21|di sera|a quell'ora)\\b", '\\b(ho|avro) (il )?turno\\b',
  ].join('|'),
);

/** "sì o no" chiude la frase con un "no" che non è un rifiuto: è una domanda che pretende
 *  una risposta secca ("c'è un investimento iniziale sì o no"). */
const SI_O_NO = /\bsi o no\b/;
/**
 * Idiomi con "no"/"nessun" che NON sono una negazione ("no problem", "nessun
 * problema"): tolti dal testo prima di ogni controllo no/sì, così non fanno
 * scattare né il "no" isolato né NEGAZIONE su una frase che è un sì.
 */
function rimuoviIdiomiNeutri(t: string): string {
  return t
    .replace(/\bno problemo?\b/g, ' ')
    .replace(/\bnessun problema\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const SI_PAROLE = new RegExp(
  '\\b(' +
    [
      'si', 'ok', 'okay', 'okey', 'certo', 'certamente', 'confermo', 'confermato', 'interessat[oa]',
      'ci sono', 'ci saro', 'va bene', 'vabene', 'vabbene', 'perfetto', 'assolutamente', 'volentieri',
      'presente', 'bloccalo', 'blocca(mi)? il posto', 'prenotami', 'ci sto', 'sono dentro', "d'accordo", 'daccordo',
      // Ringraziamenti e ricevute: il benvenuto chiede di rispondere per confermare che il
      // numero è attivo, e "grazie", "ricevuto", "il numero è attivo" sono proprio quella
      // risposta. Il tetto di parole e NEGAZIONE tengono fuori "grazie ma non posso".
      'grazie', 'ricevut[oa]', 'arrivat[oa]', 'attivo',
    ].join('|') +
    ')\\b',
);
const NEGAZIONE = /\b(non|nessun[oa]?|mai)\b/;
/** Un "ma"/"però" o un "basta" in mezzo trasformano la frase in qualcos'altro che un sì
 *  secco ("grazie ma ci penso", "ok basta così"): decide il modello. */
const FRENA_SI = /\b(ma|pero|basta)\b/;
const MAX_PAROLE_SI = 6;

/** Come continua un "no" in apertura perché resti un rifiuto: vuoto, o una di
 *  queste parole. "assolutamente" e "per niente" qui sono un rinforzo del no
 *  ("no, assolutamente" = no di certo), non il "sì" che sono da soli. */
const RIFIUTO_APERTURA_RE = new RegExp(
  '^(' + ['grazie', 'non', 'nessun[oa]?', 'mai', 'assolutamente', 'per niente'].join('|') + ')\\b',
);

const DOMANDA_INIZIO = new RegExp(
  '^(' +
    [
      'quanto', 'quando', 'dove', 'come', 'cosa', 'che', 'chi', 'perche', 'quale', 'quali',
      'a che ora', 'e a pagamento', 'costa', 'prezzo', 'gratis', 'gratuito', 'link', 'zoom',
      'posso', 'si puo', 'serve', 'devo', 'bisogna', 'mi spieghi', 'mi dici',
    ].join('|') +
    ')\\b',
);

/**
 * Il solo livello ESPLICITO del no: le frasi di rifiuto (`NO_ESPLICITO`, `NO_FRASI` — "non
 * mi interessa", "toglimi dalla lista", "non scrivermi più", "no grazie" — e il "basta"
 * che è tutto il messaggio), senza il "no" secco e senza il "basta" dentro una frase.
 *
 * Serve dove il "no" del lead è quasi sempre la risposta a una DOMANDA del bot e non un
 * congedo: nell'assistenza al collegamento ("hai l'app Zoom?" → "no") un `classificaLancio`
 * secco scartava il lead e chiudeva la chat proprio mentre chiedeva aiuto per entrare.
 * Nell'attesa del B1 la domanda la fa il lead, e lì il "no" secco resta un no: quella
 * classificazione non cambia.
 */
export function congedoEsplicito(body: string | null | undefined): boolean {
  const raw = (body ?? '').trim();
  if (!raw) return false;
  const t = rimuoviIdiomiNeutri(normalizza(raw));
  return t !== '' && (NO_ESPLICITO.test(t) || NO_FRASI.test(t) || BASTA_INTERO.test(t));
}

export function classificaLancio(body: string | null | undefined): ClasseLancio {
  const raw = (body ?? '').trim();
  if (!raw) return 'incerto';
  let t = normalizza(raw);
  if (!t) return 'incerto';
  t = rimuoviIdiomiNeutri(t);
  if (!t) return 'incerto';

  if (NO_ESPLICITO.test(t) || BASTA_INTERO.test(t)) return 'no';
  // Dopo il rifiuto esplicito e prima della domanda: chi non c'e' quella sera non si
  // congeda, e "ci sarà una registrazione?" e' proprio questa richiesta.
  if (REGISTRAZIONE.test(t)) return 'registrazione';
  // Una domanda vince sul "no" che non è un rifiuto esplicito: "investimento iniziale sì
  // o no" finisce con "no" ma chiede una cosa, e trattarlo da congedo perdeva il lead.
  if (t.includes('?') || SI_O_NO.test(t)) return 'domanda';
  if (NO_SECCO.test(t) || NO_FRASI.test(t)) return 'no';
  if (DOMANDA_INIZIO.test(t)) return 'domanda';

  const parole = t.split(/\s+/).filter(Boolean);
  const formaDaSi =
    parole.length <= MAX_PAROLE_SI && SI_PAROLE.test(t) && !NEGAZIONE.test(t) && !FRENA_SI.test(t);

  if (parole.includes('no')) {
    // In chiusura ("certo che no", "assolutamente no") il "no" è sempre la
    // testa semantica del messaggio: vince il no.
    if (parole[parole.length - 1] === 'no') return 'no';

    if (parole[0] === 'no') {
      // In apertura vince il no solo se il resto resta un rifiuto (vuoto o
      // RIFIUTO_APERTURA_RE: "no grazie", "no non mi interessa", "no,
      // assolutamente"...). Se il resto ha un segnale da sì o si apre con un
      // avversativo ("no ma sono interessato", "no dai, in realtà mi
      // interessa") — o comunque non è un rifiuto riconoscibile — è ambiguo:
      // mai un sì, ma nemmeno un no automatico, decide il modello.
      const resto = parole.slice(1).join(' ');
      return resto === '' || RIFIUTO_APERTURA_RE.test(resto) ? 'no' : 'incerto';
    }

    // "no" in mezzo alla frase: ambiguo, mai un sì, mai un no automatico.
    return 'incerto';
  }

  if (formaDaSi) return 'si';

  return 'incerto';
}

/**
 * Chi riscrive dopo il congedo (piano 2026-10-01, Task 3). Fino al 1/10 un lead del
 * lancio congedato restava muto per sempre: conv 22484, dopo il congedo, ha scritto
 * "Vorrei sapere del percorso" e "Durata, modalità di svolgimento e prezzo" senza
 * ricevere niente; conv 21596 "È possibile avere una registrazione? O ci sarà una altra
 * data per lo meno?". Quelle persone non stavano dicendo di nuovo no.
 *
 * Qui si decide se il messaggio scioglie il congedo. In dubbio NO: riaprire su chi
 * protesta ("Vergognatevi", "x queste puttanate e da stalking") e' peggio che lasciare
 * in silenzio un "grazie". Per questo la regola e' a segnale positivo, nell'ordine:
 *  1. il rifiuto (esplicito o il "no" del classificatore) resta chiuso;
 *  2. insulti e proteste restano chiusi;
 *  3. le chiusure di cortesia ("grazie", "👍", "ok buona serata", "a lei grazie",
 *     "altrettanto") restano chiuse: sono la risposta al congedo, non una richiesta;
 *  4. riapre una domanda ("?"), una richiesta di informazioni, un ripensamento, chi non
 *     puo' esserci o chiede la registrazione, un sì vero ("ci sarò");
 *  5. tutto il resto ("Grazie a voi. E scusate ancora per il disguido") resta chiuso.
 */
const PROTESTA =
  /\b(vergogn\w*|stalk\w*|puttan\w*|truff\w*|spam\w*|molest\w*|denunc\w*|perditempo|ridicol\w*|schif\w*|squallid\w*|imbroglion\w*|smettetela|smettila|cazz\w*|vaffa\w*|fanculo)\b/;
/**
 * Le richieste di uscita che `congedoEsplicito` non vede perche' non parlano al bot in
 * seconda persona: "Eliminate ogni mio contatto", "vorrei essere cancellata". Qui
 * bastano per tenere chiuso: "vorrei" da solo, piu' sotto, riaprirebbe.
 */
const USCITA = /\b(cancellat[oae]|cancellate|rimoss[oa]|elimina(te|to|ta)|non (voglio|desidero) (piu|essere)|non contattatemi|contattarmi piu)\b/;
/** Le parole di una chiusura di cortesia: un messaggio fatto SOLO di queste non riapre. */
const CORTESIA = new Set([
  'grazie', 'mille', 'tante', 'ok', 'okay', 'okey', 'va', 'bene', 'vabene', 'si', 'buona', 'buon', 'buonanotte',
  'buonasera', 'buongiorno', 'giornata', 'serata', 'notte', 'sera', 'pomeriggio', 'weekend', 'domenica',
  'a', 'lei', 'te', 'voi', 'anche', 'altrettanto', 'ciao', 'salve', 'arrivederci', 'saluti', 'cordiali',
  'ricevuto', 'ricevuta', 'perfetto', 'gentile', 'gentilissimo', 'gentilissima', 'gentilissimi', 'presto',
  'capito', 'chiaro', "d'accordo", 'daccordo', 'figurati', 'prego', 'e', 'di', 'cuore', 'tutto', 'ancora',
]);
/** I segnali che il lead vuole parlare: informazioni, ripensamento, altre date. */
const RIAPRE = new RegExp(
  [
    'vorrei', 'volevo (sapere|capire|chiedere)', 'sapere', 'informazion[ei]', 'info', 'dettagli',
    'percorso', 'corso', 'durata', 'modalita', 'prezz[oi]', 'cost[oia]', 'programma',
    // ripensamento: "Intendevo spero non sia interessante" chiariva un messaggio letto male
    'intendevo', 'volevo dire', 'mi sono (spiegat|sbagliat)[oa]', 'ho sbagliato', 'ci ho ripensato', 'ripensato',
    'in realta', 'anzi', '(sono|sarei) (ancora )?interessat[oa]', 'mi interessa',
    'altr[ae] dat[ae]', 'prossim[ao] (data|live|evento|webinar)',
    // "Avevo piacere poterlo vedere" (conv 21596, dopo la data persa): vuole la live.
    'avevo piacere', 'mi (piacerebbe|farebbe piacere)', '(poterl[ao] |di )?veder(e|l[ao])',
  ].map((p) => `\\b${p}\\b`).join('|'),
);

export function congedoDaRevocare(body: string | null | undefined): boolean {
  const raw = (body ?? '').trim();
  if (!raw) return false;
  const t = rimuoviIdiomiNeutri(normalizza(raw));
  // Solo emoji, sticker in testo, punteggiatura: "👍" e' un saluto, non una richiesta.
  if (!t || !/\p{L}/u.test(t)) return false;
  if (congedoEsplicito(raw)) return false;
  const classe = classificaLancio(raw);
  if (classe === 'no') return false;
  if (PROTESTA.test(t) || USCITA.test(t)) return false;
  const parole = t.replace(/\?/g, ' ').split(/\s+/).filter(Boolean);
  if (parole.every((p) => CORTESIA.has(p))) return false;
  if (t.includes('?')) return true;
  if (classe === 'domanda' || classe === 'registrazione' || classe === 'si') return true;
  return RIAPRE.test(t);
}

export type LancioReplyParsed = {
  classe: 'si' | 'no' | 'domanda' | 'registrazione';
  passToHuman: boolean;
  visibleReply: string;
};

const LANCIO_TAG_RE = /\[LANCIO:(SI|DOMANDA|NO|REGISTRAZIONE)\]/i;
const LANCIO_TAG_ALL_RE = /\[LANCIO:(SI|DOMANDA|NO|REGISTRAZIONE)\]/gi;
/** Qualsiasi altro tag tecnico fra parentesi quadre (anche uno di Mario uscito per
 *  sbaglio, es. `[ESITO:SCARTO|x]`: i due punti fanno parte del nome). */
const ALTRI_TAG_RE = /\[[A-Z_:]+(?:\|[^\]]*)?\]/gi;
const PASSAGGIO_UMANO_RE = /\[PASSAGGIO_UMANO\]/i;
const PASSAGGIO_UMANO_RE_G = /\[PASSAGGIO_UMANO\]/gi;

/**
 * Legge i tag del modello lancio e li toglie dal testo. Senza tag la classe è
 * `domanda`: il modello ha comunque scritto una risposta, e si manda quella.
 */
export function parseLancioReply(raw: string): LancioReplyParsed {
  const m = raw.match(LANCIO_TAG_RE);
  const kind = m ? m[1].toUpperCase() : 'DOMANDA';
  const classe: LancioReplyParsed['classe'] =
    kind === 'SI' ? 'si' : kind === 'NO' ? 'no' : kind === 'REGISTRAZIONE' ? 'registrazione' : 'domanda';
  const passToHuman = PASSAGGIO_UMANO_RE.test(raw);
  const visibleReply = sanitizeOutbound(
    raw
      .replace(LANCIO_TAG_ALL_RE, '')
      .replace(PASSAGGIO_UMANO_RE_G, '')
      .replace(ALTRI_TAG_RE, '')
      // righe rimaste vuote perché un tag stava da solo sulla sua riga (o fra righe
      // vuote): 2+ a-capo consecutivi (con eventuali spazi in mezzo) diventano uno solo.
      .replace(/[ \t]*\n[ \t]*(?:\n[ \t]*)+/g, '\n')
      .replace(/[ \t]{2,}/g, ' ')
      .trim(),
  );
  return { classe, passToHuman, visibleReply };
}
