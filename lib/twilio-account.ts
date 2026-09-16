/**
 * Con quali credenziali Twilio si manda un messaggio.
 *
 * Fino al 16/09/2026 ce n'era un paio sole: tutti i numeri stavano sullo stesso
 * account. Poi e' arrivato `+393522070047`, che sta su un account Twilio
 * **separato** — e un account non puo' inviare da un numero che non possiede:
 * Twilio risponde 401 e il messaggio non parte.
 *
 * Perche' un account separato e non un numero in piu' su quello di sempre: i
 * numeri storici condividono il WABA `1500822281514617`, e quando Meta
 * restringe un WABA blocca **tutti** i suoi numeri insieme (e' l'errore 63051
 * di giugno). Un secondo numero li' dentro non e' un ripiego, e' lo stesso
 * punto di rottura con un nome diverso. Il numero nuovo sta su un WABA suo:
 * e' il primo ripiego vero che abbiamo.
 *
 * Modulo puro: legge solo le env, niente rete. Testato in twilio-account.test.ts.
 */

export type CredenzialiTwilio = { sid: string; token: string };

/** L'account storico. Resta il ripiego quando un numero non e' mappato. */
function principale(): CredenzialiTwilio | null {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  return sid && token ? { sid, token } : null;
}

/** Il secondo account. Assente = esiste solo il principale. */
function secondario(): CredenzialiTwilio | null {
  const sid = process.env.TWILIO_ACCOUNT_SID_2;
  const token = process.env.TWILIO_AUTH_TOKEN_2;
  return sid && token ? { sid, token } : null;
}

/** Normalizza per il confronto: `whatsapp:+39…` e `+39…` sono lo stesso numero. */
function soloNumero(n: string | null | undefined): string {
  return (n ?? '').trim().replace(/^whatsapp:/i, '');
}

/**
 * I numeri che appartengono al secondo account, da `TWILIO_WHATSAPP_NUMBERS_2`
 * (separati da virgola).
 *
 * E' un elenco esplicito e non una deduzione: sbagliare account significa un
 * 401 al momento dell'invio, cioe' un messaggio che non parte e un lead che
 * resta senza risposta. Meglio doverlo scrivere che doverlo indovinare.
 */
function numeriDelSecondo(): string[] {
  return (process.env.TWILIO_WHATSAPP_NUMBERS_2 ?? '')
    .split(',')
    .map((n) => soloNumero(n))
    .filter(Boolean);
}

/**
 * Le credenziali con cui inviare DA questo numero.
 *
 * Senza `from` (o con un numero non mappato) torna il principale: e' il
 * comportamento di sempre, e un numero dimenticato nell'elenco continua a
 * partire dall'account storico invece di non partire affatto.
 *
 * Torna null solo se mancano anche le credenziali principali: li' non c'e'
 * ripiego possibile e chi chiama deve fallire in modo esplicito.
 */
export function credenzialiPerMittente(from?: string | null): CredenzialiTwilio | null {
  const numero = soloNumero(from);
  if (numero && numeriDelSecondo().includes(numero)) {
    const secondo = secondario();
    if (secondo) return secondo;
    // Numero dichiarato del secondo account ma credenziali assenti: usare il
    // principale darebbe un 401 comunque. Si dice qui, dove si capisce perche'.
    console.error(
      `[twilio] ${numero} e' dichiarato sul secondo account ma TWILIO_ACCOUNT_SID_2/TWILIO_AUTH_TOKEN_2 mancano`,
    );
  }
  return principale();
}

/** true se quel numero risulta appartenere al secondo account. */
export function eDelSecondoAccount(from?: string | null): boolean {
  const numero = soloNumero(from);
  return Boolean(numero) && numeriDelSecondo().includes(numero);
}
