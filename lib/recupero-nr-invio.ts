import { formatRomeDateTime } from './rome-time';

/**
 * La decisione fra i due modi di scrivere a un lead che le Conferme non sono riuscite a
 * sentire al telefono: messaggio libero se WhatsApp ce lo consente ancora, template se
 * no. Qui dentro nessuna query e nessun invio — solo il confine e le parole.
 */

/** Finestra di servizio WhatsApp: 24h dall'ultimo messaggio DEL LEAD. */
const FINESTRA_MS = 24 * 3600_000;

/**
 * Fuori da questa finestra Meta rifiuta il testo libero (errore 63016): non è una
 * nostra prudenza, è la piattaforma. Si misura dall'ultimo messaggio del lead, non dal
 * nostro: sono le sue parole a tenere aperta la porta.
 *
 * Sul confine esatto si sta larghi: a 24h tonde la finestra è già chiusa per Meta e un
 * testo libero verrebbe rifiutato, mentre il template parte comunque. Nel dubbio si
 * sceglie la strada che consegna. Stessa ragione per una data illeggibile: meglio un
 * template che un invio che fallisce.
 */
export function dentroFinestra(ultimoInboundAt: string | null, nowMs: number): boolean {
  if (!ultimoInboundAt) return false;
  const t = Date.parse(ultimoInboundAt);
  if (Number.isNaN(t)) return false;
  return nowMs - t < FINESTRA_MS;
}

/**
 * Il turno sintetico che chiude la cronologia nel ramo del messaggio libero.
 *
 * Qui l'ultimo messaggio della chat è quasi sempre NOSTRO: la guardia `gia_risposto`
 * garantisce che il lead non abbia scritto dopo la chiamata a vuoto, e al suo ultimo
 * messaggio il drain ha già risposto. La cronologia grezza finirebbe quindi su un turno
 * `assistant`, che claude-sonnet-4-6 rifiuta con 400 ("does not support assistant
 * message prefill"): l'SDK non ritenta i 400, e il recupero fallirebbe per quasi tutti i
 * lead. Si riusa `buildSollecitoHistory` (lib/gdo-video-followup.ts), nata per lo stesso
 * problema sui solleciti GDO, passandole queste parole al posto delle sue: là il motivo
 * della ripresa è il silenzio del lead, qui è una telefonata che i colleghi hanno appena
 * fatto a vuoto.
 */
export const TURNO_RIPRESA_RECUPERO_NR =
  '[nota di sistema, non è un messaggio del lead: i colleghi hanno appena provato a ' +
  'telefonargli per la call già fissata e non sono riusciti a sentirlo. Scrivi tu, ' +
  'seguendo le note di contesto.]';

/** Giorno e ora dell'appuntamento come li legge il lead: è il `{{2}}` dei template. */
export function quandoLeggibile(appointmentAt: string): string {
  return formatRomeDateTime(appointmentAt);
}

/**
 * La nota di contesto che si appende al system prompt nel ramo del messaggio libero.
 * Non è il testo del messaggio: è quello che il modello deve sapere per scriverlo con
 * parole sue, dentro una conversazione che ha già una sua storia. Un testo fisso qui
 * arriverebbe addosso a chi magari stava parlando d'altro.
 *
 * Sulle date la nota dice una cosa sola: che questo appuntamento non si tocca. Come si
 * leggono e si calcolano le date sta nel prompt di sistema e non va ripetuto qui —
 * ripeterlo lo metterebbe in concorrenza con sé stesso — ma "non spostare quello già
 * fissato" è un vincolo di QUESTA conversazione, e senza il modello tratterebbe la
 * richiesta di richiamo come un'occasione per riaprire l'agenda.
 *
 * La parola "disturbo" invece non c'è di proposito: chi si scusa di aver chiamato per
 * un appuntamento che il lead ha chiesto gli sta insegnando che era un fastidio.
 */
export function notaRecuperoNr(quando: string, tentativo: number): string {
  const parti = [
    'CONTESTO DI QUESTA CONVERSAZIONE: questo lead ha GIÀ un appuntamento fissato per ' +
      `${quando}, e i colleghi hanno appena provato a chiamarlo per quella call senza ` +
      'riuscire a sentirlo. Scrivigli un messaggio breve che glielo dice, che quella ' +
      'chiamata sono 5 minuti al telefono con Noemi per gli ultimi dettagli e il link ' +
      'per collegarsi, e chiedigli quando gli va bene essere richiamato. ' +
      `L'appuntamento resta ${quando}: non cambiare giorno e ora, non riproporre la ` +
      'call e non ripartire col pitch.',
  ];

  // Il terzo tentativo è l'ultimo: dirgli che l'appuntamento salta non è una minaccia,
  // è l'unica informazione che gli permette di tenerselo. Tacerla e poi annullare
  // sarebbe la cosa scorretta.
  if (tentativo >= 3) {
    parti.push(
      'TERZO TENTATIVO: diglielo, che è la terza volta che provano a chiamarlo. E ' +
        "digli che senza una sua risposta qui l'appuntamento viene annullato. Senza " +
        'drammi e senza rimproveri: è un fatto, non una punizione.',
    );
  }

  return parti.join('\n\n');
}

/**
 * Oltre questo scarto la data del CRM e la nostra non descrivono più lo stesso
 * appuntamento. Due ore: sotto c'è lo slot spostato dentro la stessa mezza giornata (il
 * CRM è la fonte di verità sull'orario, e il messaggio resta giusto); sopra si parla di
 * un altro momento, ed è esattamente il modo in cui il bot ha già raccontato a dei lead
 * la data sbagliata della loro call.
 */
export const SCARTO_DATE_TOLLERATO_MS = 2 * 3600_000;

export type ControlloData =
  | { ok: false; motivo: 'appuntamento_gia_passato' | 'appointment_at_illeggibile' }
  | { ok: true; scartoMs: number | null; incoerente: boolean };

/**
 * `appointmentAt` arriva dal CRM ed è la data che finisce NEL MESSAGGIO al lead, sia nel
 * `{{2}}` del template sia nella nota al modello. Le sette guardie validano le nostre
 * colonne (`bot_scheduled_at`/`gdo_appuntamento_at`) e questa non la guardava nessuno:
 * una data sbagliata di là diventava una data sbagliata detta al lead.
 *
 * Un appuntamento già passato non si conferma: scrivere "ti aspettiamo" per una call di
 * ieri è peggio del silenzio, quindi si rifiuta con un motivo che si legge nel log.
 * Una divergenza grossa dalla nostra data invece non ferma l'invio — la loro è la fonte
 * di verità sull'agenda delle Conferme — ma va lasciata scritta: è il segnale che uno
 * dei due sistemi ha la riga sbagliata.
 */
export function controllaAppointmentAt(
  appointmentAt: string,
  nostroMs: number | null,
  nowMs: number,
): ControlloData {
  const t = Date.parse(appointmentAt);
  if (Number.isNaN(t)) return { ok: false, motivo: 'appointment_at_illeggibile' };
  if (t < nowMs) return { ok: false, motivo: 'appuntamento_gia_passato' };
  const scartoMs = nostroMs === null ? null : Math.abs(t - nostroMs);
  return { ok: true, scartoMs, incoerente: scartoMs !== null && scartoMs > SCARTO_DATE_TOLLERATO_MS };
}
