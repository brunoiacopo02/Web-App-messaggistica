/**
 * La finestra delle 24 ore di WhatsApp, PER NUMERO (06/11/2026).
 *
 * Meta tiene aperta la finestra di servizio per coppia (numero azienda, numero lead):
 * se il lead ha scritto al 0047, dal 3199 la finestra e' chiusa e il testo libero torna
 * 63016. Fino al 06/11 il bot la calcolava per chat (`last_inbound_at`), e con piu'
 * numeri sulla stessa chat poteva credere aperta una finestra che sul mittente scelto non
 * lo era. Ora conta anche A QUALE numero e' arrivato l'ultimo inbound
 * (`conversations.last_inbound_number`, scritto dal webhook in ingresso).
 *
 * Si conosce solo il numero dell'ULTIMO inbound: se il lead ha scritto prima al 3199 e poi
 * al 0047, per il 3199 la finestra risulta chiusa anche se a rigore potrebbe essere ancora
 * aperta. E' l'errore buono: al massimo parte un template dove sarebbe bastato il testo.
 *
 * Modulo puro: niente DB, niente env.
 */

const FINESTRA_MS = 24 * 3600_000;

function soloNumero(n: string | null | undefined): string {
  return (n ?? '').trim().replace(/^whatsapp:/i, '');
}

/**
 * L'ultimo inbound conta per un invio da `from`? Si se e' arrivato proprio su `from`.
 * `lastInboundNumber` assente = dato non registrato (righe prima della colonna): vale il
 * comportamento di prima, cioe' si. `from` assente = non si sa da dove si mandera': no.
 */
export function inboundSulNumero(lastInboundNumber: string | null | undefined, from: string | null | undefined): boolean {
  const arrivo = soloNumero(lastInboundNumber);
  if (!arrivo) return true;
  const mittente = soloNumero(from);
  if (!mittente) return false;
  return arrivo === mittente;
}

/**
 * L'istante dell'ultimo inbound da dare alle decisioni "testo o template", ma solo se
 * vale per `from`; altrimenti `null`, che per tutte vuol dire "finestra chiusa".
 * Generico sul tipo cosi' serve sia a chi lavora con l'ISO sia a chi lavora coi ms.
 */
export function ultimoInboundSulNumero<T extends string | number>(
  ultimo: T | null | undefined,
  lastInboundNumber: string | null | undefined,
  from: string | null | undefined,
): T | null {
  if (ultimo === null || ultimo === undefined) return null;
  return inboundSulNumero(lastInboundNumber, from) ? ultimo : null;
}

/** La finestra e' aperta per un invio da `from`? */
export function finestraApertaSuNumero(
  conv: { last_inbound_at?: string | null; last_inbound_number?: string | null } | null | undefined,
  from: string | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  const ultimo = conv?.last_inbound_at;
  if (!ultimo) return false;
  const t = Date.parse(ultimo);
  if (Number.isNaN(t) || nowMs - t >= FINESTRA_MS) return false;
  return inboundSulNumero(conv?.last_inbound_number, from);
}
