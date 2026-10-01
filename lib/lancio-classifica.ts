import type { ClasseLancio } from './lancio-fase';
import { sanitizeOutbound } from './outbound-sanitize';

/**
 * Classificazione deterministica del messaggio del lead nella fase di attesa (spec §5.2):
 * le regex decidono i casi netti, il modello (con i tag) decide il resto. L'ordine
 * conta: il rifiuto esplicito vince su tutto, poi una domanda vince sul "no" generico
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
      'non (mi|ci) interessa', 'non sono interessat[oa]',
      'togli(mi|etemi|temi)', 'cancell(ami|atemi)', 'rimuov(imi|etemi)', 'elimin(ami|atemi)',
      'non (mi )?scriv(ere|ete|etemi|ermi)( piu)?', 'non voglio piu ricevere',
      'lasciat?e?mi (in pace|stare)', 'lasciami (in pace|stare)', 'numero sbagliato', 'sbagliato numero',
      // `\w*`: col `\b` finale un "disiscriv" nudo non prendeva mai "disiscrivimi"
      'disiscriv\\w*', 'annulla(re|te)? (l )?iscrizione',
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
      'no grazie', "non e per me", 'non fa per me', 'non voglio( piu)?( ricevere)?', 'stop',
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

export type LancioReplyParsed = {
  classe: 'si' | 'no' | 'domanda';
  passToHuman: boolean;
  visibleReply: string;
};

const LANCIO_TAG_RE = /\[LANCIO:(SI|DOMANDA|NO)\]/i;
const LANCIO_TAG_ALL_RE = /\[LANCIO:(SI|DOMANDA|NO)\]/gi;
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
  const classe: LancioReplyParsed['classe'] = kind === 'SI' ? 'si' : kind === 'NO' ? 'no' : 'domanda';
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
