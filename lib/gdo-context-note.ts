import { GDO_CONTEXT_NOTE } from './mario';
import { romeHour } from './rome-time';

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
  'da un cellulare; sono 5-10 minuti, perché serve tempo per capire bene ' +
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
  /** Ora della call fissata dal bot. Serve a dire quando chiama Noemi. */
  botScheduledAt?: string | null;
  /** Ora della call fissata dal GDO al telefono. Vince la più recente delle due. */
  gdoAppuntamentoAt?: string | null;
}

/**
 * Noemi attacca a lavorare alle 13:00, quella resta la sua ora d'inizio vera. Ma per una call
 * delle 13 o delle 14 "qualche ora prima lo stesso giorno" cadrebbe quando Noemi non c'è ancora:
 * quelle si coprono chiamando il pomeriggio del giorno prima. Sotto questa soglia, giorno prima;
 * da qui in su, stesso giorno.
 */
const NOEMI_SOGLIA_STESSO_GIORNO = 15;

/** L'ora vera della call: per un lead GDO può stare su due colonne, vince la più recente. */
export function oraAppuntamento(
  botScheduledAt: string | null | undefined,
  gdoAppuntamentoAt: string | null | undefined,
): Date | null {
  const ts = [botScheduledAt, gdoAppuntamentoAt]
    .filter((v): v is string => !!v && !Number.isNaN(Date.parse(v)))
    .map((v) => Date.parse(v));
  return ts.length ? new Date(Math.max(...ts)) : null;
}

/** La riga su quando chiama Noemi, vuota se non sappiamo quando è la call. */
export function quandoChiamaNoemi(quando: Date | null): string {
  if (!quando) return '';
  return romeHour(quando) < NOEMI_SOGLIA_STESSO_GIORNO
    ? ' Digli QUANDO lo chiama: il pomeriggio del giorno prima della call, non la mattina stessa, quindi tenga il telefono a portata già dal pomeriggio precedente.'
    : ' Digli QUANDO lo chiama: lo stesso giorno della call, qualche ora prima. Dagli la finestra, mai un orario al minuto.';
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
  if (serveNoemi(i)) {
    parti.push(NOTA_NOEMI + quandoChiamaNoemi(oraAppuntamento(i.botScheduledAt, i.gdoAppuntamentoAt)));
  }
  return parti.join('\n\n');
}
