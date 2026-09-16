import { romeDayKey, formatRomeDateTime } from './rome-time';
import { giorniLancio } from './lancio-scelta';
import { haCongedo } from './lancio-fase';

/**
 * Restituzione al pool (spec §5.8, §4.6; riconciliazione "buco di spec"): dal giorno
 * dopo dopodomani (8/10 per l'evento del 5) chi non ha mai risposto, chi tace 48 ore dopo
 * il follow-up e chi il follow-up non l'ha mai ricevuto tornano al CRM come
 * `NON_RISPOSTO` con una nota fissa; il CRM li rimette nel pool di /import. Qui la sola
 * decisione; il cron `/api/cron/lancio-restituzioni` la applica.
 */

export const RESTITUZIONE_ATTESA_MS = 48 * 3600_000;

export type MotivoRestituzione = 'mai_risposto' | 'silenzio_dopo_followup' | 'followup_non_inviato';

/** Note al CRM: `motivoRestituzioneDaNota` (CRM) le riconosce cosi'. Non cambiare una virgola. */
export const NOTA_RESTITUZIONE: Record<MotivoRestituzione, string> = {
  mai_risposto: 'Lancio: mai risposto',
  silenzio_dopo_followup: 'Lancio: silenzio dopo il follow-up',
  followup_non_inviato: 'Lancio: follow-up non inviato',
};

export const FASI_RESTITUIBILI = ['attesa', 'posto_bloccato', 'link_inviato', 'followup_inviato'] as const;
const FASI_PRIMA_DEL_FOLLOWUP: readonly string[] = ['attesa', 'posto_bloccato', 'link_inviato'];

/** Dal giorno dopo dopodomani (regola a data, derivata dall'evento: nessuno stato). */
export function restituzioniAttive(now: Date, eventoAt: Date): boolean {
  return romeDayKey(now) > giorniLancio(eventoAt).dopodomani;
}

/**
 * Le date del cron in `vercel.json` sono scritte a mano (8-31 ottobre, 1-15 novembre) e
 * NON si derivano dall'evento: Vercel non legge i nostri setting. Se qualcuno sposta
 * `lancio_evento_at` senza toccare `vercel.json`, le restituzioni diventano attive in un
 * giorno in cui il cron non gira piu' — e non succede niente, in silenzio. Questa e' la
 * finestra vera del cron, in UTC come i cron di Vercel.
 */
export function dentroFinestraCron(now: Date): boolean {
  const mese = now.getUTCMonth() + 1;
  const giorno = now.getUTCDate();
  return (mese === 10 && giorno >= 8) || (mese === 11 && giorno <= 15);
}

/** Le restituzioni sarebbero attive ma il calendario del cron non le copre: bandierina
 *  nel riepilogo del run, cosi' un evento spostato si vede nei log invece di sparire. */
export function fuoriFinestraCron(now: Date, eventoAt: Date): boolean {
  return restituzioniAttive(now, eventoAt) && !dentroFinestraCron(now);
}

export type MotivoNiente = 'senza_crm' | 'esito_presente' | 'fase' | 'ancora_ignota' | 'incoerente' | 'attesa_48h' | 'ha_risposto';
export type DecisioneRestituzione =
  | { kind: 'restituisci'; motivo: MotivoRestituzione }
  | { kind: 'ritenta_scarto' }
  | { kind: 'niente'; motivo: MotivoNiente };

export type CandidataRestituzione = {
  lancio_fase: string | null;
  lancio_followup_inviato_at: string | null;
  last_inbound_at: string | null;
  crm_lead_id: string | null;
  /** Un esito gia' dato (di questo lancio o del giro precedente sulla stessa chat) non si sovrascrive. */
  bot_outcome: string | null;
  lancio_info: unknown;
  /** L'ancora del lancio (`ancoraLancio`, lib/lancio-followup.ts): null = ignota. */
  ancora: string | null;
  /** `haInteragito(rows, ancora)` calcolato dal cron sulle righe `messages`. */
  haInteragito: boolean;
};

