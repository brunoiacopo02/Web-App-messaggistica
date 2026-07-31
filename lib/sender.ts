/** Chi ha prodotto un messaggio in uscita. Gli inbound hanno `sender` nullo. */
export type Sender = 'bot' | 'automazione' | 'operatore';

/**
 * Soglia oltre la quale `sender` è un dato registrato all'invio.
 * Prima di questo istante viene dal backfill della migration 20260731000001:
 * è una deduzione (sbaglia sui messaggi scritti a mano dentro una chat di Mario).
 * Va allineata al momento reale di applicazione in produzione — vedi Task 9 del piano.
 */
export const SENDER_STIMATO_PRIMA_DI = '2026-07-31T00:00:00Z';

export function senderStimato(createdAt: string): boolean {
  return Date.parse(createdAt) < Date.parse(SENDER_STIMATO_PRIMA_DI);
}

const LABELS: Record<string, string> = {
  bot: 'Mario',
  automazione: 'Automazione',
  operatore: 'Operatore',
};

/** Etichetta in italiano, o null se non c'è niente da mostrare. */
export function senderLabel(sender: string | null | undefined): string | null {
  return (sender && LABELS[sender]) ?? null;
}
