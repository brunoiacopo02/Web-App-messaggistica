/**
 * Numero senza WhatsApp: il lead torna SUBITO al GDO (PO 10/11/2026).
 *
 * Il 10/11 sei lead BLACK FRIDAY hanno ricevuto l'apertura con errore Twilio 63024 (il
 * numero non ha WhatsApp) e sono rimasti sul bot, chat `active`, fino a 24 ore: l'unica
 * regola che li restituiva era la chiusura del Track A a `SEQUENCE_END_DAYS`
 * (`mai_consegnato` in lib/sequence.ts), e il cron `bot-followups` per quelle chat non
 * leggeva nemmeno la cronologia prima delle 24 ore (`serveCronologia`). Le altre reti
 * "senza WhatsApp" non coprono questo caso: il ramo 63024 dell'agenda (7a2c42b) vale per
 * le agende dei GDO, `apertura_mai_partita` per le chat a cui il bot non ha mai scritto.
 *
 * Regola: se TUTTO quello che il bot ha mandato dall'arruolamento e' fallito, almeno un
 * messaggio con un errore definitivo di destinatario (`ERRORI_DESTINATARIO_DEFINITIVI`:
 * 63024, 63003, 21211, 21614), nessuno consegnato e il lead non ha mai scritto, il lead
 * non puo' ricevere niente da noi: si restituisce al CRM con lo stesso esito della fine
 * sequenza (`esitoMaiConsegnato`, nota "WhatsApp mai consegnato (numero senza
 * WhatsApp ...)"), che il CRM manda al giro dei GDO con `instradato: 'mai_consegnato'`
 * e, per i BF, la notifica in campanella. La chat si chiude con
 * `handed_off_reason = 'numero_senza_whatsapp'`.
 *
 * Due punti d'innesco: la callback di stato Twilio (secondi) e, come rete, il cron orario
 * (per gli errori sincroni come 21211/21614, che una callback non la mandano).
 *
 * Per ora solo i funnel in `FUNNEL_SENZA_WHATSAPP_SUBITO` (BLACK FRIDAY); gli altri
 * restano alla chiusura a 24 ore come prima.
 */
import { ERRORI_DESTINATARIO_DEFINITIVI } from './recupero-aperture';
import { isCrmFunnelBlackFriday } from './black-friday';

/** Motivo scritto su `conversations.handed_off_reason`. */
export const HANDOFF_SENZA_WHATSAPP = 'numero_senza_whatsapp';
/** Evento in `event_log` a ogni restituzione. */
export const EVENTO_SENZA_WHATSAPP = 'senza_whatsapp_restituito';

/** Funnel a cui la regola si applica oggi (PO 10/11/2026: almeno i BF). */
export function regolaSubitoPerFunnel(funnel: string | null | undefined): boolean {
  return isCrmFunnelBlackFriday(funnel);
}

export type MsgEsito = {
  direction: string;
  twilio_status: string | null;
  twilio_error_code?: number | null;
};

const FALLITO = new Set(['undelivered', 'failed']);

/**
 * Pura. Sui messaggi della chat dall'arruolamento in poi: il bot ha scritto, niente e'
 * arrivato, almeno un errore e' definitivo, il lead non ha mai scritto. Un messaggio
 * ancora `queued`/`sent` (esito non arrivato) o consegnato blocca: non si decide al buio.
 */
export function numeroSenzaWhatsapp(msgs: readonly MsgEsito[]): boolean {
  if (msgs.some((m) => m.direction === 'in')) return false;
  const uscite = msgs.filter((m) => m.direction === 'out');
  if (uscite.length === 0) return false;
  if (!uscite.every((m) => FALLITO.has(m.twilio_status ?? ''))) return false;
  return uscite.some((m) => m.twilio_error_code != null && ERRORI_DESTINATARIO_DEFINITIVI.includes(m.twilio_error_code));
}

/** Lo stretto necessario della conversazione per sapere se la regola puo' scattare. */
export type ConvSenzaWhatsapp = {
  crm_lead_id: string | null;
  crm_funnel: string | null;
  ai_status: string | null;
  bot_outcome: string | null;
  ai_paused_at?: string | null;
};

/**
 * Pura. La chat e' una di quelle che la regola puo' restituire: lead CRM ancora guidato
 * dal bot, senza esito, non in pausa manuale, funnel ammesso. Postino del GDO e lancio
 * li esclude chi chiama (stesse funzioni del cron).
 */
export function convIdonea(c: ConvSenzaWhatsapp): boolean {
  if (!c.crm_lead_id) return false;
  if (c.bot_outcome) return false;
  if (c.ai_paused_at) return false;
  if (c.ai_status !== 'active' && c.ai_status !== 'replying') return false;
  return regolaSubitoPerFunnel(c.crm_funnel);
}
