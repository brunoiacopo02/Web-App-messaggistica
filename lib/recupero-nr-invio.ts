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
 * Due cose che NON stanno qui, di proposito: le regole sulle date (sono già nel prompt
 * di sistema, ripeterle in coda le mette in concorrenza con sé stesse) e la parola
 * "disturbo" — chi si scusa di aver chiamato per un appuntamento che il lead ha
 * chiesto sta insegnando al lead che quella chiamata era un fastidio.
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
