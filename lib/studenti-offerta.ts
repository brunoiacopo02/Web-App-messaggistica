/**
 * Studenti già iscritti finiti al bot per errore (lista AC 135, 10/10/2026).
 *
 * Il 10/10 alle 13:56 un'automazione AC ha riversato nel CRM 65 contatti della lista
 * 135: sono tutti studenti, e il bot li ha aperti come lead freddi. Decisione PO dello
 * stesso giorno:
 * - chi non risponde non si tocca più (la chat resta ferma: `ai_paused_at` + motivo
 *   `HANDOFF_STUDENTI`), finché non riscrive lui;
 * - chi scrive lo riprende Mario, sapendo che è già uno studente: per gli studenti può
 *   esserci un'offerta sul nuovo percorso Sviluppatore Web AI, si propone la call;
 *   dell'offerta non si dice come, quando né perché;
 * - il video come sempre solo a chi prenota.
 *
 * Il segno sta in `lancio_info.studente_offerta` (la chat NON è del lancio: niente
 * `lancio_slug`, quindi nessun cron del lancio la vede).
 */

export const HANDOFF_STUDENTI = 'studenti_lista135' as const;

/** Chat di uno studente ferma in attesa che scriva lui. */
export function chatStudenteFerma(c: { handed_off_reason?: string | null }): boolean {
  return c.handed_off_reason === HANDOFF_STUDENTI;
}

/** La chat è di uno studente segnato per l'offerta. */
export function eStudenteOfferta(info: unknown): boolean {
  if (!info || typeof info !== 'object') return false;
  return !!(info as Record<string, unknown>).studente_offerta;
}

export const STUDENTI_CONTEXT_NOTE = [
  'CONTESTO IMPORTANTE: questa persona è GIÀ UNO STUDENTE di Fenice Academy (ha già un corso con noi).',
  'Non trattarla come un lead nuovo: non fare domande di qualificazione da zero, non presentare Fenice come se non la conoscesse, non proporle il corso che ha già.',
  'Se nei messaggi precedenti le abbiamo scritto come a un contatto nuovo, scusati brevemente ("ho visto solo ora che sei già nostro studente").',
  'Il messaggio da dare: proprio per chi è già studente può esserci un\'offerta sul nuovo percorso Sviluppatore Web AI. Se le interessa, si fissa una call con un consulente che le spiega tutto.',
  'Dell\'offerta NON dire come funziona, quando scade né perché: niente prezzi, sconti, percentuali, scadenze o condizioni. Se lo chiede, rispondi che glielo spiega il consulente in call.',
  'Se parla di problemi col corso che sta facendo (lezioni, esami, tempo), ascoltala con gentilezza senza promettere interventi o soluzioni, e proponi la call: lì il consulente può parlarne con lei.',
  'Se non è interessata, salutala con gentilezza e non insistere.',
  'Il video si manda come sempre SOLO dopo che ha fissato la call, mai prima.',
].join('\n');
