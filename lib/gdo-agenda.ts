// Invio agenda "per conto del GDO": il commerciale umano è al telefono col lead e
// clicca "Agenda" sul CRM. Il bot fa da postino — manda il link per prenotare e poi
// il video — ma il lead resta di proprietà del GDO. Qui le parti pure del flusso.
// Modulo client-safe: niente import da supabase/twilio.

import type { GdoVariant } from './bot-contract';
import { firstNameOf, templateName } from './name';

/** Form di prenotazione: lo stesso del bot, confermato dal CRM (28/07). */
export const BOOKING_LINK = 'https://form.jotform.com/240755654585063';

/** Video dell'offerta del mese: prevale su lavora/famiglia. */
export const BLACK_SUMMER_LINK = 'https://corso.feniceacademy.it/conferenza-black-summer';

const VIDEO_BY_PROFILO = {
  lavora: 'https://corso.feniceacademy.it/conferenza-bx',
  nonLavora: 'https://corso.feniceacademy.it/conferenza-axmsbn9r50',
  lavoraFamiglia: 'https://corso.feniceacademy.it/conferenza-dx',
  nonLavoraFamiglia: 'https://corso.feniceacademy.it/conferenza-ex',
} as const;

/** Il video da mandare al lead, dal profilo raccolto dal GDO al telefono. */
export function videoLinkForVariant(v: GdoVariant): string {
  if (v.offertaDelMese) return BLACK_SUMMER_LINK;
  if (v.haFamiglia) return v.lavora ? VIDEO_BY_PROFILO.lavoraFamiglia : VIDEO_BY_PROFILO.nonLavoraFamiglia;
  return v.lavora ? VIDEO_BY_PROFILO.lavora : VIDEO_BY_PROFILO.nonLavora;
}

/**
 * I tre stati che il GDO vede mentre è al telefono col lead. `inviato` non è un
 * fallimento (telefono spento/offline) ma nemmeno un successo: il lead non può ancora
 * usare l'agenda, e ritentare gli farebbe arrivare due messaggi appena torna online.
 */
export type SendAgendaEsito = 'consegnato' | 'inviato' | 'fallito';

export function esitoFromTwilioStatus(status: string | null | undefined): SendAgendaEsito {
  if (status === 'delivered' || status === 'read') return 'consegnato';
  if (status === 'failed' || status === 'undelivered') return 'fallito';
  return 'inviato';
}

/** Il CRM va in timeout a ~10s: oltre questa attesa si risponde comunque. */
export const DELIVERY_WAIT_MS = 8_000;
export const DELIVERY_POLL_MS = 500;

export type WaitForDeliveryDeps = {
  /** Stato Twilio corrente del messaggio (null se non ancora leggibile). */
  readStatus: () => Promise<string | null>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  waitMs?: number;
  pollMs?: number;
};

/**
 * Attende un esito definitivo (consegnato o fallito) fino a `waitMs`, poi si arrende
 * e risponde `inviato`. Una lettura che esplode non conta come fallimento: il
 * messaggio è già partito, l'unica cosa che non sappiamo è se è arrivato.
 */
export async function waitForDelivery(deps: WaitForDeliveryDeps): Promise<SendAgendaEsito> {
  const waitMs = deps.waitMs ?? DELIVERY_WAIT_MS;
  const pollMs = deps.pollMs ?? DELIVERY_POLL_MS;
  const start = deps.now();
  for (;;) {
    let status: string | null = null;
    try {
      status = await deps.readStatus();
    } catch {
      status = null; // rete/DB: riprova al giro dopo, non è un fallimento di consegna
    }
    const esito = esitoFromTwilioStatus(status);
    if (esito !== 'inviato') return esito;
    if (deps.now() - start + pollMs > waitMs) return 'inviato';
    await deps.sleep(pollMs);
  }
}

/** Finestra di deduplica concordata col CRM: stesso lead, stesso invio. */
export const DEDUP_WINDOW_MS = 15 * 60_000;

/**
 * Il GDO ha già mandato l'agenda a questo lead pochi minuti fa? Allora non si rimanda
 * e si risponde con l'esito precedente. Un fallimento vero invece non blocca: quello
 * è esattamente il caso in cui il GDO deve poter ritentare.
 */
export function isDedupHit(input: {
  lastAgendaAtMs: number | null;
  lastEsito: string | null;
  nowMs: number;
}): boolean {
  if (input.lastAgendaAtMs === null) return false;
  if (input.nowMs - input.lastAgendaAtMs >= DEDUP_WINDOW_MS) return false;
  return input.lastEsito !== 'fallito';
}

/**
 * Testo del template agenda (`fenice_agenda_gdo_v3`), replicato qui perché la
 * cronologia — l'inbox e il contesto che legge Mario — mostri il messaggio vero e non
 * un `[template]`. Deve restare identico al template approvato.
 * Il collega non si nomina mai: al lead basta sapere che siamo la stessa squadra.
 */
export function gdoAgendaText(name: string | null | undefined): string {
  return (
    `Ciao ${templateName(name)}, sono Marta di Fenice Academy 🙂 come ti ha detto il mio collega ` +
    `ti mando qui il link per scegliere giorno e ora della videocall 👉 ${BOOKING_LINK}\n` +
    `Rispondimi qui con un ok quando l'hai aperto, così ti mando il video da vedere prima della call`
  );
}

/**
 * Testo del video, inviato come testo libero dopo la prima risposta del lead.
 * Ricalca il template approvato `fenice_video_gdo_*` (stessa voce, stesso FATTO):
 * qui però la finestra 24h è aperta e il template non serve.
 */
export function gdoVideoText(name: string | null | undefined, link: string): string {
  const nome = firstNameOf(name);
  const saluto = nome ? `Ciao ${nome}, ` : 'Ciao, ';
  return (
    `${saluto}ecco il video da vedere prima del tuo appuntamento 👉 ${link}\n` +
    `Sono 20 minuti e servono per arrivare preparato alla call. Quando l'hai visto scrivimi FATTO qui, così lo segno`
  );
}
