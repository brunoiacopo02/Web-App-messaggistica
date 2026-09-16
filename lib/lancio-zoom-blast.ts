import { romeDayKey, romeHour, romeMinute } from './rome-time';
import { haCongedo } from './lancio-fase';

// Blast del link Zoom (spec §5.3, delibera del PO 16/09): la logica senza rete e senza
// database. La finestra si deriva dall'ora dell'evento e non da numeri scritti qui, così
// la prova generale del B6 sposta l'evento e la finestra la segue.

/** Quante conversazioni per run, salvo `LANCIO_BATCH_MAX`. Delibera 16/09: 200 (non 400)
 *  ogni 5' per stare comodi dentro i 300s di Vercel. */
export const LANCIO_BATCH_MAX_DEFAULT = 200;
/** Stessa concorrenza di `send-batch`: Twilio regge, Meta conta i template, non i secondi. */
export const LANCIO_BLAST_CONCURRENCY = 5;

const DA_MINUTI_PRIMA = 90;
const A_MINUTI_PRIMA = 15;

const minutiDelGiorno = (d: Date) => romeHour(d) * 60 + romeMinute(d);

/**
 * Siamo nella fascia del blast? Stesso giorno italiano dell'evento e fra 90 e 15 minuti
 * prima dell'inizio (21:00 ⇒ 19:30-20:45 inclusi). Il cron gira a maglia larga in UTC
 * (ogni 5 minuti nelle ore 17-18) e decide qui, in ora di Roma, come `gdo-video-followups`.
 */
export function inFinestraBlast(now: Date, eventoAt: Date): boolean {
  if (romeDayKey(now) !== romeDayKey(eventoAt)) return false;
  const m = minutiDelGiorno(now);
  const evento = minutiDelGiorno(eventoAt);
  return m >= evento - DA_MINUTI_PRIMA && m <= evento - A_MINUTI_PRIMA;
}

/**
 * La finestra del blast e' passata: stesso giorno italiano dell'evento e oltre il minuto
 * di chiusura (evento meno 15'). Non e' il contrario di `inFinestraBlast` — prima delle
 * 19:30 la finestra non e' chiusa, deve ancora aprirsi — e serve al cron per scrivere, a
 * serata finita, quanti iscritti sono rimasti senza link: l'unico momento in cui quel
 * numero e' definitivo.
 */
export function finestraBlastChiusa(now: Date, eventoAt: Date): boolean {
  if (romeDayKey(now) !== romeDayKey(eventoAt)) return false;
  return minutiDelGiorno(now) > minutiDelGiorno(eventoAt) - A_MINUTI_PRIMA;
}

