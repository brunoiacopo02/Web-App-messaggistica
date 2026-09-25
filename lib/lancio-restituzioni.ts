import { romeDayKey, romeHour, formatRomeDateTime } from './rome-time';
import { giorniLancio } from './lancio-scelta';
import { haCongedo } from './lancio-fase';

/**
 * Restituzione al pool (spec §5.8, §4.6; riconciliazione "buco di spec"): da dopodomani
 * (7/10 per l'evento del 5) chi non ha mai risposto, chi ha la chat ferma da piu' di 24
 * ore e chi il follow-up non l'ha mai ricevuto tornano al CRM come `NON_RISPOSTO` con
 * una nota fissa; il CRM li rimette nel pool di /import. Qui la sola decisione; il cron
 * `/api/cron/lancio-restituzioni` la applica.
 *
 * Decisione PO del 19/09: il 6 ottobre e' tutto del bot (risposte e follow-up), dal 7 si
 * restituisce, cosi' i GDO possono chiamare quei lead gia' il 7. Prima era l'8.
 */

/**
 * Quanto deve stare ferma una chat prima di tornare al pool: 24 ore (era 48), misurate
 * sull'ULTIMO messaggio in qualunque direzione — il follow-up che abbiamo mandato, o la
 * risposta del lead se e' arrivata dopo. Chi e' in conversazione viva resta al bot e
 * torna al pool piu' avanti, man mano che la chat si spegne.
 */
export const RESTITUZIONE_ATTESA_MS = 24 * 3600_000;

export type MotivoRestituzione = 'mai_risposto' | 'silenzio_dopo_followup' | 'followup_non_inviato';

/** Note al CRM: `motivoRestituzioneDaNota` (CRM) le riconosce cosi'. Non cambiare una virgola. */
export const NOTA_RESTITUZIONE: Record<MotivoRestituzione, string> = {
  mai_risposto: 'Lancio: mai risposto',
  silenzio_dopo_followup: 'Lancio: silenzio dopo il follow-up',
  followup_non_inviato: 'Lancio: follow-up non inviato',
};

/**
 * Le fasi che tornano al pool. `scelta_fatta` resta fuori: quel lead ha scelto, ce l'ha
 * in mano il CRM. `post_pitch` invece ci sta — chi ha premuto il pulsante e poi si e'
 * fermato non ha nessun altro che lo guardi: senza questa riga restava del bot per
 * sempre, senza follow-up (fino al fix del 17/09) e senza restituzione.
 */
export const FASI_RESTITUIBILI = ['attesa', 'posto_bloccato', 'link_inviato', 'post_pitch', 'followup_inviato'] as const;
/** Le fasi in cui il follow-up non e' (ancora) partito: da qui valgono `mai_risposto` e
 *  `followup_non_inviato`. `post_pitch` compreso, per la stessa ragione. */
const FASI_PRIMA_DEL_FOLLOWUP: readonly string[] = ['attesa', 'posto_bloccato', 'link_inviato', 'post_pitch'];

/**
 * Tetto del lotto delle restituzioni (env `LANCIO_RESTITUZIONI_MAX`). E' suo e non quello
 * del blast (`LANCIO_BATCH_MAX`): qui non parte nessun messaggio WhatsApp — si chiama il
 * CRM e si scrive una fase — e il cron gira una volta l'ora, quindi e' un tetto ORARIO.
 *
 * Decisione PO del 25/09: le restituzioni arrivano a scaglioni graduali, non tutte
 * insieme. 100 l'ora dentro la fascia `inFasciaRestituzioni` (10 run al giorno) fanno
 * ~1.000 lead al giorno: i ~2.000 del lancio tornano al pool in 2-3 giorni lavorativi,
 * invece di 500 alla volta anche di notte.
 */
export const RESTITUZIONI_MAX_DEFAULT = 100;

