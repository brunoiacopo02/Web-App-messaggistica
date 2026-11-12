/**
 * La richiesta esplicita di NON ESSERE PIÙ CONTATTATI (PO 12/11/2026, chat 32198).
 *
 * «Allora oggi non posso dato che insistete non voglio più essere contatta»: il giudice delle
 * disdette l'ha letta come «dubbio» (c'era un «oggi non posso») e, nello stesso minuto, la
 * segnalazione della risposta dopo il terzo tentativo di chiamata è arrivata alle Conferme
 * con scritto «l'appuntamento è ancora recuperabile». Decisione del PO: chi chiede in modo
 * esplicito di non essere più contattato non è MAI recuperabile.
 *
 * Qui solo il riconoscimento, a parole, senza I/O. Stretto di proposito: chi lo usa scarta
 * un lead o tace una segnalazione senza chiedere a nessuno, quindi deve scattare solo sulla
 * richiesta chiara. Restano FUORI, e li decide il giudice leggendo la chat:
 * - «non voglio essere chiamato», «si può fare senza telefonata?»: è il formato della call,
 *   non un addio (regola del manuale «NON È UNA RICHIESTA DI PASSAGGIO»); serve il «più»;
 * - «non scrivermi più», «non rispondermi più», «basta messaggi»: può volere solo la fine
 *   dei messaggi del bot tenendo la call («ho già l'appuntamento con Noemi, non rispondermi
 *   più»).
 */

function normalizza(t: string): string {
  return t
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[’`]/g, "'")
    .replace(/[^\p{L}\p{N}']+/gu, ' ')
    .trim();
}

/** Il contatto: contattare, chiamare, telefonare, cercare, disturbare (anche ri-). */
const RADICE = '(?:ri)?(?:contatt|chiam|telefon|cerc|disturb)';
/** Solo le forme rivolte a noi (contattatemi, chiamarmi, chiamate, chiami, cerchino): mai la
 *  prima persona, o «non cerco più lavoro» e «non chiamo più nessuno» scatterebbero. */
const A_NOI = `${RADICE}(?:atemi|ateci|armi|arci|ate|are|h?ino|h?i)`;
/** «più» o «mai più», ma non «più tardi» / «più avanti» / «più di una volta». */
const PIU = '(?:mai )?piu(?! (?:tardi|avanti|di|volte))';
const VOGLIO = '(?:voglio|vorrei|desidero|intendo|gradisco)';

/** Le forme col «più»: senza, «non voglio essere chiamato» parla del formato della call. */
const CON_PIU: RegExp[] = [
  // «non voglio più essere contattata» (anche «contatta», chat 32198), «non voglio essere più chiamato»
  new RegExp(`\\bnon ${VOGLIO} ${PIU} (?:essere |venire )${RADICE}\\w*`),
  new RegExp(`\\bnon ${VOGLIO} (?:essere |venire )${PIU} ${RADICE}\\w*`),
  new RegExp(`\\bnon ${VOGLIO} (?:essere |venire )${RADICE}\\w* ${PIU}\\b`),
  // «non contattatemi più», «non mi chiamate più», «non chiamatemi mai più», «non mi dovete più chiamare»
  new RegExp(`\\bnon (?:mi |ci )?${A_NOI} ${PIU}\\b`),
  new RegExp(`\\bnon (?:mi |ci )?(?:dovete|devi|deve|dovrete) ${PIU} ${A_NOI}\\b`),
  // «non voglio più ricevere chiamate», «non voglio più avere contatti», «non voglio più sentirvi»
  new RegExp(`\\bnon ${VOGLIO} ${PIU} (?:ricevere (?:altre |vostre |le vostre )?(?:chiamate|telefonate)|avere (?:altri )?contatti|sentirvi|sentirti)\\b`),
];

/** Le forme che valgono da sole: la cancellazione dei propri dati. */
const CANCELLAZIONE: RegExp[] = [
  // «cancellate il mio numero», «cancella pure il mio contatto», «eliminate i miei dati», «toglimi dalla lista»
  /\b(?:cancell\w*|elimin\w*|rimuov\w*|togli\w*) (?:pure |subito |per favore )?(?:il mio (?:numero|contatto|nominativo|recapito)|i miei (?:dati|contatti|recapiti)|dall[ae] (?:vostra |vostre )?list\w+)/,
  /\b(?:toglietemi|rimuovetemi|cancellatemi|eliminatemi)\b/,
];

/**
 * Il testo contiene una richiesta esplicita di non essere più contattati?
 * Più messaggi dello stesso turno si passano uniti (es. con « / »).
 */
export function chiedeDiNonEssereContattato(testo: string | null | undefined): boolean {
  const t = normalizza(testo ?? '');
  if (!t) return false;
  return CON_PIU.some((re) => re.test(t)) || CANCELLAZIONE.some((re) => re.test(t));
}
