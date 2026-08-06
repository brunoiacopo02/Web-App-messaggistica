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

/**
 * Oltre questo orizzonte una data di richiamo non è più un appuntamento telefonico: è
 * un numero che il modello ha tirato fuori da "più avanti". ~6 mesi.
 */
export const RICHIAMO_ORIZZONTE_MS = 183 * 24 * 3600_000;

export type MotivoDataNonUsabile = 'assente' | 'illeggibile' | 'passato' | 'oltre_orizzonte';
export type RichiamoCheck = { ok: true } | { ok: false; motivo: MotivoDataNonUsabile };

/**
 * La data di un RICHIAMO è utilizzabile? `isoWithOffset` valida il FORMATO; qui si
 * guarda la plausibilità, che è la cosa che mancava: una data nel passato o a due anni
 * da oggi passa il formato e finisce in agenda a un commerciale.
 */
export function checkDataRichiamo(date: string | undefined, nowMs: number): RichiamoCheck {
  if (!date || !date.trim()) return { ok: false, motivo: 'assente' };
  const t = Date.parse(date);
  if (Number.isNaN(t)) return { ok: false, motivo: 'illeggibile' };
  if (t < nowMs) return { ok: false, motivo: 'passato' };
  if (t - nowMs > RICHIAMO_ORIZZONTE_MS) return { ok: false, motivo: 'oltre_orizzonte' };
  return { ok: true };
}

const DETTAGLIO_MOTIVO: Record<MotivoDataNonUsabile, string> = {
  assente: 'ma non ha indicato quando',
  illeggibile: 'ma non ha indicato quando in modo utilizzabile',
  passato: 'ma la data raccolta è nel passato e non è utilizzabile',
  oltre_orizzonte: 'ma la data raccolta è troppo lontana per essere quella vera',
};

/** Oltre questa lunghezza una citazione smette di essere leggibile al volo. */
const MAX_PAROLE_LEAD = 400;

/**
 * Le parole del lead pronte per una nota: a-capo e spazi doppi via, taglio su confine
 * di parola. Le note le leggono le Conferme pochi minuti prima di chiamare il cliente,
 * quindi devono stare su una riga e finire dove finisce un pensiero.
 */
export function paroleDelLead(testo: string | undefined, max = MAX_PAROLE_LEAD): string | null {
  const pulito = (testo ?? '').replace(/\s+/g, ' ').trim();
  if (!pulito) return null;
  if (pulito.length <= max) return pulito;
  const tagliato = pulito.slice(0, max);
  const ultimoSpazio = tagliato.lastIndexOf(' ');
  const base = ultimoSpazio > max * 0.6 ? tagliato.slice(0, ultimoSpazio) : tagliato;
  return `${base.trimEnd()}…`;
}

/**
 * La nota del CONTATTO_UMANO. Il CRM la mostra alle Conferme: il fatto in testa, poi
 * le parole del lead. La richiesta non si parafrasa mai — "vuole assistenza" e "voglio
 * disdire e parlare con un responsabile" non sono la stessa cosa, e chi chiama deve
 * sapere quale delle due ha davanti.
 */
export function buildContattoUmanoNote(input: { leadWords?: string; motivo?: string }): string {
  const parole = paroleDelLead(input.leadWords);
  const motivo = input.motivo?.replace(/\s+/g, ' ').trim();
  const coda = parole
    ? ` Parole del lead: "${parole}".`
    : ' Il lead ha chiesto esplicitamente di parlare con una persona.';
  const contesto = motivo ? ` Contesto: ${motivo}.` : '';
  return `RICHIESTA DI PARLARE CON UNA PERSONA — il bot si è fatto da parte.${coda}${contesto}`;
}

/**
 * La nota che parte al posto di un RICHIAMO con una data che non ci fidiamo a mandare.
 * Nessuna data dentro, di proposito: si riportano le parole del lead e si dice
 * esplicitamente che giorno e ora sono da concordare. La data scartata viaggia
 * nell'event_log, dove serve a noi e non confonde il commerciale.
 */
export function buildRichiamoSenzaDataNote(input: {
  motivo: MotivoDataNonUsabile;
  leadWords?: string;
}): string {
  const parole = input.leadWords?.trim();
  const citazione = parole ? ` Parole del lead: "${parole}".` : '';
  return (
    `Il lead ha chiesto di essere ricontattato ${DETTAGLIO_MOTIVO[input.motivo]}. ` +
    `Da richiamare, giorno e ora da concordare.${citazione}`
  );
}
