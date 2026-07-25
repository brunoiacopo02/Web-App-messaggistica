import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { shouldAutoReply, shouldReopen, nextUnansweredInboundIndex, lastIsUnansweredInbound, isOrphanedReplyingLock, REPLYING_ORPHAN_MS, canSendOutcome, drainMarioReplies } from './fenice-autoreply';

vi.mock('./mario', () => ({ generateMarioReply: vi.fn() }));
vi.mock('./twilio', () => ({ sendFreeText: vi.fn(async () => ({ sid: 'SM_fake', status: 'queued' })) }));
vi.mock('./bot-report', () => ({ generateBotReport: vi.fn(async () => ({})) }));
vi.mock('./bot-outcome', () => ({ sendOutcome: vi.fn(async () => ({ sent: true })) }));

import { generateMarioReply } from './mario';
import { sendOutcome } from './bot-outcome';

describe('shouldAutoReply', () => {
  const ok = { toMatchesFenice: true, autoReplyOn: true, aiOwner: 'mario', aiStatus: 'active' };
  it('vero quando tutte le condizioni valgono (active)', () => {
    expect(shouldAutoReply(ok)).toBe(true);
  });
  it('vero anche se sta già rispondendo (replying) — il lock serializza', () => {
    expect(shouldAutoReply({ ...ok, aiStatus: 'replying' })).toBe(true);
  });
  it('falso se il numero non è Fenice', () => {
    expect(shouldAutoReply({ ...ok, toMatchesFenice: false })).toBe(false);
  });
  it('falso se lo switch è spento', () => {
    expect(shouldAutoReply({ ...ok, autoReplyOn: false })).toBe(false);
  });
  it('falso se non è gestita da Mario', () => {
    expect(shouldAutoReply({ ...ok, aiOwner: null })).toBe(false);
  });
  it('falso se handed_off o booked', () => {
    expect(shouldAutoReply({ ...ok, aiStatus: 'handed_off' })).toBe(false);
    expect(shouldAutoReply({ ...ok, aiStatus: 'booked' })).toBe(false);
  });
});

describe('nextUnansweredInboundIndex', () => {
  it('nessun messaggio -> -1', () => {
    expect(nextUnansweredInboundIndex([])).toBe(-1);
  });
  it('solo outbound (apertura) -> -1', () => {
    expect(nextUnansweredInboundIndex([{ direction: 'out', body: 'ciao' }])).toBe(-1);
  });
  it('primo inbound dopo l ultimo outbound', () => {
    const rows = [
      { direction: 'out', body: 'apertura' },
      { direction: 'in', body: 'msg1' },
      { direction: 'in', body: 'msg2' },
    ];
    expect(nextUnansweredInboundIndex(rows)).toBe(1);
  });
  it('tutti gli inbound già risposti -> -1', () => {
    const rows = [
      { direction: 'out', body: 'apertura' },
      { direction: 'in', body: 'msg1' },
      { direction: 'out', body: 'risposta1' },
    ];
    expect(nextUnansweredInboundIndex(rows)).toBe(-1);
  });
  it('inbound nuovo dopo una risposta', () => {
    const rows = [
      { direction: 'in', body: 'msg1' },
      { direction: 'out', body: 'risposta1' },
      { direction: 'in', body: 'msg2' },
    ];
    expect(nextUnansweredInboundIndex(rows)).toBe(2);
  });
});

describe('lastIsUnansweredInbound', () => {
  it('(a) ultimo messaggio inbound dopo un outbound → true', () => {
    const rows = [
      { direction: 'out', body: 'apertura' },
      { direction: 'in', body: 'risposta lead' },
    ];
    expect(lastIsUnansweredInbound(rows)).toBe(true);
  });
  it('(b) ultimo messaggio outbound → false', () => {
    const rows = [
      { direction: 'out', body: 'apertura' },
      { direction: 'in', body: 'msg1' },
      { direction: 'out', body: 'risposta bot' },
    ];
    expect(lastIsUnansweredInbound(rows)).toBe(false);
  });
  it('(c) array vuoto → false', () => {
    expect(lastIsUnansweredInbound([])).toBe(false);
  });
  it('(d) solo inbound senza outbound → true', () => {
    const rows = [
      { direction: 'in', body: 'primo messaggio lead' },
    ];
    expect(lastIsUnansweredInbound(rows)).toBe(true);
  });
});

