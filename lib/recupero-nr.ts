import type { CallAttempt } from './call-attempt';

/**
 * Lo stato della conversazione, già letto dal database, che serve a decidere se
 * scrivere. Il chiamante lo costruisce leggendo `conversations` + l'ultimo inbound da
 * `messages` + l'evento `recupero_nr_inviato` da `event_log`: qui dentro non si fa
 * nessuna query, solo la decisione.
 */
export type StatoConversazione = {
  ai_owner: string | null;
  ai_status: string | null;
  bot_outcome: string | null;
  bot_scheduled_at: string | null;
  cancel_requested_at: string | null;
  /** Ultimo messaggio DEL LEAD, o null se non ha mai scritto. */
  ultimoInboundAt: string | null;
  /** Esiste già un recupero per questo tentativo: non si manda due volte lo stesso. */
  giaInviatoTentativo: boolean;
};

export type MotivoStop =
  | 'non_nostro'
  | 'disdetta_chiesta'
  | 'passato_a_persona'
  | 'gia_risposto'
  | 'appuntamento_non_valido'
  | 'gia_inviato';

export type Verdetto = { ok: true } | { ok: false; motivo: MotivoStop };

/**
 * Le sei condizioni che fermano l'invio del recupero, tutte lette da colonne — nessuna
 * dipende dall'interpretazione di un testo. Qui sbagliare significa scrivere a qualcuno
 * che ci aveva chiesto di smettere, quindi l'ordine e le condizioni sono quelli decisi
 * e vanno rispettati alla lettera, non reinterpretati caso per caso.
 */
export function puoScrivere(stato: StatoConversazione, evento: CallAttempt, nowMs: number): Verdetto {
  if (stato.ai_owner !== 'mario') return { ok: false, motivo: 'non_nostro' };
  if (stato.cancel_requested_at) return { ok: false, motivo: 'disdetta_chiesta' };
  if (stato.ai_status === 'handed_off') return { ok: false, motivo: 'passato_a_persona' };

  // Ha già risposto DOPO la chiamata persa: non c'è niente da recuperare. Se ha
  // scritto prima (o mai), la chiamata a vuoto resta un buco da colmare.
  if (stato.ultimoInboundAt && Date.parse(stato.ultimoInboundAt) > Date.parse(evento.at)) {
    return { ok: false, motivo: 'gia_risposto' };
  }

  if (!stato.bot_scheduled_at || Date.parse(stato.bot_scheduled_at) < nowMs) {
    return { ok: false, motivo: 'appuntamento_non_valido' };
  }

  if (stato.giaInviatoTentativo) return { ok: false, motivo: 'gia_inviato' };

  return { ok: true };
}