/**
 * La fascia in cui si restituisce, in ora di Roma (decisione PO del 25/09: mai di notte).
 * Da lunedi' a sabato, run delle 09:00 fino a quello delle 18:00 compreso; domenica mai.
 *
 * Perche' questa: i GDO lavorano i feriali 13:30-20:00 e il sabato 10:00-16:30 (turno
 * dichiarato dal PO, memoria "produttivita' GDO"), e il pool `LANCIO_WEBDEV_2026` di
 * `/import` lo assegna un admin in orario d'ufficio. Partendo alle 09:00 il pool e' gia'
 * pieno per l'inizio del turno, e l'ultimo scaglione (18:00) lascia ancora due ore di
 * turno; la domenica non c'e' nessuno che li chiami. Il cron di `vercel.json` gira ogni ora
 * 07-17 UTC, che copre 09-18 di Roma sia con l'ora legale (fino al 25/10) sia senza: la
 * fascia vera la decide questa funzione.
 */
export const FASCIA_RESTITUZIONI = { daOra: 9, aOra: 18 } as const;

export function inFasciaRestituzioni(now: Date): boolean {
  // 0 = domenica. Il giorno della settimana italiano, dal giorno di calendario di Roma.
  const giorno = new Date(`${romeDayKey(now)}T12:00:00Z`).getUTCDay();
  if (giorno === 0) return false;
  const ora = romeHour(now);
  return ora >= FASCIA_RESTITUZIONI.daOra && ora <= FASCIA_RESTITUZIONI.aOra;
}

/**
 * Da dopodomani compreso (regola a data, derivata dall'evento: nessuno stato). Per
 * l'evento del 5/10: il 6 e' del bot, il 7 si restituisce.
 */
export function restituzioniAttive(now: Date, eventoAt: Date): boolean {
  return romeDayKey(now) >= giorniLancio(eventoAt).dopodomani;
}

/**
 * Le date del cron in `vercel.json` sono scritte a mano (7-31 ottobre, 1-15 novembre) e
 * NON si derivano dall'evento: Vercel non legge i nostri setting. Se qualcuno sposta
 * `lancio_evento_at` senza toccare `vercel.json`, le restituzioni diventano attive in un
 * giorno in cui il cron non gira piu' — e non succede niente, in silenzio. Questa e' la
 * finestra vera del cron, in UTC come i cron di Vercel.
 */
export function dentroFinestraCron(now: Date): boolean {
  const mese = now.getUTCMonth() + 1;
  const giorno = now.getUTCDate();
  return (mese === 10 && giorno >= 7) || (mese === 11 && giorno <= 15);
}

/** Le restituzioni sarebbero attive ma il calendario del cron non le copre: bandierina
 *  nel riepilogo del run, cosi' un evento spostato si vede nei log invece di sparire. */
export function fuoriFinestraCron(now: Date, eventoAt: Date): boolean {
  return restituzioniAttive(now, eventoAt) && !dentroFinestraCron(now);
}

export type MotivoNiente = 'senza_crm' | 'esito_presente' | 'fase' | 'ancora_ignota' | 'incoerente' | 'attesa_24h' | 'ha_risposto';
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
  // L'attesa si misura sull'ULTIMO messaggio, in qualunque direzione (regola PO del
  // 19/09): il follow-up che abbiamo mandato, o la risposta del lead se e' arrivata dopo.
  // Una risposta fresca tiene il lead al bot (`ha_risposto`); quando anche quella chat si
  // spegne per 24 ore torna al pool "man mano", invece di restare al bot per sempre.
  const inboundMs = c.last_inbound_at ? Date.parse(c.last_inbound_at) : NaN;
  const haRisposto = !Number.isNaN(inboundMs) && inboundMs > fuMs;
  const ultimoMs = haRisposto ? inboundMs : fuMs;
  if (nowMs < ultimoMs + RESTITUZIONE_ATTESA_MS) return { kind: 'niente', motivo: haRisposto ? 'ha_risposto' : 'attesa_24h' };
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
