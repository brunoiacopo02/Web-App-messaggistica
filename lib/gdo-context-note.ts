import { GDO_CONTEXT_NOTE } from './mario';

/**
 * Promemoria che il bot deve portarsi dentro la conversazione con un lead GDO.
 *
 * Non sono messaggi: sono istruzioni appese al system prompt, così il modello li
 * integra nel discorso invece di sparare un testo fisso addosso a chi magari sta
 * parlando d'altro. È la differenza fra un sollecito e una conversazione.
 */

export const NOTA_VIDEO =
  'PROMEMORIA VIDEO: il lead ha ricevuto il video da vedere prima della call ma non ha ' +
  'ancora confermato di averlo visto. Ricordaglielo in modo naturale: se c\'è un discorso ' +
  'aperto rispondi prima a quello e aggancia il video alla fine. Se glielo hai già chiesto ' +
  'in uno dei tuoi ultimi messaggi, per questo turno lascia perdere: non insistere.';

export const NOTA_NOEMI =
  'PROMEMORIA NOEMI: il lead non ha ancora sentito da te della chiamata di preselezione. ' +
  'Diglielo adesso, con parole tue e questa sostanza: gliene avrà già parlato il collega e ' +
  'tu glielo ripeti così non gli scappa; Noemi è la collega della preselezione e lo chiama ' +
  'da un cellulare prima della call; sono 5-10 minuti, perché serve tempo per capire bene ' +
  "la sua situazione; è il passaggio che conferma l'appuntamento, quindi tenga il telefono " +
  'a portata; se la chiamata gli scappa non è un problema, può richiamare su quel numero. ' +
  'Non farne un esame e non metterlo in soggezione.';

/**
 * Variante di GDO_CONTEXT_NOTE per il turno in cui il video sta uscendo INSIEME alla
 * risposta del modello: qui il video non è ancora arrivato al lead, quindi la frase
 * "te l'ho già mandato" sarebbe falsa e il modello la ripeterebbe al lead.
 */
export const GDO_CONTEXT_NOTE_VIDEO_IN_USCITA =
  "CONTESTO DI QUESTA CONVERSAZIONE: l'appuntamento di questo lead è GIÀ FISSATO — l'ha preso " +
  'un tuo collega al telefono, e tu gli hai già mandato il link per scegliere giorno e ora. ' +
  'Applica la sezione "SE L\'APPUNTAMENTO È GIÀ FISSATO": non ripartire col pitch e non ' +
  'riproporre la call. Il collega non si nomina mai. ' +
  'IL VIDEO ESCE ORA: subito dopo il tuo messaggio, in automatico, al lead arriva il link del ' +
  'video da vedere prima della call. Non scriverlo tu, non mandare nessun link e non dire che ' +
  "gliel'hai già mandato: rispondi a quello che ti ha appena scritto e basta.";

export interface GdoNoteInput {
  gdoVideoSentAt: string | null;
  gdoVideoWatchedAt: string | null;
  gdoNoemiRemindedAt: string | null;
  followupsSent: number;
  /** Il lead ha confermato la visione proprio in questo turno. */
  videoAppenaConfermato: boolean;
  /** Il video sta partendo insieme a questa risposta (primo turno del lead GDO). */
  videoInUscita?: boolean;
}

/**
 * Noemi si spiega quando il lead si fa vivo davvero: conferma di aver visto il video,
 * oppure risponde dopo che gli è arrivato almeno un sollecito. E una volta sola.
 */
export function serveNoemi(i: GdoNoteInput): boolean {
  if (i.gdoNoemiRemindedAt) return false;
  return i.videoAppenaConfermato || i.followupsSent > 0;
}

/** La nota completa da passare a `generateMarioReply({ contextNote })`. */
export function gdoContextNote(i: GdoNoteInput): string {
  const parti = [i.videoInUscita ? GDO_CONTEXT_NOTE_VIDEO_IN_USCITA : GDO_CONTEXT_NOTE];
  // Il promemoria "ricordagli il video" non ha senso nel turno in cui il video esce.
  if (!i.videoInUscita && i.gdoVideoSentAt && !i.gdoVideoWatchedAt) parti.push(NOTA_VIDEO);
  if (serveNoemi(i)) parti.push(NOTA_NOEMI);
  return parti.join('\n\n');
}
