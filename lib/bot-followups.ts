const H = 3600_000;
export const FOLLOWUP_1_H = 18;
export const FOLLOWUP_2_H = 36;
export const GIVEUP_H = 48;

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
  if (input.followupsSent < 1 && elapsedH >= FOLLOWUP_1_H) return 'sollecito_1';
  if (input.followupsSent < 2 && elapsedH >= FOLLOWUP_2_H) return 'sollecito_2';
  if (input.followupsSent >= 2 && elapsedH >= GIVEUP_H) return 'non_risposto';
  return 'none';
}
