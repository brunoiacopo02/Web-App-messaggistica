/**
 * Con quali credenziali Twilio si manda un messaggio.
 *
 * Fino al 16/09/2026 ce n'era un paio sole: tutti i numeri stavano sullo stesso
 * account. Poi e' arrivato `+393522070047`, che sta su un account Twilio
 * **separato** — e un account non puo' inviare da un numero che non possiede:
 * Twilio risponde 401 e il messaggio non parte. Il 26/09/2026 e' arrivato un
 * terzo account ("account elixir", +393522018718): principale + slot, non
 * piu' principale + secondo.
 *
 * Perche' un account separato e non un numero in piu' su quello di sempre: i
 * numeri storici condividono il WABA `1500822281514617`, e quando Meta
 * restringe un WABA blocca **tutti** i suoi numeri insieme (e' l'errore 63051
 * di giugno). Un secondo numero li' dentro non e' un ripiego, e' lo stesso
 * punto di rottura con un nome diverso. Ogni numero nuovo sta su un WABA suo:
 * e' il ripiego vero che abbiamo.
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

/** Normalizza per il confronto: `whatsapp:+39…` e `+39…` sono lo stesso numero. */
function soloNumero(n: string | null | undefined): string {
  return (n ?? '').trim().replace(/^whatsapp:/i, '');
}

/**
 * Gli account oltre al principale, per slot. Lo slot N legge
 * `TWILIO_ACCOUNT_SID_N`, `TWILIO_AUTH_TOKEN_N` e `TWILIO_WHATSAPP_NUMBERS_N`.
 * Il 2 e' "Account fenice 2" (+393522070047, 16/09/2026), il 3 e' "account
 * elixir" (+393522018718, 26/09/2026). Un numero non elencato in nessuno slot
 * sta sul principale: e' il caso di +393520158061, stesso account del 3199.
 */
const SLOT = [2, 3] as const;

function slot(n: number): { cred: CredenzialiTwilio | null; numeri: string[] } {
  const sid = process.env[`TWILIO_ACCOUNT_SID_${n}`];
  const token = process.env[`TWILIO_AUTH_TOKEN_${n}`];
  const numeri = (process.env[`TWILIO_WHATSAPP_NUMBERS_${n}`] ?? '')
    .split(',')
    .map((x) => soloNumero(x))
    .filter(Boolean);
  return { cred: sid && token ? { sid, token } : null, numeri };
}

/** Lo slot che dichiara questo numero, o null se il numero sta sul principale. */
function slotDi(from?: string | null): number | null {
  const numero = soloNumero(from);
  if (!numero) return null;
  for (const n of SLOT) if (slot(n).numeri.includes(numero)) return n;
  return null;
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
  const n = slotDi(from);
  if (n !== null) {
    const cred = slot(n).cred;
    if (cred) return cred;
    // Numero dichiarato su uno slot ma credenziali assenti: usare il
    // principale darebbe un 401 comunque. Si dice qui, dove si capisce perche'.
    console.error(
      `[twilio] ${soloNumero(from)} e' dichiarato sull'account ${n} ma TWILIO_ACCOUNT_SID_${n}/TWILIO_AUTH_TOKEN_${n} mancano`,
    );
  }
  return principale();
}

/** true se quel numero sta su un account diverso dal principale. */
export function eSuAltroAccount(from?: string | null): boolean {
  return slotDi(from) !== null;
}

/** Nome storico, usato ancora dai chiamanti del secondo numero. */
export const eDelSecondoAccount = eSuAltroAccount;

/** Le credenziali degli account secondari configurati, in ordine di slot. */
export function credenzialiSecondarie(): CredenzialiTwilio[] {
  return SLOT.map((n) => slot(n).cred).filter((c): c is CredenzialiTwilio => c !== null);
}
