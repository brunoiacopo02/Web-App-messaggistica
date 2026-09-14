import type { ClasseLancio } from './lancio-fase';
import { sanitizeOutbound } from './outbound-sanitize';

/**
 * Classificazione deterministica del messaggio del lead nella fase di attesa (spec §5.2):
 * le regex decidono i casi netti, il modello (con i tag) decide il resto. L'ordine
 * conta: un no vince su tutto, un punto di domanda vince su un sì.
 */

function normalizza(body: string): string {
  return body
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}?']+/gu, ' ')
    .trim();
}

const NO_SECCO = /^(no|nope|nah|no grazie|no grazie!?)$/;
const NO_FRASI = new RegExp(
  '\\b(' +
    [
      'non (mi|ci) interessa', 'non sono interessat[oa]', "non e per me", 'non fa per me',
      'togli(mi|etemi|temi)', 'cancell(ami|atemi)', 'rimuov(imi|etemi)', 'elimin(ami|atemi)',
      'non (mi )?scriv(ere|ete|etemi|ermi)( piu)?', 'non voglio( piu)?( ricevere)?', 'basta( messaggi)?', 'stop',
      'lasciat?e?mi (in pace|stare)', 'lasciami (in pace|stare)', 'numero sbagliato', 'sbagliato numero',
      'non (mi sono|ho) (mai )?iscritt[oa]', 'disiscriv', 'annulla(re|te)? (l )?iscrizione',
    ].join('|') +
    ')\\b',
);

const SI_PAROLE = new RegExp(
  '\\b(' +
    [
      'si', 'ok', 'okay', 'okey', 'certo', 'certamente', 'confermo', 'confermato', 'interessat[oa]',
      'ci sono', 'ci saro', 'va bene', 'vabene', 'vabbene', 'perfetto', 'assolutamente', 'volentieri',
      'presente', 'bloccalo', 'blocca(mi)? il posto', 'prenotami', 'ci sto', 'sono dentro', "d'accordo", 'daccordo',
    ].join('|') +
    ')\\b',
);
const NEGAZIONE = /\b(non|nessun[oa]?|mai)\b/;
const MAX_PAROLE_SI = 6;

const DOMANDA_INIZIO = new RegExp(
  '^(' +
    [
      'quanto', 'quando', 'dove', 'come', 'cosa', 'che', 'chi', 'perche', 'quale', 'quali',
      'a che ora', 'e a pagamento', 'costa', 'prezzo', 'gratis', 'gratuito', 'link', 'zoom',
      'posso', 'si puo', 'serve', 'devo', 'bisogna', 'mi spieghi', 'mi dici',
    ].join('|') +
    ')\\b',
);

export function classificaLancio(body: string | null | undefined): ClasseLancio {
  const raw = (body ?? '').trim();
  if (!raw) return 'incerto';
  const t = normalizza(raw);
  if (!t) return 'incerto';

  if (NO_SECCO.test(t) || NO_FRASI.test(t)) return 'no';
  if (t.includes('?') || DOMANDA_INIZIO.test(t)) return 'domanda';

  const parole = t.split(/\s+/).filter(Boolean);
  if (parole.length <= MAX_PAROLE_SI && SI_PAROLE.test(t) && !NEGAZIONE.test(t)) return 'si';

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
const ALTRI_TAG_RE = /\[[A-Z_:]+(?:\|[^\]]*)?\]/g;

/**
 * Legge i tag del modello lancio e li toglie dal testo. Senza tag la classe è
 * `domanda`: il modello ha comunque scritto una risposta, e si manda quella.
 */
export function parseLancioReply(raw: string): LancioReplyParsed {
  const m = raw.match(LANCIO_TAG_RE);
  const kind = m ? m[1].toUpperCase() : 'DOMANDA';
  const classe: LancioReplyParsed['classe'] = kind === 'SI' ? 'si' : kind === 'NO' ? 'no' : 'domanda';
  const passToHuman = raw.includes('[PASSAGGIO_UMANO]');
  const visibleReply = sanitizeOutbound(
    raw
      .replace(LANCIO_TAG_ALL_RE, '')
      .replace(/\[PASSAGGIO_UMANO\]/g, '')
      .replace(ALTRI_TAG_RE, '')
      .replace(/[ \t]{2,}/g, ' ')
      .trim(),
  );
  return { classe, passToHuman, visibleReply };
}
