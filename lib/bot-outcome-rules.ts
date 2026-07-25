import type { BotOutcome } from './bot-contract';
import { formatRomeDateTime, sameInstant } from './rome-time';

export type OutcomeArgs = {
  outcome: BotOutcome;
  date?: string;
  note?: string;
  discardReason?: string;
};

export type OutcomeAction =
  | { kind: 'normal' }
  | { kind: 'locked'; outcome: 'NOTA'; note: string; date: null };

/**
 * Costruisce la nota da inviare al CRM quando un lead GIÀ fissato genera un esito
 * successivo. L'esito non declassa: viene tradotto in una nota informativa.
 */
export function buildLockedNote(args: OutcomeArgs, existingDate: string | null): string {
  const extra = args.note && args.note.trim() ? ` ${args.note.trim()}` : '';
  let base: string;
  switch (args.outcome) {
    case 'DA_SCARTARE': {
      const when = existingDate ? ` (fissato per ${formatRomeDateTime(existingDate)})` : '';
      base = `Il lead vuole annullare l'appuntamento${when}. Motivo: ${args.discardReason?.trim() || 'non specificato'}.`;
      break;
    }
    case 'INTERROTTO':
      base = `Conversazione interrotta dopo l'appuntamento. Appuntamento mantenuto.`;
      break;
    case 'RICHIAMO': {
      // RICHIAMO qui significa "il lead vuole spostare l'appuntamento già fissato".
      // Il prompt, quando il lead non indica una data, mette nel tag la data
      // dell'appuntamento stesso come fallback: se la riportassimo sempre come "data
      // indicata dal lead" le Conferme leggerebbero una richiesta di spostamento verso
      // la data già in agenda, che non ha senso. La mostriamo come "data indicata"
      // solo quando è davvero un istante diverso da quello in agenda: un confronto
      // testuale fallirebbe qui, perché existingDate arriva da Postgres normalizzato in
      // UTC mentre args.date arriva dal tag del modello nel fuso locale imposto dal
      // prompt, quindi lo stesso istante avrebbe quasi sempre due stringhe diverse.
      const leadDate = args.date && !sameInstant(args.date, existingDate) ? args.date : null;
      const datePart = leadDate ? ` alla data indicata (${formatRomeDateTime(leadDate)})` : ' (nessuna nuova data indicata dal lead)';
      const kept = existingDate ? `Appuntamento mantenuto: ${formatRomeDateTime(existingDate)}.` : 'Appuntamento mantenuto.';
      base = `Il lead ha chiesto di spostare l'appuntamento${datePart}. ${kept}`;
      break;
    }
    case 'NON_RISPOSTO':
      base = `Nessuna risposta successiva. Appuntamento mantenuto.`;
      break;
    case 'APPUNTAMENTO':
      if (args.date && existingDate && !sameInstant(args.date, existingDate)) {
        base = `Il lead ha chiesto di spostare a ${formatRomeDateTime(args.date)}. Appuntamento originale mantenuto: ${formatRomeDateTime(existingDate)}.`;
      } else {
        base = `Il lead ha riconfermato l'appuntamento.`;
      }
      break;
    case 'NOTA':
      // Non dovrebbe mai arrivare qui come esito IN INGRESSO (NOTA è solo l'esito
      // prodotto in USCITA da resolveOutcomeAction per il ramo locked). Caso incluso
      // solo per l'esaustività dello switch dopo l'aggiunta di 'NOTA' a BotOutcome.
      base = `Appuntamento mantenuto.`;
      break;
  }
  return `${base}${extra}`.trim();
}

/**
 * Decide cosa fare con un esito in arrivo dato l'esito corrente della conversazione.
 * Se la conversazione è già APPUNTAMENTO l'esito è terminale: 'locked' (nota, niente
 * declassamento). Altrimenti 'normal' (comportamento standard).
 */
export function resolveOutcomeAction(
  current: BotOutcome | null,
  args: OutcomeArgs,
  existingDate: string | null,
): OutcomeAction {
  if (current === 'APPUNTAMENTO') {
    return { kind: 'locked', outcome: 'NOTA', note: buildLockedNote(args, existingDate), date: null };
  }
  return { kind: 'normal' };
}
