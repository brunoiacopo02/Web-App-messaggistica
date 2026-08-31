/**
 * Da quale numero WhatsApp esce un messaggio.
 *
 * Perche' esiste: il numero Fenice (+39 352 041 3199) e' l'unico attivo ed e' sceso a
 * qualita' LOW. La qualita' Meta si misura **per numero**, quindi spalmare i primi
 * contatti su un secondo numero sano evita di bruciare l'unico che abbiamo. NON serve
 * a fare piu' volume: dal 7 ottobre 2025 i limiti di messaggistica sono per business
 * portfolio e sono condivisi da tutti i numeri.
 *
 * La regola non negoziabile e' la stickiness: il numero si sceglie **una volta sola**,
 * all'iscrizione, e da li' in poi si legge da `conversations.wa_number`. Cambiarlo a
 * conversazione aperta la spezza in due thread agli occhi del lead e chiude la
 * finestra 24h, che vale per coppia (numero azienda, numero lead).
 */

/** Il numero storico: resta il default finche' la quota non dice altro. */
function primario(): string | undefined {
  return process.env.TWILIO_WHATSAPP_NUMBER_FENICE;
}

/** Il secondo numero. Assente = tutto resta sul primario. */
function secondario(): string | undefined {
  return process.env.TWILIO_WHATSAPP_NUMBER_FENICE_2;
}

/**
 * Il mittente di una conversazione gia' avviata. Sempre quello con cui e' iniziata;
 * il primario solo quando non ne ha ancora uno (conversazioni nate prima di questa
 * modifica).
 */
export function numeroMittente(conv: { wa_number?: string | null } | null | undefined): string | undefined {
  return conv?.wa_number ?? primario();
}

/**
 * Il mittente per una conversazione nuova. `FENICE_NUMERO2_QUOTA` e' la percentuale
 * di nuovi lead da mandare sul secondo numero: 0 (default) tiene tutto com'e' oggi.
 */
export function assegnaNumeroMittente(sorteggio: () => number = Math.random): string | undefined {
  const secondo = secondario();
  if (!secondo) return primario();

  const quota = Number(process.env.FENICE_NUMERO2_QUOTA ?? '0');
  if (!Number.isFinite(quota) || quota <= 0) return primario();

  return sorteggio() * 100 < quota ? secondo : primario();
}

/**
 * Il messaggio e' arrivato su un numero del bot? E' la guardia del webhook in ingresso:
 * decide se svegliare Mario. Deve conoscere TUTTI i numeri del bot, altrimenti i lead
 * spostati sul secondo scrivono nel vuoto.
 */
export function eNumeroDelBot(to: string | null | undefined): boolean {
  if (!to) return false;
  return to === primario() || (Boolean(secondario()) && to === secondario());
}
