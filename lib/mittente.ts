/**
 * Da QUALE numero parte un messaggio del bot Fenice.
 *
 * `lib/twilio-account.ts` risponde a un'altra domanda — con quali credenziali si
 * manda da un dato numero. Qui si decide il numero, e la regola e' una sola:
 *
 *   una conversazione NUOVA puo' nascere sul secondo numero, secondo una quota;
 *   una conversazione GIA' AVVIATA continua SEMPRE con il numero con cui e' nata.
 *
 * La seconda meta' non e' un dettaglio. Cambiare numero a chat aperta la spezza in due
 * thread agli occhi del lead e chiude la finestra delle 24 ore, che WhatsApp tiene per
 * coppia (numero azienda, numero lead): da quel momento il bot non puo' piu' rispondere
 * in testo libero. Il numero della chat sta in `conversations.wa_number`, scritto alla
 * nascita (vedi `findOrCreateLeadConversation`) e riscritto dal webhook in ingresso a
 * ogni messaggio del lead.
 *
 * Perche' un secondo numero: quello storico (`+393520413199`) e' a qualita' LOW, e il
 * nuovo sta su un WABA diverso — quindi e' un ripiego vero, non lo stesso punto di
 * rottura con un altro nome. Il PO lo vuole scaldare con ~100 lead nuovi al giorno: la
 * quota e' la manopola.
 *
 * Modulo puro: legge solo le env, niente DB, niente rete. Testato in mittente.test.ts.
 */

/** Normalizza per il confronto: `whatsapp:+39…` e `+39…` sono lo stesso numero. */
function soloNumero(n: string | null | undefined): string {
  return (n ?? '').trim().replace(/^whatsapp:/i, '');
}

/** Il numero storico, `TWILIO_WHATSAPP_NUMBER_FENICE`. Assente = configurazione rotta. */
export function numeroPrimario(): string | undefined {
  const n = (process.env.TWILIO_WHATSAPP_NUMBER_FENICE ?? '').trim();
  return n || undefined;
}

/** Il secondo numero, `TWILIO_WHATSAPP_NUMBER_FENICE_2`. Assente = esiste solo il primario. */
export function numeroSecondo(): string | undefined {
  const n = (process.env.TWILIO_WHATSAPP_NUMBER_FENICE_2 ?? '').trim();
  return n || undefined;
}

/**
 * La quota del secondo numero sulle conversazioni nuove, in percentuale (0-100), da
 * `FENICE_NUMERO2_QUOTA`.
 *
 * Fail-closed: assente, vuota, illeggibile o fuori dall'intervallo vale 0. Una env
 * scritta male non deve spostare traffico su un numero che magari non e' ancora
 * pronto — il costo di sbagliare in quella direzione e' un lead che scrive nel vuoto,
 * nell'altra e' solo un riscaldamento che parte piu' tardi.
 */
export function quotaSecondo(): number {
  const grezzo = (process.env.FENICE_NUMERO2_QUOTA ?? '').trim();
  if (grezzo === '') return 0;
  const n = Number(grezzo);
  if (!Number.isFinite(n) || n < 0 || n > 100) return 0;
  return n;
}

/**
 * Il mittente di una conversazione che nasce ADESSO.
 *
 * Il secondo numero con probabilita' `FENICE_NUMERO2_QUOTA`%, altrimenti il primario.
 * Senza il secondo numero, o con quota 0, e' sempre il primario. Torna `undefined`
 * solo se manca anche il primario: li' chi chiama deve fallire in modo esplicito, come
 * ha sempre fatto con la env assente.
 *
 * `sorteggio` e' iniettabile per i test: di default `Math.random`, cioe' un numero in
 * [0, 1). Con quota 100 il confronto `< 100` e' sempre vero, con quota 0 mai.
 */
export function mittentePerNuovaConversazione(sorteggio: () => number = Math.random): string | undefined {
  const primario = numeroPrimario();
  const secondo = numeroSecondo();
  const quota = quotaSecondo();
  if (!secondo || quota <= 0) return primario;
  return sorteggio() * 100 < quota ? secondo : primario;
}

/**
 * Il mittente di una conversazione GIA' ESISTENTE: quello con cui e' nata.
 *
 * `wa_number` vince, ma solo se e' uno dei numeri del bot. Il database e' condiviso con
 * altri flussi (campagne dal numero di default, Serenamente da `/api/send-template`)
 * e il webhook in ingresso scrive in `wa_number` QUALUNQUE numero a cui il lead ha
 * scritto: una conversazione nata da una campagna su un altro numero, se il CRM la
 * arruola in Mario, deve partire dal numero Fenice come ha sempre fatto — non dal
 * numero della campagna, dove il bot non risponde nemmeno (vedi `eNumeroDelBot`).
 *
 * Senza `wa_number` (le conversazioni nate prima che si scrivesse alla nascita) vale il
 * primario: e' il numero da cui sono partite tutte le aperture fino a oggi.
 */
export function mittenteDiConversazione(conv: { wa_number?: string | null } | null | undefined): string | undefined {
  const suo = (conv?.wa_number ?? '').trim();
  if (suo && eNumeroDelBot(suo)) return suo;
  return numeroPrimario();
}

/**
 * I numeri del bot cosi' come stanno in env (`whatsapp:+39…`), primario per primo.
 *
 * Grezzi apposta: e' la forma che Twilio mette nel `To` e che il webhook copia in
 * `conversations.wa_number`, quindi e' quella che serve ai filtri `.in('wa_number', …)`
 * delle rotte che cercano "le chat sui nostri numeri". Il confronto tollerante sta in
 * `eNumeroDelBot`.
 */
export function numeriDelBot(): string[] {
  return [numeroPrimario(), numeroSecondo()].filter((n): n is string => Boolean(n));
}

/**
 * Questo numero e' uno dei nostri (primario o secondo)?
 *
 * Serve al webhook in ingresso per decidere se svegliare il bot: deve conoscere
 * ENTRAMBI i numeri, altrimenti chi risponde al secondo scrive nel vuoto. Accetta
 * sia `whatsapp:+39…` (com'e' nel `To` di Twilio e in `wa_number`) sia `+39…`.
 */
export function eNumeroDelBot(to: string | null | undefined): boolean {
  const numero = soloNumero(to);
  return Boolean(numero) && numeriDelBot().map(soloNumero).includes(numero);
}
