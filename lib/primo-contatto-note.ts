/**
 * La dichiarazione IA per chi ci scrive per primo.
 *
 * Le aperture dichiarate dicono "sono Marta, l'assistente digitale di Fenice Academy",
 * ma vivono dentro i TEMPLATE (`lib/persona.ts`): un lead adottato dal webhook non ne
 * riceve nessuno, quindi senza questa nota non se lo sentirebbe mai dire. L'AI Act
 * art. 50 e' in vigore dal 02/08/2026 e chiede la dichiarazione al primo contatto.
 *
 * E' una nota appesa al system prompt, non un messaggio fisso: il modello la integra nel
 * saluto invece di sparare un annuncio addosso a chi ha appena fatto una domanda. Stessa
 * meccanica di `gdoContextNote`.
 */
export const NOTA_PRIMO_CONTATTO =
  'PRIMO CONTATTO: questa persona ha scritto lei per prima e non ha mai ricevuto un ' +
  'nostro messaggio, quindi non sa con chi sta parlando. Nel PRIMO messaggio che le mandi ' +
  "presentati come l'assistente digitale di Fenice Academy, con parole tue e senza farne " +
  'un annuncio: mezza riga dentro il saluto, poi rispondi subito a quello che ha chiesto. ' +
  'Nei messaggi successivi non ripeterlo.';

/**
 * La nota, se sulla conversazione non e' mai uscito niente da parte nostra.
 *
 * Il template di RIAGGANCIO non conta come "qualcosa da parte nostra". Per i 29 recuperati
 * da `app/api/cron/adotta-mai-risposti/route.ts` quel messaggio e' il primo contatto in
 * assoluto — sono stati scelti proprio perche' non avevano nessun outbound — e non
 * dichiara l'IA. Senza questa eccezione, alla loro prima risposta la cronologia conteneva
 * gia' un outbound e la nota spariva: quelle persone non si sarebbero mai sentite dire
 * con chi stanno parlando (AI Act art. 50). Per loro la prima risposta libera e' ancora
 * il primo momento in cui possiamo dichiararci.
 *
 * Env `MARTA_REENGAGE_TEMPLATE_SID` assente ⇒ nessuna eccezione, comportamento identico
 * a prima.
 */
export function notaPrimoContatto(
  rows: readonly { direction: string; template_sid?: string | null }[],
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const riaggancio = env.MARTA_REENGAGE_TEMPLATE_SID;
  const nostro = rows.some((r) => r.direction === 'out'
    && !(riaggancio && r.template_sid === riaggancio));
  return nostro ? undefined : NOTA_PRIMO_CONTATTO;
}
