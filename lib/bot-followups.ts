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
  /** Esito CRM già registrato. Qualunque esito è terminale: mai riclassificare. */
  botOutcome?: string | null;
  /** Kill-switch invii (SEQUENCE_ENABLED). Irrilevante per le classificazioni. */
  sequenceEnabled?: boolean;
  /** conversations.bot_followups_sent (contatore nudge Track B). */
  nudgesSent?: number;
  /** Lead di proprietà di un GDO (`gdo_agenda_at`): il bot fa solo da canale. */
  gdoPostino?: boolean;
}): FollowupAction {
  // Lead del GDO: l'esito non è nostro da decidere. Una classificazione automatica
  // arriverebbe al CRM come esito su un lead che sta lavorando un commerciale.
  if (input.gdoPostino === true) return 'none';

  // Un esito è già stato dato: mai riclassificare, qualunque esso sia. La guardia
  // copriva solo APPUNTAMENTO, ma una riga riaperta dal webhook che porta ancora il suo
  // esito rispedisce lo stesso POST a ogni giro del cron — il 07/08 erano 21
  // conversazioni 'active' con un esito già registrato (11 INTERROTTO, 8 NON_RISPOSTO,
  // 2 RICHIAMO).
  if (input.botOutcome) return 'none';

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
