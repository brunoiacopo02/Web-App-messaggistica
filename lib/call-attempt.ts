import { isoWithOffset } from './bot-contract';

/**
 * Evento che il CRM manda quando una Conferma prova a telefonare a un lead e non lo
 * trova. Non è un esito del bot: è un fatto loro che decide se scriviamo noi.
 */
export type CallAttempt = {
  leadId: string;
  esito: 'no_answer';
  tentativo: number;
  /** ISO con offset: il momento della chiamata a vuoto. */
  at: string;
  /** ISO con offset: l'appuntamento che la chiamata doveva confermare. */
  appointmentAt: string;
};

export function parseCallAttempt(
  raw: unknown,
): { ok: true; value: CallAttempt } | { ok: false; reason: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'bad_request' };
  const o = raw as Record<string, unknown>;

  const leadId = typeof o.leadId === 'string' ? o.leadId.trim() : '';
  if (!leadId) return { ok: false, reason: 'lead_mancante' };

  if (o.esito !== 'no_answer') return { ok: false, reason: 'esito_non_valido' };

  // Number.isInteger scarta anche le stringhe numeriche: un CRM che manda "1" invece di
  // 1 deve fallire in modo esplicito, non passare per conversione implicita.
  if (typeof o.tentativo !== 'number' || !Number.isInteger(o.tentativo)) {
    return { ok: false, reason: 'tentativo_non_valido' };
  }

  if (typeof o.at !== 'string' || !isoWithOffset(o.at)) return { ok: false, reason: 'at_non_valido' };
  if (typeof o.appointmentAt !== 'string' || !isoWithOffset(o.appointmentAt)) {
    return { ok: false, reason: 'appointmentAt_non_valido' };
  }

  return {
    ok: true,
    value: { leadId, esito: 'no_answer', tentativo: o.tentativo, at: o.at, appointmentAt: o.appointmentAt },
  };
}

/**
 * Solo il tentativo 1 e il tentativo 3 producono un messaggio: sono i due punti in cui
 * il CRM ci chiama quando la Conferma non trova il lead al telefono. Il tentativo 2 (e
 * qualunque altro valore) resta un payload VALIDO — non è un errore del CRM, è un
 * evento che semplicemente non genera un invio. Distinguerlo qui, e non nel parser,
 * evita di rispondere 400 su qualcosa che il CRM non ritenterà: perderemmo la traccia
 * dell'evento senza guadagnare nulla.
 */
export function tentativoGestito(n: number): boolean {
  return n === 1 || n === 3;
}
