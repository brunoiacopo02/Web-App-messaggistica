import { decideTrackA, decideTrackB, type MsgLite } from './sequence';

// Il cron bot-followups fa SOLO le classificazioni finali verso il CRM:
// gli invii (aperture, touch, nudge) sono compito del cron sequence-touches.
export type FollowupAction = 'non_risposto' | 'discard_dead' | 'interrotto_classify' | 'none';

/**
 * Decide la classificazione finale per un lead CRM. Pura: delega a
 * decideTrackA/decideTrackB e mappa i soli kind di classificazione;
 * ogni kind di invio o attesa diventa 'none'.
 * Le classificazioni scattano anche a kill-switch spento (garantito da lib/sequence).
 */
export function decideFollowupAction(input: {
  nowMs: number;
  msgs: MsgLite[];
  seqSids: string[];
  hasInbound: boolean;
  lastInboundAtMs: number | null;
  /** Esito CRM già registrato. APPUNTAMENTO è terminale: mai riclassificare. */
  botOutcome?: string | null;
  /** Kill-switch invii (SEQUENCE_ENABLED). Irrilevante per le classificazioni. */
  sequenceEnabled?: boolean;
  /** conversations.bot_followups_sent (contatore nudge Track B). */
  nudgesSent?: number;
}): FollowupAction {
  // Lead già fissato: mai riclassificare (il re-invio verrebbe tradotto in un
  // nuovo POST APPUNTAMENTO al CRM, che lo risegnerebbe da zero).
  if (input.botOutcome === 'APPUNTAMENTO') return 'none';

  if (input.hasInbound && input.lastInboundAtMs !== null) {
    // Track B: ha risposto poi silenzio.
    const b = decideTrackB({
      nowMs: input.nowMs,
      lastInboundAtMs: input.lastInboundAtMs,
      nudgesSent: input.nudgesSent ?? 0,
      sequenceEnabled: input.sequenceEnabled ?? false,
    });
    return b.kind === 'classify' ? 'interrotto_classify' : 'none';
  }

  // Track A: mai risposto.
  const a = decideTrackA({
    nowMs: input.nowMs,
    msgs: input.msgs,
    seqSids: input.seqSids,
    sequenceEnabled: input.sequenceEnabled ?? false,
  });
  if (a.kind === 'discard_dead') return 'discard_dead';
  if (a.kind === 'non_risposto') return 'non_risposto';
  return 'none';
}