describe('isOrphanedReplyingLock', () => {
  const NOW = 1_000_000_000_000; // ms epoch, arbitrary fixed point
  const OLD = NOW - REPLYING_ORPHAN_MS - 1; // >10 min ago → orfano
  const RECENT = NOW - REPLYING_ORPHAN_MS + 1; // <10 min ago → in corso

  it('(a) status active → false', () => {
    expect(isOrphanedReplyingLock('active', OLD, NOW)).toBe(false);
  });
  it('(b) replying + inbound recente (<10min) → false', () => {
    expect(isOrphanedReplyingLock('replying', RECENT, NOW)).toBe(false);
  });
  it('(c) replying + inbound vecchio (>10min) → true', () => {
    expect(isOrphanedReplyingLock('replying', OLD, NOW)).toBe(true);
  });
  it('(d) replying + lastInboundAtMs null → false', () => {
    expect(isOrphanedReplyingLock('replying', null, NOW)).toBe(false);
  });
});

describe('shouldReopen', () => {
  it('riapre una conversazione chiusa dopo l esito', () => {
    expect(shouldReopen({ aiOwner: 'mario', aiStatus: 'closed' })).toBe(true);
  });

  it('NON riapre una conversazione booked: resta booked (shouldAutoReply non la riprende, ai_status è anche lucchetto)', () => {
    expect(shouldReopen({ aiOwner: 'mario', aiStatus: 'booked' })).toBe(false);
  });

  it('NON riapre una conversazione presa in carico da un umano', () => {
    expect(shouldReopen({ aiOwner: 'mario', aiStatus: 'handed_off' })).toBe(false);
  });

  it('non tocca le conversazioni già vive', () => {
    expect(shouldReopen({ aiOwner: 'mario', aiStatus: 'active' })).toBe(false);
    expect(shouldReopen({ aiOwner: 'mario', aiStatus: 'replying' })).toBe(false);
  });

  it('non riapre conversazioni non arruolate nel bot', () => {
    expect(shouldReopen({ aiOwner: null, aiStatus: 'closed' })).toBe(false);
    expect(shouldReopen({ aiOwner: 'umano', aiStatus: 'booked' })).toBe(false);
  });

  it('non riapre se aiStatus è null', () => {
    expect(shouldReopen({ aiOwner: 'mario', aiStatus: null })).toBe(false);
  });
});

describe('canSendOutcome', () => {
  it('consente l esito su una conversazione CRM non ancora esitata', () => {
    expect(canSendOutcome({ crmLeadId: 'crm1', aiStatus: 'active' })).toBe(true);
  });

  it('consente l esito su un appuntamento fissato: diventerà una NOTA, non un duplicato', () => {
    expect(canSendOutcome({ crmLeadId: 'crm1', aiStatus: 'active' })).toBe(true);
  });

  it('non invia nulla senza lead CRM', () => {
    expect(canSendOutcome({ crmLeadId: null, aiStatus: 'active' })).toBe(false);
  });

  it('continua a bloccare su booked, che è un problema diverso', () => {
    expect(canSendOutcome({ crmLeadId: 'crm1', aiStatus: 'booked' })).toBe(false);
  });
});

type ClaimedRow = { id: number; ai_started_at: string | null; crm_lead_id: string | null; bot_outcome: string | null };
type FakeMsgRow = { direction: string; body: string; template_sid: string | null; created_at: string };

/**
 * Fake del client Supabase per drainMarioReplies: simula il claim CAS singolo
 * ('active' -> 'replying', unico stato claimabile), la history messaggi e traccia
 * gli insert su event_log/messages e l'update finale su ai_status.
 */
function makeDrainSupabase(claimedRow: ClaimedRow, initialRows: FakeMsgRow[]) {
  const messagesRows = [...initialRows];
  const calls = { events: [] as any[], finalStatusWrites: [] as string[], messageInserts: [] as any[] };

  const supabase: any = {
    from(table: string) {
      if (table === 'conversations') {
        return {
          update(payload: any) {
            if (payload.ai_status === 'replying') {
              let filterStatus: string | null = null;
              const stub: any = {
                eq(col: string, val: string) { if (col === 'ai_status') filterStatus = val; return stub; },
                select() { return stub; },
                single() { return Promise.resolve({ data: filterStatus === 'active' ? claimedRow : null }); },
              };
              return stub;
            }
            if ('ai_status' in payload) calls.finalStatusWrites.push(payload.ai_status);
            return { eq() { return Promise.resolve({ data: null }); } };
          },
        };
      }
      if (table === 'messages') {
        return {
          select() {
            const stub: any = {
              eq() { return stub; },
              order() { return stub; },
              limit() { return stub; },
              gte() { return stub; },
              then(resolve: any) { resolve({ data: messagesRows }); },
            };
            return stub;
          },
          insert(payload: any) {
            messagesRows.push({ direction: 'out', body: payload.body, template_sid: null, created_at: new Date().toISOString() });
            calls.messageInserts.push(payload);
            return Promise.resolve({ data: null });
          },
        };
      }
      // event_log
      return { insert(payload: any) { calls.events.push(payload); return Promise.resolve({ data: null }); } };
    },
  };

  return { supabase, calls };
}

