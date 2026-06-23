const H = 3600_000;
// Nessun sollecito WhatsApp: solo classificazione CRM a 24h.
// NON_RISPOSTO se mai risposto dopo 24h; INTERROTTO se risposto poi silente 24h.
export const GIVEUP_H = 24;

/** @deprecated Non più usati: i solleciti sono stati rimossi. Mantenuti per compatibilità import del cron. */
export const FOLLOWUP_TEXTS: [string, string] = ['', ''];

export type FollowupAction = 'non_risposto' | 'interrotto' | 'none';

/** Decide l'azione per un lead CRM. Puro. */
export function decideFollowupAction(input: {
  startedAtMs: number;
  nowMs: number;
  /** @deprecated Non più usato dalla logica. Mantenuto per compatibilità con il cron chiamante. */
  followupsSent?: number;
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
  // Mai risposto: classificazione diretta a 24h, nessun sollecito.
  const elapsedH = (input.nowMs - input.startedAtMs) / H;
  if (elapsedH >= GIVEUP_H) return 'non_risposto';
  return 'none';
}
