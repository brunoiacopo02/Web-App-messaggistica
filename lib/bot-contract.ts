export interface BotIntakePayload {
  leadId: string;
  name: string | null;
  phone: string;
  email: string | null;
  funnel: string | null;
  companyId: string;
}

export type BotOutcome = 'APPUNTAMENTO' | 'DA_SCARTARE' | 'RICHIAMO' | 'NON_RISPOSTO' | 'INTERROTTO' | 'NOTA';

export interface BotReport {
  summary?: string;
  painPoints?: string[];
  budgetSignal?: string;
  urgency?: string;
  objections?: string[];
  levaConsigliata?: string;
}

export interface BotOutcomeBody {
  leadId: string;
  outcome: BotOutcome;
  date?: string;
  note?: string;
  discardReason?: string;
  report?: BotReport;
}

const OUTCOMES: BotOutcome[] = ['APPUNTAMENTO', 'DA_SCARTARE', 'RICHIAMO', 'NON_RISPOSTO', 'INTERROTTO', 'NOTA'];
const DATE_REQUIRED: BotOutcome[] = ['APPUNTAMENTO', 'RICHIAMO'];

/** True solo se ISO 8601 con offset di fuso (`Z` oppure `±HH:MM`). */
export function isoWithOffset(date: string): boolean {
  if (typeof date !== 'string') return false;
  // Deve avere data+ora e terminare con Z oppure ±HH:MM
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(date)) return false;
  return !Number.isNaN(Date.parse(date));
}

export function parseIntakePayload(
  raw: unknown,
): { ok: true; value: BotIntakePayload } | { ok: false; reason: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'bad_request' };
  const o = raw as Record<string, unknown>;
  const leadId = typeof o.leadId === 'string' ? o.leadId.trim() : '';
  const phone = typeof o.phone === 'string' ? o.phone.trim() : '';
  const companyId = typeof o.companyId === 'string' ? o.companyId : '';
  if (companyId !== 'fenice') return { ok: false, reason: 'forbidden' };
  if (!leadId || !phone) return { ok: false, reason: 'bad_request' };
  return {
    ok: true,
    value: {
      leadId,
      phone,
      companyId,
      name: typeof o.name === 'string' ? o.name : null,
      email: typeof o.email === 'string' ? o.email : null,
      funnel: typeof o.funnel === 'string' ? o.funnel : null,
    },
  };
}

export function validateOutcomeBody(
  b: BotOutcomeBody,
): { ok: true } | { ok: false; reason: string } {
  if (!b || typeof b.leadId !== 'string' || !b.leadId.trim()) return { ok: false, reason: 'bad_request' };
  if (!OUTCOMES.includes(b.outcome)) return { ok: false, reason: 'bad_request' };
  if (DATE_REQUIRED.includes(b.outcome)) {
    if (!b.date || !isoWithOffset(b.date)) return { ok: false, reason: 'bad_request' };
  }
  if (b.outcome === 'NOTA' && (!b.note || !b.note.trim())) {
    return { ok: false, reason: 'note_required' };
  }
  return { ok: true };
}
