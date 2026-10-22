import { giornoRoma, oraRoma } from './rome-time';

/**
 * Riscaldamento del lead GDO: dopo il recap, due domande prima della call (cosa vuole e
 * perché adesso; prezzo e chi decide). Non sono messaggi del codice: è una nota appesa al
 * system prompt, così il modello risponde prima a quello che il lead ha scritto e infila la
 * domanda dopo. Il passo avanza solo quando il modello rimette il tag `[RISCALDAMENTO:n]`.
 * Le risposte arrivano al CRM come `[NOTA|...]`: il bot non esita mai il lead del GDO.
 */

/** Sotto le 3 ore dalla call non si fanno domande: il lead deve solo presentarsi. */
const MIN_ANTICIPO_MS = 3 * 3600_000;

/** Passo raggiunto a riscaldamento chiuso (risposto o lasciato perdere). */
export const RISCALDAMENTO_CHIUSO = 3;

export interface RiscaldamentoInput {
  /** `GDO_WARMUP_ENABLED === '1'`. */
  enabled: boolean;
  /** `gdo_warmup_step`: null = mai iniziato, 1-2 = domanda fatta, 3 = chiuso. */
  step: number | null;
  /** `gdo_recap_for_at`: senza recap mandato non si parte. */
  recapForAt: string | null;
  /** Il recap esce proprio in questo turno: le domande partono dal prossimo. */
  recapInQuestoTurno: boolean;
  /** Ora della call fissata dal GDO. */
  appuntamentoAt: string | null;
  /** In questo turno il modello deve spiegare Noemi: una cosa alla volta. */
  serveNoemi: boolean;
  nowMs: number;
}

const passo1 = (call: Date): string =>
  `RISCALDAMENTO, PASSO 1: prima rispondi a quello che il lead ha scritto. Poi, una volta sola, digli "per preparare bene la tua videochiamata di ${giornoRoma(call)} ti faccio 2 domande veloci" e fagli la prima: cosa vuole ottenere, e perché proprio adesso. Una domanda sola, frasi semplici. Se nella chat ti ha già detto cosa vuole e perché, salta questa domanda e fai direttamente la seconda (vedi passo 2) mettendo [RISCALDAMENTO:2] invece di [RISCALDAMENTO:1]. In coda al messaggio metti [RISCALDAMENTO:1]. Se il lead sta disdicendo, spostando o chiede altro, segui le regole della chat e NON fare la domanda né mettere il tag.`;

const PASSO_2 =
  'RISCALDAMENTO, PASSO 2: il lead ha risposto alla prima domanda. Ringrazia in tre parole e fai la seconda: "nel video vedi che il percorso va da 1.000 a 3.000 euro, si può rateizzare. Alla videochiamata ci sei tu da solo o decidi insieme a qualcuno?". Mai cifre di rata. In coda metti [RISCALDAMENTO:2]. Se il messaggio del lead non c\'entra niente per la seconda volta di fila, lascia perdere e metti [RISCALDAMENTO:0].';

const chiusura = (call: Date): string =>
  `RISCALDAMENTO, CHIUSURA: il lead ha risposto anche alla seconda domanda. Ringrazia in una riga e ricordagli in una riga la videochiamata di ${giornoRoma(call)} alle ${oraRoma(call)}. In coda metti [NOTA|Riscaldamento prima della call: obiettivo "<sue parole>"; prezzo e chi decide "<sue parole>"] e [RISCALDAMENTO:3]. Se ti ha detto che non ha soldi, che non ricorda di aver fissato o che non gli interessa, la nota comincia con "⚠️ Da verificare: ". Non dargli nessun esito e non scartarlo.`;

/** La nota del passo da fare in questo turno, o null se il riscaldamento tace. */
export function notaRiscaldamento(i: RiscaldamentoInput): string | null {
  if (!i.enabled) return null;
  const step = i.step ?? 0;
  if (step >= RISCALDAMENTO_CHIUSO) return null;
  if (!i.recapForAt || i.recapInQuestoTurno || i.serveNoemi) return null;
  const callMs = i.appuntamentoAt ? Date.parse(i.appuntamentoAt) : NaN;
  if (Number.isNaN(callMs) || callMs - i.nowMs < MIN_ANTICIPO_MS) return null;
  const call = new Date(callMs);
  if (step === 0) return passo1(call);
  if (step === 1) return PASSO_2;
  return chiusura(call);
}

/**
 * Il passo dopo la risposta del modello. Avanza solo il tag atteso (`step + 1`); dal passo
 * iniziale vale anche 2, perché la nota del passo 1 permette di saltare la prima domanda.
 * `0` chiude senza nota. Tag assente o fuori sequenza: il passo resta dov'è e la stessa
 * nota torna al turno dopo.
 */
export function avanzaRiscaldamento(
  step: number | null,
  tag: 0 | 1 | 2 | 3 | undefined,
): { step: number | null; chiuso: boolean } {
  const fermo = { step, chiuso: false };
  const attuale = step ?? 0;
  if (tag === undefined || attuale >= RISCALDAMENTO_CHIUSO) return fermo;
  if (tag === 0) return { step: RISCALDAMENTO_CHIUSO, chiuso: true };
  const ammesso = tag === attuale + 1 || (attuale === 0 && tag === 2);
  if (!ammesso) return fermo;
  return { step: tag, chiuso: tag === RISCALDAMENTO_CHIUSO };
}
