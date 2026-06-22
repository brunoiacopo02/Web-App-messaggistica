const H = 3600_000;
// Tutto deve stare entro 24h: oltre la finestra WhatsApp/Facebook non recapita più
// testo libero, quindi niente solleciti tardivi e si chiude a 24h.
export const FOLLOWUP_1_H = 12;
export const FOLLOWUP_2_H = 22;
export const GIVEUP_H = 24;

export const FOLLOWUP_TEXTS: [string, string] = [
  'Ciao, sono ancora Mario di Fenice, sei riuscito a leggere il mio messaggio?',
  'Ti scrivo un ultima volta, se ti va ne parliamo due minuti quando hai tempo',
];

export type FollowupAction = 'sollecito_1' | 'sollecito_2' | 'non_risposto' | 'none';

/** Decide l'azione per un lead CRM che non ha ancora risposto. Puro. */
export function decideFollowupAction(input: {
  startedAtMs: number;
  nowMs: number;
  followupsSent: number;
  hasInbound: boolean;
}): FollowupAction {
  if (input.hasInbound) return 'none';
  const elapsedH = (input.nowMs - input.startedAtMs) / H;
  // Passate le 24h non si manda più nulla in testo libero: si chiude e basta.
  if (elapsedH >= GIVEUP_H) return 'non_risposto';
  if (input.followupsSent < 1 && elapsedH >= FOLLOWUP_1_H) return 'sollecito_1';
  if (input.followupsSent < 2 && elapsedH >= FOLLOWUP_2_H) return 'sollecito_2';
  return 'none';
}
