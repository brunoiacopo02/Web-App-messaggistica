const H = 3600_000;

/** Quanto deve essere vecchia l'agenda inviata perché parta il follow-up. */
export const AGENDA_FOLLOWUP_DELAY_MS = 2 * H;
/** Finestra di servizio WhatsApp: free-text lecito solo entro 24h dall'ultimo inbound. */
export const WINDOW_MS = 24 * H;
/** Fascia oraria (Rome) in cui è lecito inviare il follow-up. */
export const FOLLOWUP_HOUR_START = 9;
export const FOLLOWUP_HOUR_END = 21; // escluso: invia solo se ora < 21

export interface AgendaFollowupInput {
  agendaSentAtMs: number;
  nowMs: number;
  booked: boolean;
  followupAlreadySent: boolean;
  lastInboundAtMs: number | null;
  romeHour: number;
}

/** Decide se mandare il singolo follow-up agenda. Puro, niente effetti. */
export function decideAgendaFollowup(input: AgendaFollowupInput): 'send' | 'none' {
  if (input.booked) return 'none';
  if (input.followupAlreadySent) return 'none';
  if (input.nowMs - input.agendaSentAtMs < AGENDA_FOLLOWUP_DELAY_MS) return 'none';
  if (input.lastInboundAtMs === null) return 'none';
  if (input.nowMs - input.lastInboundAtMs >= WINDOW_MS) return 'none';
  if (input.romeHour < FOLLOWUP_HOUR_START || input.romeHour >= FOLLOWUP_HOUR_END) return 'none';
  return 'send';
}

/** Testo fisso del follow-up, in voce Mario. */
export function agendaFollowupText(firstName: string | null): string {
  const hi = firstName && firstName.trim() ? `Ciao ${firstName.trim()}` : 'Ciao';
  return `${hi} 🙂 ti avevo mandato gli orari per la videocall ma non ho ancora visto la conferma. Vuoi che ti tenga uno slot? Dimmi pure giorno e ora che preferisci.`;
}