/** L'ID riunione come lo legge il lead ("898 4522 3337"): sono le cifre dopo `/j/`. */
export function zoomMeetingId(link: string): string | null {
  const m = /\/j\/(\d{9,11})(?:[/?#]|$)/.exec(link);
  if (!m) return null;
  const cifre = m[1];
  return `${cifre.slice(0, 3)} ${cifre.slice(3, 7)} ${cifre.slice(7)}`.trim();
}

/** Il testo del template "Link Zoom" (spec §7.2): corpo salvato a DB se Twilio non lo dà. */
export function zoomBlastBody(nome: string, link: string): string {
  return `Ciao ${nome}, ci siamo! Alle 21:00 inizia la live Web Developer AI. Questo è il tuo link per collegarti: ${link} — ti consigliamo di entrare qualche minuto prima. Se hai problemi a collegarti scrivimi qui.`;
}

/** Tetto del lotto da env: intero positivo, altrimenti il default (200, delibera 16/09). */
export function batchMax(raw: string | undefined): number {
  const n = parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : LANCIO_BATCH_MAX_DEFAULT;
}

/**
 * Perimetro del blast (setting `lancio_blast_perimetro`, delibera 16/09): 'tutti' manda
 * a chiunque abbia bloccato il posto o sia ancora in attesa; 'risposto' lo restringe a
 * chi ha scritto almeno un inbound (evita di riscaldare un numero mai risposto).
 * Qualunque valore diverso da 'risposto' — mancante, vuoto, sporco — resta 'tutti': nel
 * dubbio si manda il link, non si lascia fuori un iscritto.
 */
export type PerimetroBlast = 'tutti' | 'risposto';
export const LANCIO_BLAST_PERIMETRO_DEFAULT: PerimetroBlast = 'tutti';

export function parsePerimetroBlast(raw: unknown): PerimetroBlast {
  return raw === 'risposto' ? 'risposto' : 'tutti';
}

export type CandidatoBlast = {
  lancio_fase: string | null;
  lancio_info?: unknown;
  last_inbound_at?: string | null;
};

/**
 * Chi puo' ricevere il blast: solo chi non ha gia' il link (fase `attesa` o
 * `posto_bloccato`), mai chi si e' congedato (`lancio_info.congedo_at`, qualunque fase —
 * il congedo vince sempre), e — col perimetro 'risposto' — solo chi ha almeno un inbound.
 */
export function idoneoAlBlast(c: CandidatoBlast, perimetro: PerimetroBlast): boolean {
  if (haCongedo(c.lancio_info)) return false;
  if (c.lancio_fase !== 'posto_bloccato' && c.lancio_fase !== 'attesa') return false;
  if (perimetro === 'risposto' && !c.last_inbound_at) return false;
  return true;
}

/**
 * Ordina per intenzione: prima chi ha gia' bloccato il posto (il caso piu' caldo), poi
 * chi e' ancora in attesa ma ha scritto almeno un inbound, infine chi e' in attesa e
 * silenzioso. Sort stabile: a parita' di gruppo l'ordine di arrivo non cambia, cosi' il
 * blast non "salta" candidati fra un run e l'altro per un riordino spurio.
 */
export function ordinaCandidatiBlast<T extends CandidatoBlast>(candidati: readonly T[]): T[] {
  const peso = (c: CandidatoBlast): number => {
    if (c.lancio_fase === 'posto_bloccato') return 0;
    return c.last_inbound_at ? 1 : 2;
  };
  return candidati
    .map((c, i) => ({ c, i }))
    .sort((a, b) => peso(a.c) - peso(b.c) || a.i - b.i)
    .map(({ c }) => c);
}

/** Codici errore Twilio che segnalano un problema col numero mittente, non col singolo
 *  destinatario (spec §11): qualunque presenza ferma il blast, a prescindere dal conteggio. */
export const CODICI_FRENO_TWILIO: readonly number[] = [63018, 63049, 63051];

export type EsitoFreno = {
  /**
   * Invii TENTATI finora nel run: riusciti + falliti + fermati dal frequency cap. E' il
   * denominatore del tasso, e sono i tentativi, non i successi. Un run che sbatte su 30
   * numeri morti ha fatto 30 chiamate a Twilio e Meta le ha viste tutte e 30: contando
   * solo i riusciti il tasso di fallimento sarebbe 30/0, cioe' nessun freno proprio nel
   * caso peggiore.
   */
  tentati: number;
  /** Quanti di quei tentativi non sono arrivati (falliti + cap). */
  falliti: number;
  /** I codici Twilio visti nel run, nell'ordine in cui sono arrivati. */
  codici: readonly (number | string)[];
};

/**
 * Freno automatico del blast (usato dal cron del Task 3): si ferma se il tasso di
 * fallimento supera il 10% (con almeno 20 tentativi, altrimenti un run piccolo fermerebbe
 * tutto per due sfortune) oppure se compare uno dei codici Twilio che segnalano un
 * problema sul mittente stesso.
 */
export function decideFreno(e: EsitoFreno): 'continua' | 'ferma' {
  const codiceGrave = e.codici.some((cod) => CODICI_FRENO_TWILIO.includes(Number(cod)));
  if (codiceGrave) return 'ferma';
  if (e.tentati >= 20 && e.falliti / e.tentati > 0.1) return 'ferma';
  return 'continua';
}
