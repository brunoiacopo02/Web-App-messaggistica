/**
 * Da QUALE numero parte un messaggio del bot Fenice.
 *
 * `lib/twilio-account.ts` risponde a un'altra domanda — con quali credenziali si
 * manda da un dato numero. Qui si decide il numero, e la regola e' una sola:
 *
 *   una conversazione GIA' AVVIATA continua SEMPRE con il numero con cui e' nata;
 *   una conversazione NUOVA nasce sul primario, a meno che `scegliMittenteNuovo`
 *   (lib/scelta-mittente.ts) non scelga esplicitamente un secondario, guardando
 *   i tetti in `app_settings.tetti_numeri`.
 *
 * La prima meta' non e' un dettaglio. Cambiare numero a chat aperta la spezza in due
 * thread agli occhi del lead e chiude la finestra delle 24 ore, che WhatsApp tiene per
 * coppia (numero azienda, numero lead): da quel momento il bot non puo' piu' rispondere
 * in testo libero. Il numero della chat sta in `conversations.wa_number`, scritto alla
 * nascita (vedi `findOrCreateLeadConversation`) e riscritto dal webhook in ingresso a
 * ogni messaggio del lead.
 *
 * Perche' dei numeri secondari: il primario (`+393520413199`) e' a qualita' LOW, e i
 * secondari stanno su WABA diversi — un ripiego vero, non lo stesso punto di rottura
 * con un altro nome. Fino al 26/09/2026 c'era un solo secondario scelto per quota
 * casuale (`FENICE_NUMERO2_QUOTA`, ora tolta); da qui in poi l'elenco viene da
 * `BOT_NUMERI_SECONDARI` e la scelta passa dai tetti, non dal caso.
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
 * I numeri secondari del bot, da `BOT_NUMERI_SECONDARI` (separati da virgola).
 * Assente = il solo `TWILIO_WHATSAPP_NUMBER_FENICE_2`, com'era fino al 26/09/2026:
 * cosi' il deploy di questo codice non cambia niente finche' non si scrive l'env.
 * Essere nell'elenco vuol dire due cose: il webhook sveglia Mario sulle risposte
 * a quel numero, e il numero PUO' essere scelto per una chat nuova — se ha un
 * tetto in `app_settings.tetti_numeri` (lib/tetti-numeri.ts).
 */
export function numeriSecondari(): string[] {
  const grezzo = process.env.BOT_NUMERI_SECONDARI;
  const lista = grezzo === undefined
    ? [numeroSecondo()].filter((n): n is string => Boolean(n))
    : grezzo.split(',').map((n) => n.trim()).filter(Boolean);
  const primario = soloNumero(numeroPrimario());
  const visti = new Set<string>();
  return lista.filter((n) => {
    const k = soloNumero(n);
    if (!k || k === primario || visti.has(k)) return false;
    visti.add(k);
    return true;
  });
}

/**
 * Il mittente di una conversazione che nasce senza una scelta esplicita: il
 * primario. Dal 26/09/2026 una chat nasce su un secondario solo passando da
 * `scegliMittenteNuovo` (lib/scelta-mittente.ts), che guarda tetti e template.
 * Il vecchio sorteggio `FENICE_NUMERO2_QUOTA` lo scavalcava: tolto.
 * `sorteggio` resta nella firma per non rompere i chiamanti.
 */
export function mittentePerNuovaConversazione(_sorteggio: () => number = Math.random): string | undefined {
  return numeroPrimario();
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
  const primario = numeroPrimario();
  return [...(primario ? [primario] : []), ...numeriSecondari()];
}

/**
 * Questo numero e' uno dei nostri (primario o uno dei secondari)?
 *
 * Serve al webhook in ingresso per decidere se svegliare il bot: deve conoscere TUTTI
 * i numeri, altrimenti chi risponde a un secondario scrive nel vuoto. Accetta sia
 * `whatsapp:+39…` (com'e' nel `To` di Twilio e in `wa_number`) sia `+39…`.
 */
export function eNumeroDelBot(to: string | null | undefined): boolean {
  const numero = soloNumero(to);
  return Boolean(numero) && numeriDelBot().map(soloNumero).includes(numero);
}
