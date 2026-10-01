import { haCongedo } from './lancio-fase';
import { dimensioneLotto } from './lancio-inizio';

// Il promemoria della mattina della live (PO 30/09/2026): `fenice_lancio_promemoria_v1`,
// UTILITY, {{1}} nome. "Stasera alle 21:00 si tiene la live... il link ti arriva qui alle
// 20:00". Parte SOLO a chi ha bloccato il posto (`posto_bloccato`): chi ha risposto ma non
// ha confermato, e i silenziosi, non lo ricevono — la mattina della live sono gia' tre
// messaggi in un giorno per chi lo riceve (promemoria, link, "sta iniziando") e il
// numero storico e' MEDIUM.
//
// Spalmato dalle 10:00 alle 12:00 del giorno dell'evento, un lotto ogni 5 minuti: la
// finestra si deriva da `lancio_evento_at` (21:00 ⇒ 10:00-12:00), come per l'inizio.
// Senza logica di rete e di database: il cron `lancio-promemoria` usa il motore del blast.

/** Da quante ore prima dell'evento si apre la finestra (21:00 ⇒ 10:00). */
export const PROMEMORIA_DA_ORE_PRIMA = 11;
/** A quante ore prima dell'evento si chiude (21:00 ⇒ 12:00). */
export const PROMEMORIA_A_ORE_PRIMA = 9;
/** Il passo del cron in vercel.json (`*\/5`). */
export const PROMEMORIA_PASSO_CRON_MS = 5 * 60_000;
/** Tolleranza sugli estremi: il cron di Vercel parte qualche secondo dopo l'ora scritta. */
export const PROMEMORIA_TOLLERANZA_MS = 2 * 60_000;
/** Tetto per run, salvo `LANCIO_PROMEMORIA_BATCH_MAX`: come il blast Zoom. */
export const LANCIO_PROMEMORIA_BATCH_MAX_DEFAULT = 300;

const ORA = 3600_000;
const inizioFinestraMs = (evento: Date) => evento.getTime() - PROMEMORIA_DA_ORE_PRIMA * ORA;
const fineFinestraMs = (evento: Date) => evento.getTime() - PROMEMORIA_A_ORE_PRIMA * ORA;

/** Siamo dentro 10:00-12:00 del giorno dell'evento (con la tolleranza del cron)? */
export function inFinestraPromemoria(now: Date, evento: Date): boolean {
  const t = now.getTime();
  return t >= inizioFinestraMs(evento) - PROMEMORIA_TOLLERANZA_MS && t <= fineFinestraMs(evento) + PROMEMORIA_TOLLERANZA_MS;
}

/** La finestra e' passata: "quanti non l'hanno ricevuto" diventa definitivo. */
export function finestraPromemoriaChiusa(now: Date, evento: Date): boolean {
  return now.getTime() > fineFinestraMs(evento) + PROMEMORIA_TOLLERANZA_MS;
}

/** Quanti run restano, questo compreso (10:00 ⇒ 25). Mai meno di 1. */
export function runRimastiPromemoria(now: Date, evento: Date): number {
  const restano = fineFinestraMs(evento) - now.getTime() + PROMEMORIA_TOLLERANZA_MS;
  if (restano < 0) return 1;
  return Math.floor(restano / PROMEMORIA_PASSO_CRON_MS) + 1;
}

export type CandidatoPromemoria = {
  lancio_slug?: string | null;
  lancio_fase: string | null;
  lancio_info?: unknown;
  lancio_promemoria_inviato_at?: string | null;
};

/** Chat del lancio, posto bloccato, mai congedata, promemoria non ancora partito. */
export function idoneoAlPromemoria(c: CandidatoPromemoria): boolean {
  if (c.lancio_slug === null) return false;
  if (c.lancio_promemoria_inviato_at) return false;
  if (haCongedo(c.lancio_info)) return false;
  return c.lancio_fase === 'posto_bloccato';
}

export type SceltaLottoPromemoria<T> = { rimanenti: T[]; run: number; quota: number; lotto: T[] };

/** La scelta di un run. `forza` (prova con `?solo=`) prende tutto dentro al tetto. */
export function scegliLottoPromemoria<T extends CandidatoPromemoria>(
  candidati: readonly T[],
  now: Date,
  evento: Date,
  max: number,
  forza = false,
): SceltaLottoPromemoria<T> {
  const rimanenti = candidati.filter(idoneoAlPromemoria);
  const run = forza ? 1 : runRimastiPromemoria(now, evento);
  const quota = forza ? Math.min(max, rimanenti.length) : dimensioneLotto(rimanenti.length, run, max);
  return { rimanenti, run, quota, lotto: rimanenti.slice(0, quota) };
}

/** Il testo di `fenice_lancio_promemoria_v1`: il corpo salvato a DB se Twilio non lo da'. */
export function promemoriaBody(nome: string): string {
  return (
    `Promemoria evento: ciao ${nome}, stasera alle 21:00 si tiene la live Web Developer AI a cui ti sei ` +
    'iscritto. Il link per accedere ti arriverà qui alle 20:00. Se hai domande sul collegamento, rispondi a questo messaggio.'
  );
}
