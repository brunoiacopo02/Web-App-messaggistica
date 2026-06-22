export type LeadSegment = 'PRESO' | 'MAI_RISPOSTO' | 'ATTIVA' | 'FERMA';

export interface SegmentInput {
  bot_outcome: string | null;
  last_inbound_at: string | null;
  ai_status: string | null;
}

export const ACTIVE_WINDOW_MS = 22 * 3600_000;

const LIVE_STATUSES = ['active', 'replying'];

export function segmentOf(c: SegmentInput, now: string): LeadSegment {
  if (c.bot_outcome === 'APPUNTAMENTO') return 'PRESO';
  if (!c.last_inbound_at) return 'MAI_RISPOSTO';
  const fresh = Date.parse(now) - Date.parse(c.last_inbound_at) <= ACTIVE_WINDOW_MS;
  if (LIVE_STATUSES.includes(c.ai_status ?? '') && fresh) return 'ATTIVA';
  return 'FERMA';
}

export function fermaReason(c: SegmentInput, now: string): 'RICHIAMO' | 'DA_SCARTARE' | 'NON_RISPOSTO' | 'SILENTE' | null {
  if (segmentOf(c, now) !== 'FERMA') return null;
  if (c.bot_outcome) return c.bot_outcome as 'RICHIAMO' | 'DA_SCARTARE' | 'NON_RISPOSTO';
  return 'SILENTE';
}
