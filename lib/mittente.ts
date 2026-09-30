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

/** La forma di env e di `wa_number`: `whatsapp:+39…`, qualunque sia quella scritta. */
function inFormaWhatsapp(n: string): string {
  return `whatsapp:${soloNumero(n)}`;
}

/**
 * Normalizza e deduplica un elenco di numeri (confronto senza prefisso),
 * togliendo quelli in `escludi` (per chiave `soloNumero`).
 */
function pulisci(lista: (string | undefined)[], escludi: Set<string> = new Set()): string[] {
  const visti = new Set(escludi);
  const fuori: string[] = [];
  for (const grezzo of lista) {
    const k = soloNumero(grezzo);
    if (!k || visti.has(k)) continue;
    visti.add(k);
    fuori.push(inFormaWhatsapp(k));
  }
  return fuori;
}

/** Un elenco separato da virgola in una env; assente = vuoto. */
function elencoEnv(chiave: string): string[] {
  return (process.env[chiave] ?? '').split(',').map((n) => n.trim()).filter(Boolean);
}

/**
 * I numeri secondari SCEGLIBILI per una chat nuova, da `BOT_NUMERI_SECONDARI`
 * (separati da virgola). Assente = il solo `TWILIO_WHATSAPP_NUMBER_FENICE_2`,
 * com'era fino al 26/09/2026: cosi' il deploy di questo codice non cambia niente
 * finche' non si scrive l'env. Vuota (`""`) = nessun secondario sceglibile.
 *
 * Essere qui vuol dire che il numero PUO' essere scelto per una chat nuova — se ha
 * un tetto in `app_settings.tetti_numeri` (lib/tetti-numeri.ts). Essere
 * RICONOSCIUTO dal bot (webhook, chat esistenti) e' un'altra cosa, piu' larga:
 * vedi `numeriDelBot`. Ogni voce esce in forma `whatsapp:+…`, anche se in env e'
 * scritta `+39…`: e' la forma che finisce in `wa_number` e nei filtri.
 */
export function numeriSecondari(): string[] {
  const grezzo = process.env.BOT_NUMERI_SECONDARI;
  const lista = grezzo === undefined ? [numeroSecondo()] : grezzo.split(',').map((n) => n.trim());
  return pulisci(lista, new Set([soloNumero(numeroPrimario())].filter(Boolean)));
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
 * TUTTI i numeri che il bot RICONOSCE come suoi, in forma `whatsapp:+39…`,
 * primario per primo: il primario, i sceglibili (`numeriSecondari`), il
 * `TWILIO_WHATSAPP_NUMBER_FENICE_2` e i numeri dichiarati sugli altri account
 * (`TWILIO_WHATSAPP_NUMBERS_2` / `_3`, lib/twilio-account.ts), deduplicati.
 *
 * Piu' largo dei sceglibili apposta: un numero puo' essere a riposo per le chat
 * nuove (fuori da `BOT_NUMERI_SECONDARI`, o con tetto 0) e avere ancora chat vive.
 * Se non fosse riconosciuto, il webhook non sveglierebbe Mario sulle risposte a
 * quel numero e `mittenteDiConversazione` riporterebbe la chat sul primario,
 * spezzandola. Dimenticare il 0047 in `BOT_NUMERI_SECONDARI` non deve costare le
 * sue chat.
 *
 * La forma `whatsapp:+…` e' quella che Twilio mette nel `To` e che il webhook
 * copia in `conversations.wa_number`: serve ai filtri `.in('wa_number', …)` delle
 * rotte che cercano "le chat sui nostri numeri". Il confronto tollerante sta in
 * `eNumeroDelBot`.
 */
export function numeriDelBot(): string[] {
  return pulisci([
    numeroPrimario(),
    ...numeriSecondari(),
    numeroSecondo(),
    ...elencoEnv('TWILIO_WHATSAPP_NUMBERS_2'),
    ...elencoEnv('TWILIO_WHATSAPP_NUMBERS_3'),
  ]);
}

/**
 * Questo numero e' uno dei nostri (uno qualunque di `numeriDelBot`)?
 *
 * Serve al webhook in ingresso per decidere se svegliare il bot: deve conoscere TUTTI
 * i numeri, altrimenti chi risponde a un secondario scrive nel vuoto. Accetta sia
 * `whatsapp:+39…` (com'e' nel `To` di Twilio e in `wa_number`) sia `+39…`.
 */
export function eNumeroDelBot(to: string | null | undefined): boolean {
  const numero = soloNumero(to);
  return Boolean(numero) && numeriDelBot().map(soloNumero).includes(numero);
}