describe('drainMarioReplies — guardia canSendOutcome dal vivo', () => {
  const OPENING: FakeMsgRow = { direction: 'out', body: 'apertura', template_sid: null, created_at: '2026-07-01T10:00:00Z' };

  beforeEach(() => {
    vi.stubEnv('TWILIO_WHATSAPP_NUMBER_FENICE', 'whatsapp:+390000000000');
    vi.mocked(generateMarioReply).mockReset();
    vi.mocked(sendOutcome).mockClear();
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  // Scenario reale e raggiungibile: bot_outcome='APPUNTAMENTO' già persistito (l'esito
  // è stato inviato con successo, ai_status='closed'). shouldReopen riapre 'closed'->
  // 'active' su un nuovo inbound (es. richiesta di spostare), drainMarioReplies claima
  // 'active' con un nuovo esito CRM: canSendOutcome ora lascia passare l'invio, che
  // sendOutcome traduce in una NOTA (non un duplicato di APPUNTAMENTO).
  it('conversazione riaperta con bot_outcome=APPUNTAMENTO già persistito: sendOutcome viene chiamata (diventa una NOTA)', async () => {
    const claimedRow: ClaimedRow = { id: 42, ai_started_at: null, crm_lead_id: 'crm1', bot_outcome: 'APPUNTAMENTO' };
    const rows: FakeMsgRow[] = [
      OPENING,
      { direction: 'in', body: 'posso spostare l appuntamento a venerdì?', template_sid: null, created_at: '2026-07-25T09:00:00Z' },
    ];
    const { supabase, calls } = makeDrainSupabase(claimedRow, rows);
    vi.mocked(generateMarioReply).mockResolvedValueOnce({
      visibleReply: 'Certo, controllo l agenda e ti confermo il nuovo orario.',
      appointmentFixed: false, passToHuman: false, videoWatched: false,
      outcome: 'APPUNTAMENTO', scheduledAt: '2026-07-28T10:00:00+02:00',
    });

    await drainMarioReplies(supabase, 42, '+391234567890', () => 0);

    expect(sendOutcome).toHaveBeenCalledTimes(1);
    expect(calls.events.some((e) => e.type === 'bot_outcome_suppressed')).toBe(false);
    expect(calls.finalStatusWrites).toEqual(['closed']); // sendOutcome mock risolve { sent: true }
  });

  it('conversazione active con nuovo esito CRM legittimo: sendOutcome viene chiamata normalmente (controllo di non-regressione)', async () => {
    const claimedRow: ClaimedRow = { id: 43, ai_started_at: null, crm_lead_id: 'crm1', bot_outcome: null };
    const rows: FakeMsgRow[] = [
      OPENING,
      { direction: 'in', body: 'richiamatemi la prossima settimana', template_sid: null, created_at: '2026-07-25T09:00:00Z' },
    ];
    const { supabase, calls } = makeDrainSupabase(claimedRow, rows);
    vi.mocked(generateMarioReply).mockResolvedValueOnce({
      visibleReply: 'Va bene, ti richiamiamo la prossima settimana.',
      appointmentFixed: false, passToHuman: false, videoWatched: false,
      outcome: 'RICHIAMO', scheduledAt: '2026-08-03T10:00:00+02:00',
    });

    await drainMarioReplies(supabase, 43, '+391234567890', () => 0);

    expect(sendOutcome).toHaveBeenCalledTimes(1);
    expect(calls.events.some((e) => e.type === 'bot_outcome_suppressed')).toBe(false);
    expect(calls.finalStatusWrites).toEqual(['closed']); // sendOutcome mock risolve { sent: true }
  });
});
