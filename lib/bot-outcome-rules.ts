import type { BotOutcome } from './bot-contract';

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
    case 'DA_SCARTARE':
      base = `Il lead vuole annullare l'appuntamento. Motivo: ${args.discardReason?.trim() || 'non specificato'}.`;
      break;
    case 'INTERROTTO':
      base = `Conversazione interrotta dopo l'appuntamento. Appuntamento mantenuto.`;
      break;
    case 'RICHIAMO':
      base = `Il lead ha chiesto di essere ricontattato${args.date ? ` (${args.date})` : ''}. Appuntamento mantenuto.`;
      break;
    case 'NON_RISPOSTO':
      base = `Nessuna risposta successiva. Appuntamento mantenuto.`;
      break;
    case 'APPUNTAMENTO':
      if (args.date && existingDate && args.date !== existingDate) {
        base = `Il lead ha chiesto di spostare a ${args.date}. Appuntamento originale mantenuto: ${existingDate}.`;
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
