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
  /** Il pulsante "Ferma il bot" del pannello: una persona ha preso in mano la chat. */
  ai_paused_at: string | null;
  bot_outcome: string | null;
  bot_scheduled_at: string | null;
  /** L'appuntamento dei lead "postino": fissato da un GDO, non dal bot. */
  gdo_appuntamento_at: string | null;
  cancel_requested_at: string | null;
  /** Ultimo messaggio DEL LEAD, o null se non ha mai scritto. */
  ultimoInboundAt: string | null;
  /** Esiste già un recupero per questo tentativo: non si manda due volte lo stesso. */
  giaInviatoTentativo: boolean;
};

export type MotivoStop =
  | 'non_nostro'
  | 'bot_fermato'
  | 'disdetta_chiesta'
  | 'passato_a_persona'
  | 'gia_risposto'
  | 'appuntamento_non_valido'
  | 'gia_inviato';

export type Verdetto = { ok: true } | { ok: false; motivo: MotivoStop };

/**
 * L'appuntamento per cui vale la pena scrivere, fra i due posti in cui può stare.
 * Un lead può averli entrambi (il bot gliene aveva fissato uno, poi un GDO l'ha
 * richiamato e gliene ha messo un altro): vale il più recente, che è quello vero.
 * Una data illeggibile conta come assente — meglio non scrivere che scrivere di un
 * appuntamento che non sappiamo quando sia.
 */
function appuntamentoDaConfermare(stato: StatoConversazione): number | null {
  const ms = [stato.bot_scheduled_at, stato.gdo_appuntamento_at]
    .map((d) => (d ? Date.parse(d) : NaN))
    .filter((t) => !Number.isNaN(t));
  return ms.length > 0 ? Math.max(...ms) : null;
}

/**
 * Le sette condizioni che fermano l'invio del recupero, tutte lette da colonne —
 * nessuna dipende dall'interpretazione di un testo. Qui sbagliare significa scrivere a
 * qualcuno che ci aveva chiesto di smettere, quindi l'ordine e le condizioni sono
 * quelli decisi e vanno rispettati alla lettera, non reinterpretati caso per caso.
 */
export function puoScrivere(stato: StatoConversazione, evento: CallAttempt, nowMs: number): Verdetto {
  if (stato.ai_owner !== 'mario') return { ok: false, motivo: 'non_nostro' };

  // Il fermo manuale viene subito dopo la proprietà, e prima di tutto il resto: è il
  // veto che una persona ha messo dal pannello per prendersi la chat. Ovunque nel
  // codice è assoluto (`shouldAutoReply` esce, `shouldReopen` si rifiuta di riaprire
  // proprio per non mostrare "active" su una chat in mano a qualcuno) e qui il
  // percorso farebbe entrambe le cose vietate: scrivere al posto suo e riaprire.
  if (stato.ai_paused_at) return { ok: false, motivo: 'bot_fermato' };

  if (stato.cancel_requested_at) return { ok: false, motivo: 'disdetta_chiesta' };
  if (stato.ai_status === 'handed_off') return { ok: false, motivo: 'passato_a_persona' };

  // Ha già risposto DOPO la chiamata persa: non c'è niente da recuperare. Se ha
  // scritto prima (o mai), la chiamata a vuoto resta un buco da colmare.
  if (stato.ultimoInboundAt && Date.parse(stato.ultimoInboundAt) > Date.parse(evento.at)) {
    return { ok: false, motivo: 'gia_risposto' };
  }

  const appuntamento = appuntamentoDaConfermare(stato);
  if (appuntamento === null || appuntamento < nowMs) {
    return { ok: false, motivo: 'appuntamento_non_valido' };
  }

  if (stato.giaInviatoTentativo) return { ok: false, motivo: 'gia_inviato' };

  return { ok: true };
}
