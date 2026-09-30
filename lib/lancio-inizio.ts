import { haCongedo, type LancioFase } from './lancio-fase';

// "La live sta iniziando" (decisione PO 5 del 25/09/2026): la logica senza rete e senza
// database del cron `lancio-inizio`. Il messaggio (`fenice_lancio_inizio_v1`, UTILITY)
// parte la sera dell'evento fra 30 minuti prima e 30 minuti dopo l'inizio, SOLO a chi ha
// scritto almeno una volta dopo il benvenuto e non si e' congedato, spalmato su tutti i
// run della finestra invece che tutto al primo giro.
//
// La finestra si deriva da `lancio_evento_at`, non da orari scritti qui: la prova
// generale sposta l'evento e la finestra la segue (come `inFinestraBlast`).

/** Da quanti minuti prima dell'inizio si manda (21:00 ⇒ 20:30). */
export const INIZIO_DA_MINUTI_PRIMA = 30;
/** Fino a quanti minuti dopo l'inizio si manda (21:00 ⇒ 21:30). */
export const INIZIO_A_MINUTI_DOPO = 30;
/** Il passo del cron in vercel.json (`*\/5`): serve a contare i run che restano. */
export const INIZIO_PASSO_CRON_MS = 5 * 60_000;
/**
 * Tolleranza sugli estremi: Vercel fa partire il cron qualche secondo (a volte un
 * minuto) dopo l'ora scritta. Senza, il run delle 21:30 che parte alle 21:30:20 sarebbe
 * "fuori finestra" — proprio l'ultimo, quello che deve svuotare la coda.
 */
export const INIZIO_TOLLERANZA_MS = 2 * 60_000;
/** Tetto per run, salvo `LANCIO_INIZIO_BATCH_MAX`: come il blast Zoom (delibera 25/09). */
export const LANCIO_INIZIO_BATCH_MAX_DEFAULT = 300;
/**
 * Chi ha appena ricevuto il link Zoom (il blast gira fino alle 20:45) non riceve un
 * secondo template a pochi minuti di distanza: lo riprende un run successivo, quando sono
 * passati almeno questi minuti. Resta nei rimanenti, quindi il lotto lo tiene in conto.
 */
export const INIZIO_DISTANZA_DAL_LINK_MS = 15 * 60_000;

/**
 * Le fasi a cui si manda. Elenco CHIUSO, non "tutto tranne i terminali": `chiuso`,
 * `restituito` e `scelta_fatta` sono fuori per decisione del PO; `post_pitch` vuol dire
 * che ha gia' premuto il pulsante della live (cioe' e' collegato), `followup_inviato` e'
 * del giorno dopo. Qualunque fase nuova resta fuori finche' qualcuno non la aggiunge qui.
 */
export const FASI_INIZIO: readonly LancioFase[] = ['attesa', 'posto_bloccato', 'link_inviato'];

const inizioFinestraMs = (evento: Date) => evento.getTime() - INIZIO_DA_MINUTI_PRIMA * 60_000;
const fineFinestraMs = (evento: Date) => evento.getTime() + INIZIO_A_MINUTI_DOPO * 60_000;

/** Siamo fra 30' prima e 30' dopo l'inizio (estremi inclusi, con la tolleranza del cron)? */
export function inFinestraInizio(now: Date, evento: Date): boolean {
  const t = now.getTime();
  return t >= inizioFinestraMs(evento) - INIZIO_TOLLERANZA_MS && t <= fineFinestraMs(evento) + INIZIO_TOLLERANZA_MS;
}

/** La finestra e' passata: e' il momento in cui "quanti non l'hanno ricevuto" e' definitivo. */
export function finestraInizioChiusa(now: Date, evento: Date): boolean {
  return now.getTime() > fineFinestraMs(evento) + INIZIO_TOLLERANZA_MS;
}

/**
 * Quanti run restano nella finestra, QUESTO compreso. 20:30 ⇒ 13 (20:30, 20:35, …,
 * 21:30), 21:30 ⇒ 1. La tolleranza assorbe il ritardo di partenza del cron: il run delle
 * 20:30 che parte alle 20:30:40 conta ancora 13 run, non 12. Mai meno di 1: l'ultimo run
 * deve poter svuotare la coda.
 */
export function runRimasti(now: Date, evento: Date): number {
  const restano = fineFinestraMs(evento) - now.getTime() + INIZIO_TOLLERANZA_MS;
  if (restano < 0) return 1;
  return Math.floor(restano / INIZIO_PASSO_CRON_MS) + 1;
}

/**
 * Quanti invii fa questo run: i rimanenti divisi per i run rimasti, per eccesso, dentro
 * al tetto. 390 destinatari alle 20:30 ⇒ 30 per run, uno ogni 5 minuti fino alle 21:30.
 * Per eccesso perche' per difetto l'ultimo run si troverebbe il resto di tutti gli
 * arrotondamenti; il tetto tiene il run dentro i 300s di Vercel anche se la coda e' enorme.
 */
