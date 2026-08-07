/**
 * Riconoscimento testuale del "FATTO": il lead dice di aver visto il video pre-call.
 *
 * È una RETE DI SICUREZZA, non il canale principale: la conferma vera resta il tag
 * [VIDEO_VISTO] emesso dal modello. Il modello però se lo dimentica nel 40% dei casi
 * (40 lead scrivono FATTO/visto, solo 24 finiscono in colonna), e ogni conferma persa
 * è un lead che continua a ricevere solleciti dopo aver fatto quello che gli era stato
 * chiesto.
 *
 * Tarata verso il falso negativo: perdere una conferma costa un promemoria di troppo,
 * scambiare "lo guardo stasera" per una conferma costa il promemoria che serviva.
 */

/**
 * Il lead sta parlando al futuro o sta negando: qualunque conferma qui non vale.
 * `sara` copre "sarà fatto"/"sara fatto" (futuro di "essere" + participio, idioma
 * comunissimo per "lo farò") — dopo la normalizzazione l'accento è già sparito.
 */
const RINVIO_O_NEGAZIONE =
  /\b(non|nn|manco|devo|dovrei|dovro|appena|quando|ancora|stasera|domani|dopo|tardi|piu tardi|stanotte|domattina|guardero|vedro|provo|provero|riesco|riesco a|lo guardo|lo vedo|la guardo|sara)\b/;

/**
 * Visione dichiarata incompleta: il lead sta descrivendo QUANTO ha visto, non che ha
 * finito. "meta" è "metà" già privata dell'accento dalla normalizzazione — verificato,
 * non dato per scontato.
 */
const VISIONE_PARZIALE = /\b(solo|meta|inizio|quasi|parte|pezzo|poco)\b/;

/** "fatto un altro corso" non è mai una conferma: il verbo qui non parla del video. */
const ALTRO_CONTESTO = /\b(corso|corsi|altro|altra)\b/;

/**
 * "visto che ..." è il connettivo causale ("dato che"), non la conferma del video:
 * è una delle costruzioni più comuni dell'italiano scritto. Il guard è mirato sulla
 * sequenza "visto/vista" + "che" — non si aggiunge "che" alle negazioni generiche,
 * comparirebbe in mille frasi legittime che non c'entrano nulla col video.
 */
const VISTO_CHE = /\bvist[oa]\s+che\b/;

/** Le forme con cui in chat si dice "l'ho visto". */
const CONFERME = [
  /\bfatto\b/,
  /\bvisto\b/,
  /\bvista\b/,
  /\bguardat[oa]\b/,
  /\bfinito\b/,
];

export function confermaVideoVisto(body: string | null | undefined): boolean {
  const t = (body ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  if (!t) return false;
  if (RINVIO_O_NEGAZIONE.test(t)) return false;
  if (VISIONE_PARZIALE.test(t)) return false;
  if (ALTRO_CONTESTO.test(t)) return false;
  if (VISTO_CHE.test(t)) return false;
  return CONFERME.some((re) => re.test(t));
}
