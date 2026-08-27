// Le due code arretrate concordate col CRM il 26/08/2026.
//
// 1. Gli avvisi di consegna dell'agenda mai partiti (l'URL non era configurato). Il
//    loro endpoint e' idempotente e agisce solo sulla transizione inviato -> consegnato:
//    non serve nessuna finestra di deduplica, ce l'hanno confermato per iscritto.
// 2. Gli esiti che il CRM ha rifiutato con 403 "lead non assegnato a un account bot".
//    Sono lead su cui il bot ha lavorato davvero e di cui loro non vedono il risultato.
//    Ci hanno chiesto di rimandarli come NOTA: costa poco a entrambi e si smette di
//    perdere informazione.
//
// Qui c'e' solo la costruzione del testo, che e' la parte da tenere onesta. La rete e
// il database stanno in `app/api/cron/arretrati`.

import { formatRomeDateTime } from './rome-time';

const COME_SI_LEGGE: Record<string, string> = {
  APPUNTAMENTO: 'aveva fissato un appuntamento',
  DA_SCARTARE: 'lo aveva chiuso come da scartare',
  RICHIAMO: 'aveva registrato una richiesta di richiamo',
  NON_RISPOSTO: 'non aveva mai ricevuto risposta',
  INTERROTTO: 'aveva smesso di lavorarlo senza risposta',
};

/**
 * La nota per un esito che il vostro sistema aveva rifiutato con 403.
 *
 * Dice tre cose e basta: cosa aveva concluso il bot, quando, e con che parole del lead.
 * Nessuna richiesta di cambiare stato: il lead e' tornato a una persona, e la decisione
 * e' loro. Serve solo a non far sparire il lavoro fatto.
 */
export function buildEsitoRifiutatoNote(input: {
  outcome: string;
  quandoIso: string;
  discardReason?: string | null;
  leadWords?: string | null;
}): string {
  const cosa = COME_SI_LEGGE[input.outcome] ?? `aveva registrato l'esito ${input.outcome}`;
  const quando = formatRomeDateTime(input.quandoIso);
  const motivo = input.discardReason?.replace(/\s+/g, ' ').trim();
  const parole = input.leadWords?.replace(/\s+/g, ' ').trim();
  const coda = [
    motivo ? ` Motivo: ${motivo}.` : '',
    parole ? ` Parole del lead: "${parole.slice(0, 300)}".` : '',
  ].join('');
  return (
    `ESITO CHE NON VI ERA ARRIVATO — il bot ${cosa} il ${quando}, ma il vostro sistema ` +
    `aveva rifiutato l'esito perche' il lead non era piu' assegnato all'account bot. ` +
    `Ve lo giriamo come nota: il lead resta vostro, non c'e' niente da cambiare.${coda}`
  );
}
