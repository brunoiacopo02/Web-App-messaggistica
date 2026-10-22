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
  'Diglielo adesso in frasi corte e semplici, con questa sostanza: gliene avrà già parlato il ' +
  'collega e tu glielo ripeti così non gli scappa; lo chiama Noemi, una collega, da un numero di ' +
  'cellulare; sono 5-10 minuti e serve a confermare la videochiamata; deve rispondere, perché se ' +
  'non risponde la videochiamata non è confermata; se la chiamata gli scappa, la richiami subito ' +
  'su quel numero. Metti tra asterischi, *così*, quando lo chiama. Chiaro e diretto, ma senza ' +
  'fargli un esame.';

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

/** "giovedì 23": il giorno italiano col numero, come lo deve leggere il lead. */
function giornoRoma(d: Date): string {
  return new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', weekday: 'long', day: 'numeric' }).format(d);
}

/** La riga su quando chiama Noemi, vuota se non sappiamo quando è la call. Il giorno è
 *  scritto per intero col numero: "il giorno prima" da solo, a chi legge di fretta, non dice
 *  niente. */
export function quandoChiamaNoemi(quando: Date | null): string {
  if (!quando) return '';
  const call = `${giornoRoma(quando)} alle ${formatOra(quando)}`;
  if (romeHour(quando) < NOEMI_SOGLIA_STESSO_GIORNO) {
    const prima = giornoRoma(new Date(quando.getTime() - 24 * 3600_000));
    return ` Digli QUANDO lo chiama: la call è ${call}, quindi Noemi chiama il pomeriggio del giorno prima, cioè ${prima} nel pomeriggio, non la mattina della call. Scrivilo così, col giorno e il numero, e digli di tenere il telefono a portata già da ${prima} pomeriggio.`;
  }
  return ` Digli QUANDO lo chiama: la call è ${call}, quindi Noemi chiama lo stesso giorno, ${giornoRoma(quando)}, qualche ora prima. Scrivilo col giorno e il numero, dagli la finestra e mai un orario al minuto.`;
}

function formatOra(d: Date): string {
  return new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit' }).format(d);
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
