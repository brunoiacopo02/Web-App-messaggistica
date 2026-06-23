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

export type FollowupAction = 'sollecito_1' | 'sollecito_2' | 'non_risposto' | 'interrotto' | 'none';

/** Decide l'azione per un lead CRM. Puro. */
export function decideFollowupAction(input: {
  startedAtMs: number;
  nowMs: number;
  followupsSent: number;
  hasInbound: boolean;
  lastInboundAtMs: number | null;
}): FollowupAction {
  if (input.hasInbound) {
    // Ha risposto almeno una volta poi è rimasto silente: nessun sollecito,
    // chiudi come INTERROTTO dopo 24h di silenzio (= chiusura finestra free-text).
    const ref = input.lastInboundAtMs ?? input.startedAtMs;
    const silentH = (input.nowMs - ref) / H;
    return silentH >= GIVEUP_H ? 'interrotto' : 'none';
  }
  // Mai risposto: solleciti poi NON_RISPOSTO (invariato).
  const elapsedH = (input.nowMs - input.startedAtMs) / H;
  if (elapsedH >= GIVEUP_H) return 'non_risposto';
  if (input.followupsSent < 1 && elapsedH >= FOLLOWUP_1_H) return 'sollecito_1';
  if (input.followupsSent < 2 && elapsedH >= FOLLOWUP_2_H) return 'sollecito_2';
  return 'none';
}
