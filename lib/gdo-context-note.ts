import { GDO_CONTEXT_NOTE } from './mario';
import { giornoRoma, oraRoma, romeDayKey, romeHour } from './rome-time';

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
  /** In questo turno esce il recap GDO, che spiega già Noemi. */
  recapInUscita?: boolean;
  /** Adesso: serve a capire se la call del mattino è domani (si chiama la mattina stessa) o
   *  più in là (si chiama già il giorno prima). Default: l'ora vera. */
  now?: Date;
  /** Nota del passo di riscaldamento da fare in questo turno (lib/gdo-warmup.ts). */
  notaRiscaldamento?: string | null;
}

/**
 * Dal 27/10/2026 (PO 24/10) Noemi attacca alle 9 e le call del mattino (9-14) si chiamano la
 * mattina stessa. Il giorno prima le Conferme chiamano solo le call del mattino fissate con
 * anticipo (e sempre quelle delle 9, che la mattina stessa non farebbero in tempo). Dalle 15 in
 * poi niente cambia: stesso giorno, qualche ora prima.
 */
const NOEMI_SOGLIA_POMERIGGIO = 15;
const NOEMI_ATTACCA = 9;

/** Giorni di calendario (Roma) da `da` ad `a`. */
function giorniTra(da: Date, a: Date): number {
  const utc = (d: Date) => Date.parse(`${romeDayKey(d)}T12:00:00Z`);
  return Math.round((utc(a) - utc(da)) / 86_400_000);
}

/** Il giorno lavorativo prima della call: la domenica non si lavora, prima del lunedì c'è il sabato. */
function giornoPrima(quando: Date): string {
  const d = new Date(Date.parse(`${romeDayKey(quando)}T12:00:00Z`) - 86_400_000);
  if (d.getUTCDay() === 0) d.setUTCDate(d.getUTCDate() - 1);
  return giornoRoma(d);
}

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

/** La riga su quando chiama Noemi, vuota se non sappiamo quando è la call. Il giorno è
 *  scritto per intero col numero: "il giorno prima" da solo, a chi legge di fretta, non dice
 *  niente. */
export function quandoChiamaNoemi(quando: Date | null, now: Date = new Date()): string {
  if (!quando) return '';
  const giorno = giornoRoma(quando);
  const call = `${giorno} alle ${oraRoma(quando)}`;
  const ora = romeHour(quando);
  if (ora <= NOEMI_ATTACCA) {
    const prima = giornoPrima(quando);
    return ` Digli QUANDO lo chiama: la call è ${call}, quindi Noemi lo chiama il giorno prima, ${prima}, perché alle 9 attacca proprio a lavorare e prima della call non farebbe in tempo. Scrivilo così, col giorno e il numero, e digli di tenere il telefono a portata già da ${prima}.`;
  }
  if (ora < NOEMI_SOGLIA_POMERIGGIO) {
    if (giorniTra(now, quando) <= 1) {
      return ` Digli QUANDO lo chiama: la call è ${call}, quindi Noemi lo chiama la mattina stessa, ${giorno} dalle 9, prima della videochiamata. Scrivilo col giorno e il numero, dagli la finestra e mai un orario al minuto.`;
    }
    const prima = giornoPrima(quando);
    return ` Digli QUANDO lo chiama: la call è ${call}, quindi Noemi lo sente già il giorno prima, ${prima}, e se non lo trova lo richiama la mattina stessa, ${giorno} dalle 9. Scrivilo così, col giorno e il numero, e digli di tenere il telefono a portata già da ${prima}.`;
  }
  return ` Digli QUANDO lo chiama: la call è ${call}, quindi Noemi chiama lo stesso giorno, ${giornoRoma(quando)}, qualche ora prima. Scrivilo col giorno e il numero, dagli la finestra e mai un orario al minuto.`;
}

/**
 * Noemi si spiega quando il lead si fa vivo davvero: conferma di aver visto il video,
 * oppure risponde dopo che gli è arrivato almeno un sollecito. E una volta sola.
 * Nel turno del recap no: Noemi la porta il recap, il modello la ripeterebbe.
 */
export function serveNoemi(i: GdoNoteInput): boolean {
  if (i.gdoNoemiRemindedAt || i.recapInUscita) return false;
  return i.videoAppenaConfermato || i.followupsSent > 0;
}

/** La nota completa da passare a `generateMarioReply({ contextNote })`. */
export function gdoContextNote(i: GdoNoteInput): string {
  const parti = [i.videoInUscita ? GDO_CONTEXT_NOTE_VIDEO_IN_USCITA : GDO_CONTEXT_NOTE];
  // Il promemoria "ricordagli il video" non ha senso nel turno in cui il video esce.
  if (!i.videoInUscita && i.gdoVideoSentAt && !i.gdoVideoWatchedAt) parti.push(NOTA_VIDEO);
  if (serveNoemi(i)) {
    parti.push(NOTA_NOEMI + quandoChiamaNoemi(oraAppuntamento(i.botScheduledAt, i.gdoAppuntamentoAt), i.now));
  }
  // Il riscaldamento va in coda: prima il contesto e i promemoria, poi la domanda del passo.
  if (i.notaRiscaldamento) parti.push(i.notaRiscaldamento);
  return parti.join('\n\n');
}