export function decideRestituzione(c: CandidataRestituzione, nowMs: number): DecisioneRestituzione {
  if (!c.crm_lead_id) return { kind: 'niente', motivo: 'senza_crm' };
  // C2: il congedo e' uscito ma la fase non e' terminale — il CRM aveva rifiutato lo scarto
  // (o era giu'). Non e' una restituzione: e' uno scarto da ritentare, in qualunque fase.
  if (haCongedo(c.lancio_info) && c.lancio_fase !== 'chiuso' && c.lancio_fase !== 'restituito') return { kind: 'ritenta_scarto' };
  if (!c.lancio_fase || !(FASI_RESTITUIBILI as readonly string[]).includes(c.lancio_fase)) return { kind: 'niente', motivo: 'fase' };
  if (c.bot_outcome !== null) return { kind: 'niente', motivo: 'esito_presente' };
  if (!c.ancora) return { kind: 'niente', motivo: 'ancora_ignota' };

  const timbro = c.lancio_followup_inviato_at;
  if (FASI_PRIMA_DEL_FOLLOWUP.includes(c.lancio_fase)) {
    if (!c.haInteragito) return { kind: 'restituisci', motivo: 'mai_risposto' };
    // Ha interagito e il follow-up non e' mai partito (cap per tutta la finestra, SID
    // mancante, freno, lancio spento): torna al pool lo stesso, con la sua nota (R2).
    if (!timbro) return { kind: 'restituisci', motivo: 'followup_non_inviato' };
    // Timbro presente con fase indietro = esito incerto del follow-up: si tratta come inviato.
  }
  if (!timbro) return { kind: 'niente', motivo: 'incoerente' };
  const fuMs = Date.parse(timbro);
  if (Number.isNaN(fuMs)) return { kind: 'niente', motivo: 'incoerente' };
  if (nowMs < fuMs + RESTITUZIONE_ATTESA_MS) return { kind: 'niente', motivo: 'attesa_48h' };
  const inboundMs = c.last_inbound_at ? Date.parse(c.last_inbound_at) : NaN;
  if (!Number.isNaN(inboundMs) && inboundMs > fuMs) return { kind: 'niente', motivo: 'ha_risposto' };
  return { kind: 'restituisci', motivo: 'silenzio_dopo_followup' };
}

export type EsitoCrmRestituzione = 'restituito' | 'gia_restituito' | 'rifiutato_dal_crm' | 'non_confermato' | 'terminale' | 'ritenta';

/** Un rifiuto del CRM (lead non piu' del bot / inesistente) e' una decisione presa: si
 *  segna `restituito` per non ritentare ogni ora. */
const STATUS_TERMINALI: readonly number[] = [403, 404];

/**
 * Cosa ha detto davvero il CRM (ruling 4 della seconda passata). Il ramo lancio di
 * `/api/bot/outcome` risponde SEMPRE 200 sui lead del lancio, anche quando NON li ha
 * rimessi nel pool (`returnedToPool: false, skipped: <motivo>`): un lead con una call in
 * agenda (`locked_appointment`) o che ha scelto (`scelta_fatta`). Leggere solo lo status
 * lo marcherebbe `restituito` per sempre. Conferma = `returnedToPool: true` o il
 * doppione `already_returned`; un corpo illeggibile non e' una conferma.
 */
export function esitoRestituzioneDalCrm(res: {
  sent: boolean;
  status?: number;
  corpo?: Record<string, unknown>;
}): { esito: EsitoCrmRestituzione; skipped: string | null } {
  if (res.sent) {
    const skipped = typeof res.corpo?.skipped === 'string' ? res.corpo.skipped : null;
    if (res.corpo?.returnedToPool === true) return { esito: 'restituito', skipped: null };
    if (skipped === 'already_returned') return { esito: 'gia_restituito', skipped };
    if (res.corpo?.returnedToPool === false) return { esito: 'rifiutato_dal_crm', skipped };
    return { esito: 'non_confermato', skipped: null };
  }
  if (res.status !== undefined && STATUS_TERMINALI.includes(res.status)) return { esito: 'terminale', skipped: null };
  return { esito: 'ritenta', skipped: null };
}

/** Nota al CRM quando un lead gia' restituito riscrive (ruling C8): chi lo ha in mano
 *  deve sapere che ha scritto e che il bot non gli risponde. */
export function notaInboundDopoRestituzione(testo: string, quandoIso: string): string {
  const parole = testo.trim().slice(0, 300);
  return `Lancio Web Dev AI: il lead ha riscritto su WhatsApp dopo il ritorno nel pool (${formatRomeDateTime(quandoIso)}): "${parole}". Il bot non risponde: il lead e' di chi lo ha in carico.`;
}