export function dimensioneLotto(rimanenti: number, run: number, max: number): number {
  if (rimanenti <= 0) return 0;
  const quota = Math.ceil(rimanenti / Math.max(1, run));
  return Math.max(1, Math.min(max, quota));
}

export type CandidatoInizio = {
  lancio_slug?: string | null;
  lancio_fase: string | null;
  lancio_info?: unknown;
  lancio_benvenuto_at: string | null;
  last_inbound_at: string | null;
  lancio_link_inviato_at?: string | null;
  lancio_inizio_inviato_at?: string | null;
};

const ms = (iso: string | null | undefined): number => (iso ? Date.parse(iso) : NaN);

/**
 * Ha scritto almeno una volta DOPO il benvenuto? `last_inbound_at` e' l'ultimo messaggio
 * del lead (il webhook lo riscrive a ogni inbound): se e' successivo al benvenuto, almeno
 * un messaggio dopo il benvenuto c'e'. Senza benvenuto (chi e' entrato dal pulsante della
 * live, gia' collegato) o con date illeggibili: no.
 */
export function haScrittoDopoBenvenuto(c: Pick<CandidatoInizio, 'lancio_benvenuto_at' | 'last_inbound_at'>): boolean {
  const b = ms(c.lancio_benvenuto_at);
  const i = ms(c.last_inbound_at);
  if (Number.isNaN(b) || Number.isNaN(i)) return false;
  return i > b;
}

/**
 * Chi deve ricevere "la live sta iniziando" (prima o poi, in questa finestra): chat del
 * lancio, fase fra `FASI_INIZIO`, mai congedata (il congedo vince su tutto), ha scritto
 * dopo il benvenuto, e non l'ha ancora ricevuto.
 */
export function idoneoAllInizio(c: CandidatoInizio): boolean {
  if (c.lancio_slug === null) return false;
  if (c.lancio_inizio_inviato_at) return false;
  if (haCongedo(c.lancio_info)) return false;
  if (!(FASI_INIZIO as readonly string[]).includes(c.lancio_fase ?? '')) return false;
  return haScrittoDopoBenvenuto(c);
}

/** Il link Zoom e' partito da meno di 15 minuti: si rimanda a un run successivo. */
export function linkZoomTroppoRecente(c: Pick<CandidatoInizio, 'lancio_link_inviato_at'>, now: Date): boolean {
  const l = ms(c.lancio_link_inviato_at);
  if (Number.isNaN(l)) return false;
  return now.getTime() - l < INIZIO_DISTANZA_DAL_LINK_MS;
}

/**
 * Prima chi ha bloccato il posto (il caso piu' caldo), poi il resto. Sort stabile: a
 * parita' di gruppo resta l'ordine di lettura (per id), cosi' i run non si rincorrono.
 */
export function ordinaCandidatiInizio<T extends CandidatoInizio>(candidati: readonly T[]): T[] {
  const peso = (c: CandidatoInizio) => (c.lancio_fase === 'posto_bloccato' ? 0 : 1);
  return candidati
    .map((c, i) => ({ c, i }))
    .sort((a, b) => peso(a.c) - peso(b.c) || a.i - b.i)
    .map(({ c }) => c);
}

export type SceltaLotto<T> = {
  /** Tutti quelli che devono ancora riceverlo, rimandati compresi. */
  rimanenti: T[];
  /** Quelli mandabili adesso, in ordine (senza i rimandati per link Zoom recente). */
  pronti: T[];
  /** Quanti ne sono rimandati perche' il link Zoom e' appena partito. */
  rimandati: number;
  /** I run che restano, questo compreso. */
  run: number;
  /** La quota di questo run (prima del taglio ai pronti). */
  quota: number;
  /** Il lotto di questo run. */
  lotto: T[];
};

/**
 * La scelta completa di un run: idonei, ordine, rimandati e quota. `forza` (prova
 * generale con `?solo=`) salta la distribuzione: si prende tutto quello che e' pronto,
 * dentro al tetto.
 */
export function scegliLottoInizio<T extends CandidatoInizio>(
  candidati: readonly T[],
  now: Date,
  evento: Date,
  max: number,
  forza = false,
): SceltaLotto<T> {
  const rimanenti = ordinaCandidatiInizio(candidati.filter(idoneoAllInizio));
  const pronti = rimanenti.filter((c) => !linkZoomTroppoRecente(c, now));
  const run = forza ? 1 : runRimasti(now, evento);
  const quota = forza ? Math.min(max, pronti.length) : dimensioneLotto(rimanenti.length, run, max);
  return { rimanenti, pronti, rimandati: rimanenti.length - pronti.length, run, quota, lotto: pronti.slice(0, quota) };
}

/** Il testo di `fenice_lancio_inizio_v1`: il corpo salvato a DB se Twilio non lo da'. */
export function inizioBody(nome: string, link: string): string {
  return (
    `Promemoria evento: ciao ${nome}, la live Web Developer AI a cui ti sei iscritto è in programma ` +
    `oggi alle 21:00. Questo è il link per accedere: ${link} - se la live è già iniziata puoi entrare ` +
    'comunque dallo stesso link. Se hai difficoltà a collegarti, rispondi a questo messaggio.'
  );
}
