import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { shouldAutoReply, shouldReopen, nextUnansweredInboundIndex, lastIsUnansweredInbound, isOrphanedReplyingLock, REPLYING_ORPHAN_MS, canSendOutcome, drainMarioReplies, isLockStale, LOCK_TTL_MS, shouldSendGdoVideo } from './fenice-autoreply';

vi.mock('./mario', () => ({ generateMarioReply: vi.fn(), GDO_CONTEXT_NOTE: 'CONTESTO-GDO' }));
vi.mock('./twilio', () => ({ sendFreeText: vi.fn(async () => ({ sid: 'SM_fake', status: 'queued' })) }));
vi.mock('./bot-report', () => ({ generateBotReport: vi.fn(async () => ({})) }));
vi.mock('./bot-outcome', () => ({ sendOutcome: vi.fn(async () => ({ sent: true })) }));

import { generateMarioReply, GDO_CONTEXT_NOTE } from './mario';
import { sendOutcome } from './bot-outcome';
import { NOTA_VIDEO, NOTA_NOEMI } from './gdo-context-note';

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

describe('isLockStale: un lucchetto vecchio non blocca il bot per sempre', () => {
  const now = Date.UTC(2026, 6, 27, 12, 0, 0);

  it('nessun lucchetto: non e stale, e proprio libero', () => {
    expect(isLockStale(null, now)).toBe(false);
  });

  it('lucchetto preso adesso: non e stale', () => {
    expect(isLockStale(new Date(now - 1000).toISOString(), now)).toBe(false);
  });

  it('lucchetto di 9 minuti fa: non e ancora stale', () => {
    expect(isLockStale(new Date(now - 9 * 60_000).toISOString(), now)).toBe(false);
  });

  it('lucchetto di 11 minuti fa: e stale e va forzato', () => {
    expect(isLockStale(new Date(now - 11 * 60_000).toISOString(), now)).toBe(true);
  });

  it('rispetta un TTL passato esplicitamente', () => {
    expect(isLockStale(new Date(now - 2 * 60_000).toISOString(), now, 60_000)).toBe(true);
  });

  it('una data illeggibile e trattata come stale, non come lucchetto eterno', () => {
    expect(isLockStale('non-una-data', now)).toBe(true);
  });

  it('LOCK_TTL_MS e 10 minuti', () => {
    expect(LOCK_TTL_MS).toBe(10 * 60_000);
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

  it('non invia nulla senza lead CRM', () => {
    expect(canSendOutcome({ crmLeadId: null, aiStatus: 'active' })).toBe(false);
  });

  it('continua a bloccare su booked, che è un problema diverso', () => {
    expect(canSendOutcome({ crmLeadId: 'crm1', aiStatus: 'booked' })).toBe(false);
  });
});

type ClaimedRow = {
  id: number;
  ai_started_at: string | null;
  crm_lead_id: string | null;
  bot_outcome: string | null;
  gdo_agenda_at?: string | null;
  gdo_video_url?: string | null;
  gdo_video_sent_at?: string | null;
  gdo_video_watched_at?: string | null;
  gdo_video_followups_sent?: number | null;
  gdo_noemi_reminded_at?: string | null;
};
type FakeMsgRow = { direction: string; body: string; template_sid: string | null; created_at: string };

/**
 * Fake del client Supabase per drainMarioReplies: simula il claim CAS sul lucchetto
 * dedicato (`ai_lock_at`, ammesso solo su ai_status='active'), la history messaggi e
 * traccia gli insert su event_log/messages, l'update finale su ai_status e il
 * rilascio del lucchetto.
 */
function makeDrainSupabase(claimedRow: ClaimedRow, initialRows: FakeMsgRow[]) {
  const messagesRows = [...initialRows];
  const calls = { events: [] as any[], finalStatusWrites: [] as string[], messageInserts: [] as any[], lockReleases: [] as any[], convUpdates: [] as any[] };

  const supabase: any = {
    from(table: string) {
      if (table === 'conversations') {
        return {
          update(payload: any) {
            // Claim: valorizza solo il lucchetto, ai_status non viene toccato.
            if (payload.ai_lock_at && !('ai_status' in payload)) {
              let filterStatus: string | null = null;
              const stub: any = {
                eq(col: string, val: string) { if (col === 'ai_status') filterStatus = val; return stub; },
                or() { return stub; },
                select() { return stub; },
                single() { return Promise.resolve({ data: filterStatus === 'active' ? claimedRow : null }); },
              };
              return stub;
            }
            calls.convUpdates.push(payload);
            if ('ai_status' in payload) {
              calls.finalStatusWrites.push(payload.ai_status);
              // null = rilasciato; qualunque altro valore sarebbe un lucchetto lasciato appeso.
              calls.lockReleases.push(payload.ai_lock_at);
            }
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
    expect(calls.finalStatusWrites).toEqual(['closed']); // sendOutcome mock risolve { sent: true }
  });

  // La nota non e partita perche era gia partita: l'esito e terminale lo stesso, la
  // riga non deve restare 'active' in attesa che il cron la richiuda fino a un'ora dopo.
  it('nota duplicata: la conversazione viene comunque chiusa, non lasciata active', async () => {
    vi.mocked(sendOutcome).mockResolvedValueOnce({ sent: false, error: 'note_duplicate' });
    const claimedRow: ClaimedRow = { id: 44, ai_started_at: null, crm_lead_id: 'crm1', bot_outcome: 'APPUNTAMENTO' };
    const rows: FakeMsgRow[] = [
      OPENING,
      { direction: 'in', body: 'non ce la faccio piu, lasciamo stare', template_sid: null, created_at: '2026-07-25T09:00:00Z' },
    ];
    const { supabase, calls } = makeDrainSupabase(claimedRow, rows);
    vi.mocked(generateMarioReply).mockResolvedValueOnce({
      visibleReply: 'Mi dispiace, mi segno tutto e ti ricontatta una collega.',
      appointmentFixed: false, passToHuman: false, videoWatched: false,
      outcome: 'DA_SCARTARE', discardReason: 'ci ha ripensato',
    });

    await drainMarioReplies(supabase, 44, '+391234567890', () => 0);

    expect(calls.finalStatusWrites).toEqual(['closed']);
  });

  it('esito CRM davvero fallito: la conversazione resta active e ritentabile', async () => {
    vi.mocked(sendOutcome).mockResolvedValueOnce({ sent: false, error: 'http_500' });
    const claimedRow: ClaimedRow = { id: 45, ai_started_at: null, crm_lead_id: 'crm1', bot_outcome: null };
    const rows: FakeMsgRow[] = [
      OPENING,
      { direction: 'in', body: 'richiamatemi la prossima settimana', template_sid: null, created_at: '2026-07-25T09:00:00Z' },
    ];
    const { supabase, calls } = makeDrainSupabase(claimedRow, rows);
    vi.mocked(generateMarioReply).mockResolvedValueOnce({
      visibleReply: 'Va bene, ti richiamiamo.',
      appointmentFixed: false, passToHuman: false, videoWatched: false,
      outcome: 'RICHIAMO', scheduledAt: '2026-08-03T10:00:00+02:00',
    });

    await drainMarioReplies(supabase, 45, '+391234567890', () => 0);

    expect(calls.finalStatusWrites).toEqual(['active']);
  });

  it("la risposta di Mario viene registrata con sender 'bot'", async () => {
    const claimedRow: ClaimedRow = { id: 45, ai_started_at: null, crm_lead_id: 'crm1', bot_outcome: null };
    const rows: FakeMsgRow[] = [
      OPENING,
      { direction: 'in', body: 'mi interessa, come funziona?', template_sid: null, created_at: '2026-07-25T09:00:00Z' },
    ];
    const { supabase, calls } = makeDrainSupabase(claimedRow, rows);
    vi.mocked(generateMarioReply).mockResolvedValueOnce({
      visibleReply: 'Te lo spiego in due parole.',
      appointmentFixed: false, passToHuman: false, videoWatched: false,
    });

    await drainMarioReplies(supabase, 45, '+391234567890', () => 0);

    expect(calls.messageInserts.length).toBeGreaterThan(0);
    expect(calls.messageInserts.every((m) => m.sender === 'bot')).toBe(true);
  });

  it('la conferma di visione del video finisce anche su gdo_video_watched_at', async () => {
    const claimedRow: ClaimedRow = { id: 60, ai_started_at: null, crm_lead_id: 'crm1', bot_outcome: null };
    const rows: FakeMsgRow[] = [
      OPENING,
      { direction: 'in', body: 'FATTO, visto tutto', template_sid: null, created_at: '2026-07-25T09:00:00Z' },
    ];
    const { supabase, calls } = makeDrainSupabase(claimedRow, rows);
    vi.mocked(generateMarioReply).mockResolvedValueOnce({
      visibleReply: 'Perfetto, me lo segno.',
      appointmentFixed: false, passToHuman: false, videoWatched: true,
    });

    await drainMarioReplies(supabase, 60, '+391234567890', () => 0);

    expect(calls.convUpdates.some((u) => typeof u.gdo_video_watched_at === 'string')).toBe(true);
  });
});

describe('drainMarioReplies — il lucchetto viene sempre rilasciato', () => {
  beforeEach(() => {
    vi.stubEnv('TWILIO_WHATSAPP_NUMBER_FENICE', 'whatsapp:+390000000000');
    vi.mocked(generateMarioReply).mockReset();
    vi.mocked(sendOutcome).mockClear();
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  // Se il drain finisse senza azzerare ai_lock_at, la conversazione resterebbe
  // bloccata fino allo scadere del TTL: dieci minuti di silenzio del bot.
  it('a fine turno ai_lock_at torna null insieme allo stato finale', async () => {
    const claimedRow: ClaimedRow = { id: 77, ai_started_at: null, crm_lead_id: null, bot_outcome: null };
    const rows: FakeMsgRow[] = [
      { direction: 'out', body: 'apertura', template_sid: null, created_at: '2026-07-01T10:00:00Z' },
      { direction: 'in', body: 'ciao', template_sid: null, created_at: '2026-07-25T09:00:00Z' },
    ];
    const { supabase, calls } = makeDrainSupabase(claimedRow, rows);
    vi.mocked(generateMarioReply).mockResolvedValueOnce({
      visibleReply: 'Ciao! Come va?',
      appointmentFixed: false, passToHuman: false, videoWatched: false,
    });

    await drainMarioReplies(supabase, 77, '+391234567890', () => 0);

    expect(calls.lockReleases.length).toBeGreaterThan(0);
    expect(calls.lockReleases.every((v: any) => v === null)).toBe(true);
  });

  // Un secondo drain concorrente non deve poter entrare: il claim passa solo se
  // ai_status e 'active', quindi il fake restituisce null e la funzione esce subito.
  it('se il claim non passa, non tocca nulla', async () => {
    const claimedRow: ClaimedRow = { id: 78, ai_started_at: null, crm_lead_id: null, bot_outcome: null };
    const { supabase, calls } = makeDrainSupabase(claimedRow, []);
    // Nessun messaggio e claim che fallisce: la history non viene nemmeno caricata.
    const originale = supabase.from;
    supabase.from = (t: string) => {
      if (t !== 'conversations') return originale(t);
      return { update: () => ({
        eq(col: string, val: string) { return this; },
        or() { return this; },
        select() { return this; },
        single() { return Promise.resolve({ data: null }); },
      }) };
    };

    await drainMarioReplies(supabase, 78, '+391234567890', () => 0);

    expect(calls.finalStatusWrites).toEqual([]);
    expect(vi.mocked(generateMarioReply)).not.toHaveBeenCalled();
  });
});

describe('drainMarioReplies — link Fenice inventati dal modello', () => {
  const OPENING: FakeMsgRow = { direction: 'out', body: 'apertura', template_sid: null, created_at: '2026-07-01T10:00:00Z' };

  beforeEach(() => {
    vi.stubEnv('TWILIO_WHATSAPP_NUMBER_FENICE', 'whatsapp:+390000000000');
    vi.mocked(generateMarioReply).mockReset();
    vi.mocked(sendOutcome).mockClear();
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('registra a warn un link Fenice fuori dalla lista ufficiale, senza bloccare l invio', async () => {
    const claimedRow: ClaimedRow = { id: 60, ai_started_at: null, crm_lead_id: 'crm1', bot_outcome: null };
    const rows: FakeMsgRow[] = [
      OPENING,
      { direction: 'in', body: 'mandami il video', template_sid: null, created_at: '2026-07-25T09:00:00Z' },
    ];
    const { supabase, calls } = makeDrainSupabase(claimedRow, rows);
    vi.mocked(generateMarioReply).mockResolvedValueOnce({
      visibleReply: 'Eccolo https://corso.feniceacademy.it/conferenza-zx',
      appointmentFixed: false, passToHuman: false, videoWatched: false,
    });

    await drainMarioReplies(supabase, 60, '+391234567890', () => 0);

    const evento = calls.events.find((e: { type: string }) => e.type === 'unknown_fenice_link');
    expect(evento).toBeDefined();
    expect(evento.level).toBe('warn');
    expect(evento.payload).toMatchObject({ conversationId: 60, links: ['https://corso.feniceacademy.it/conferenza-zx'] });
    // Segnale diagnostico, non un filtro: il messaggio parte comunque.
    expect(calls.messageInserts).toHaveLength(1);
  });

  it('non registra nulla quando i link sono quelli ufficiali', async () => {
    const claimedRow: ClaimedRow = { id: 61, ai_started_at: null, crm_lead_id: 'crm1', bot_outcome: null };
    const rows: FakeMsgRow[] = [
      OPENING,
      { direction: 'in', body: 'mandami il video', template_sid: null, created_at: '2026-07-25T09:00:00Z' },
    ];
    const { supabase, calls } = makeDrainSupabase(claimedRow, rows);
    vi.mocked(generateMarioReply).mockResolvedValueOnce({
      visibleReply: 'Eccolo https://corso.feniceacademy.it/conferenza-bx',
      appointmentFixed: false, passToHuman: false, videoWatched: false,
    });

    await drainMarioReplies(supabase, 61, '+391234567890', () => 0);

    expect(calls.events.some((e: { type: string }) => e.type === 'unknown_fenice_link')).toBe(false);
  });
});

describe('drainMarioReplies — il blocco conferma si completa solo nel turno del video', () => {
  const VIDEO = 'https://corso.feniceacademy.it/conferenza-dx';
  const OPENING: FakeMsgRow = { direction: 'out', body: 'apertura', template_sid: null, created_at: '2026-07-01T10:00:00Z' };

  beforeEach(() => {
    vi.stubEnv('TWILIO_WHATSAPP_NUMBER_FENICE', 'whatsapp:+390000000000');
    vi.mocked(generateMarioReply).mockReset();
    vi.mocked(sendOutcome).mockClear();
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  // Caso reale: il blocco a 4 passaggi e gia uscito, sendOutcome ha chiuso la conv, il
  // lead ha risposto "lunedi alle 13", shouldReopen l'ha riportata ad 'active' e il
  // modello riconferma ri-emettendo il tag appuntamento. Senza guardia il lead si
  // vedrebbe arrivare il passaggio FATTO una seconda volta, staccato da ogni video.
  it('non ripete il passaggio FATTO quando il video e gia uscito in un turno precedente', async () => {
    const claimedRow: ClaimedRow = { id: 50, ai_started_at: null, crm_lead_id: 'crm1', bot_outcome: 'APPUNTAMENTO' };
    const rows: FakeMsgRow[] = [
      OPENING,
      { direction: 'out', body: `Sono 20 minuti, guardalo qui ${VIDEO}`, template_sid: null, created_at: '2026-07-25T09:00:00Z' },
      { direction: 'in', body: 'lunedì alle 13', template_sid: null, created_at: '2026-07-25T09:05:00Z' },
    ];
    const { supabase, calls } = makeDrainSupabase(claimedRow, rows);
    vi.mocked(generateMarioReply).mockResolvedValueOnce({
      visibleReply: 'Perfetto, confermato, ci vediamo lunedì alle 13',
      appointmentFixed: true, passToHuman: false, videoWatched: false,
    });

    await drainMarioReplies(supabase, 50, '+391234567890', () => 0);

    const inviati = calls.messageInserts.map((m: { body: string }) => m.body);
    expect(inviati).toEqual(['Perfetto, confermato, ci vediamo lunedì alle 13']);
    expect(inviati.join(' ')).not.toContain('FATTO');
    expect(calls.events.some((e: { type: string }) => e.type === 'confirmation_block_patched')).toBe(false);
  });

  // Il turno che manda davvero il video: la patch DEVE applicarsi.
  it('completa il blocco nel turno in cui il video esce per la prima volta', async () => {
    const claimedRow: ClaimedRow = { id: 51, ai_started_at: null, crm_lead_id: 'crm1', bot_outcome: null };
    const rows: FakeMsgRow[] = [
      OPENING,
      { direction: 'in', body: 'Noemi', template_sid: null, created_at: '2026-07-25T09:00:00Z' },
    ];
    const { supabase, calls } = makeDrainSupabase(claimedRow, rows);
    vi.mocked(generateMarioReply).mockResolvedValueOnce({
      visibleReply: `Perfetto, allora ci siamo\nNoemi ti chiama prima della call\n${VIDEO}`,
      appointmentFixed: true, passToHuman: false, videoWatched: false,
    });

    await drainMarioReplies(supabase, 51, '+391234567890', () => 0);

    const inviati = calls.messageInserts.map((m: { body: string }) => m.body);
    expect(inviati.join(' ')).toContain('FATTO');
    expect(calls.events.some((e: { type: string }) => e.type === 'confirmation_block_patched')).toBe(true);
    // Timeout largo: il drain mette una pausa "umana" (fino a 3s) fra una bolla e
    // l'altra e qui le bolle sono quattro.
  }, 20_000);
});

describe('shouldSendGdoVideo', () => {
  const base = { gdoAgendaAt: '2026-07-29T10:00:00Z', gdoVideoUrl: 'https://corso.feniceacademy.it/conferenza-bx', gdoVideoSentAt: null };

  it('lead del GDO che ha appena risposto e non ha ancora il video → sì', () => {
    expect(shouldSendGdoVideo(base)).toBe(true);
  });
  it('video già mandato → no, tocca a Mario rispondere', () => {
    expect(shouldSendGdoVideo({ ...base, gdoVideoSentAt: '2026-07-29T10:05:00Z' })).toBe(false);
  });
  it('conversazione normale (non postino) → no', () => {
    expect(shouldSendGdoVideo({ ...base, gdoAgendaAt: null })).toBe(false);
  });
  it('modalità postino senza link video → no (si segnala, non si inventa un link)', () => {
    expect(shouldSendGdoVideo({ ...base, gdoVideoUrl: null })).toBe(false);
  });
});

describe('drainMarioReplies — modalità postino (lead dei GDO)', () => {
  const VIDEO = 'https://corso.feniceacademy.it/conferenza-bx';
  const AGENDA: FakeMsgRow = { direction: 'out', body: 'Ciao Mario, sono Marta... il mio collega...', template_sid: 'HX_AGENDA_GDO', created_at: '2026-07-29T10:00:00Z' };
  const RISPOSTA: FakeMsgRow = { direction: 'in', body: 'ok', template_sid: null, created_at: '2026-07-29T10:02:00Z' };

  const postino = (over: Partial<ClaimedRow> = {}): ClaimedRow => ({
    id: 90, ai_started_at: null, crm_lead_id: 'gdo1', bot_outcome: null,
    gdo_agenda_at: '2026-07-29T10:00:00Z', gdo_video_url: VIDEO, gdo_video_sent_at: null,
    ...over,
  });

  beforeEach(() => {
    vi.stubEnv('TWILIO_WHATSAPP_NUMBER_FENICE', 'whatsapp:+390000000000');
    vi.mocked(generateMarioReply).mockReset();
    vi.mocked(sendOutcome).mockClear();
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('la prima risposta del lead riceve IL VIDEO, non una risposta del modello', async () => {
    const { supabase, calls } = makeDrainSupabase(postino(), [AGENDA, RISPOSTA]);

    await drainMarioReplies(supabase, 90, '+391234567890', () => 0);

    // Il video È la risposta a quel messaggio, non si aggiunge a un'altra.
    expect(generateMarioReply).not.toHaveBeenCalled();
    expect(calls.messageInserts).toHaveLength(1);
    expect(calls.messageInserts[0].body).toContain(VIDEO);
    expect(calls.messageInserts[0].body).toContain('FATTO');
    expect(calls.events.some((e: any) => e.type === 'gdo_video_sent')).toBe(true);
  });

  it('segna il video come inviato, così non riparte al messaggio dopo', async () => {
    const { supabase, calls } = makeDrainSupabase(postino(), [AGENDA, RISPOSTA]);

    await drainMarioReplies(supabase, 90, '+391234567890', () => 0);

    const marcato = calls.convUpdates.find((u: any) => u.gdo_video_sent_at);
    expect(marcato).toBeTruthy();
    expect(calls.finalStatusWrites).toEqual(['active']);
  });

  it('dal secondo messaggio in poi risponde Mario, sapendo che l’appuntamento c’è già', async () => {
    const rows: FakeMsgRow[] = [
      AGENDA, RISPOSTA,
      { direction: 'out', body: `ecco il video ${VIDEO}`, template_sid: null, created_at: '2026-07-29T10:03:00Z' },
      { direction: 'in', body: 'ma quanto costa?', template_sid: null, created_at: '2026-07-29T10:10:00Z' },
    ];
    const { supabase, calls } = makeDrainSupabase(postino({ gdo_video_sent_at: '2026-07-29T10:03:00Z' }), rows);
    vi.mocked(generateMarioReply).mockResolvedValueOnce({
      visibleReply: 'Te lo spiega il tutor in call 🙂',
      appointmentFixed: false, passToHuman: false, videoWatched: false,
    });

    await drainMarioReplies(supabase, 90, '+391234567890', () => 0);

    expect(generateMarioReply).toHaveBeenCalledTimes(1);
    // L'agenda l'ha firmata Marta: il lead non deve vedersi rispondere da un altro nome.
    // Il video è stato mandato ma non ancora confermato: la nota deve portare anche il
    // promemoria video vero e proprio, non solo il testo base — altrimenti uno scambio
    // fra gdoVideoSentAt e gdoVideoWatchedAt nel call-site passerebbe inosservato.
    expect(vi.mocked(generateMarioReply).mock.calls[0][1]).toMatchObject({
      contextNote: expect.stringContaining(GDO_CONTEXT_NOTE),
      personaName: 'Marta',
    });
    expect(vi.mocked(generateMarioReply).mock.calls[0][1]?.contextNote).toContain(NOTA_VIDEO);
    expect(calls.messageInserts.map((m: any) => m.body)).toEqual(['Te lo spiega il tutor in call 🙂']);
  });

  it('video già confermato: la nota non ripete il promemoria video (smaschera uno scambio sent/watched)', async () => {
    const rows: FakeMsgRow[] = [
      AGENDA, RISPOSTA,
      { direction: 'out', body: `ecco il video ${VIDEO}`, template_sid: null, created_at: '2026-07-29T10:03:00Z' },
      { direction: 'in', body: 'ma quanto costa?', template_sid: null, created_at: '2026-07-29T10:10:00Z' },
    ];
    const { supabase } = makeDrainSupabase(
      postino({ gdo_video_sent_at: '2026-07-29T10:03:00Z', gdo_video_watched_at: '2026-07-29T10:05:00Z' }),
      rows,
    );
    vi.mocked(generateMarioReply).mockResolvedValueOnce({
      visibleReply: 'Te lo spiega il tutor in call 🙂',
      appointmentFixed: false, passToHuman: false, videoWatched: false,
    });

    await drainMarioReplies(supabase, 90, '+391234567890', () => 0);

    expect(vi.mocked(generateMarioReply).mock.calls[0][1]?.contextNote).not.toContain(NOTA_VIDEO);
  });

  it('un esito del modello diventa una NOTA e non chiude la conversazione: il lead è del GDO', async () => {
    const rows: FakeMsgRow[] = [
      AGENDA, RISPOSTA,
      { direction: 'out', body: `ecco il video ${VIDEO}`, template_sid: null, created_at: '2026-07-29T10:03:00Z' },
      { direction: 'in', body: 'non ce la faccio più, lasciamo stare', template_sid: null, created_at: '2026-07-29T10:10:00Z' },
    ];
    const { supabase, calls } = makeDrainSupabase(postino({ gdo_video_sent_at: '2026-07-29T10:03:00Z' }), rows);
    vi.mocked(generateMarioReply).mockResolvedValueOnce({
      visibleReply: 'Mi dispiace, mi segno tutto e ti ricontatta una collega.',
      appointmentFixed: false, passToHuman: false, videoWatched: false,
      outcome: 'DA_SCARTARE', discardReason: 'ci ha ripensato',
    });

    await drainMarioReplies(supabase, 90, '+391234567890', () => 0);

    expect(sendOutcome).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendOutcome).mock.calls[0][3]).toEqual({ noteOnly: true });
    // Niente chiusura: il bot resta il canale del GDO su questa chat.
    expect(calls.finalStatusWrites).toEqual(['active']);
  });

  it('un appuntamento riconfermato non congela la conversazione su booked', async () => {
    const rows: FakeMsgRow[] = [
      AGENDA, RISPOSTA,
      { direction: 'out', body: `ecco il video ${VIDEO}`, template_sid: null, created_at: '2026-07-29T10:03:00Z' },
      { direction: 'in', body: 'confermo giovedì alle 15', template_sid: null, created_at: '2026-07-29T10:10:00Z' },
    ];
    const { supabase, calls } = makeDrainSupabase(postino({ gdo_video_sent_at: '2026-07-29T10:03:00Z' }), rows);
    vi.mocked(generateMarioReply).mockResolvedValueOnce({
      visibleReply: 'Perfetto, confermato 🙂',
      appointmentFixed: true, passToHuman: false, videoWatched: false,
    });

    await drainMarioReplies(supabase, 90, '+391234567890', () => 0);

    // 'booked' non è claimabile: il postino resterebbe muto ai messaggi successivi.
    expect(calls.finalStatusWrites).toEqual(['active']);
  });

  it('se il lead chiede una persona il passaggio umano funziona come sempre', async () => {
    const rows: FakeMsgRow[] = [
      AGENDA, RISPOSTA,
      { direction: 'out', body: `ecco il video ${VIDEO}`, template_sid: null, created_at: '2026-07-29T10:03:00Z' },
      { direction: 'in', body: 'voglio parlare con una persona', template_sid: null, created_at: '2026-07-29T10:10:00Z' },
    ];
    const { supabase, calls } = makeDrainSupabase(postino({ gdo_video_sent_at: '2026-07-29T10:03:00Z' }), rows);
    vi.mocked(generateMarioReply).mockResolvedValueOnce({
      visibleReply: 'Certo, ti faccio ricontattare da una collega.',
      appointmentFixed: false, passToHuman: true, videoWatched: false,
    });

    await drainMarioReplies(supabase, 90, '+391234567890', () => 0);

    expect(calls.finalStatusWrites).toEqual(['handed_off']);
  });

  it('marca gdo_noemi_reminded_at solo se la risposta nomina davvero Noemi', async () => {
    const claimedRow: ClaimedRow = {
      id: 61, ai_started_at: null, crm_lead_id: 'crm1', bot_outcome: null,
      gdo_agenda_at: '2026-08-01T14:00:00Z', gdo_video_url: 'https://corso.feniceacademy.it/conferenza-bx',
      gdo_video_sent_at: '2026-08-01T15:00:00Z',
      // Un sollecito è già partito: la nota di Noemi è dovuta (serveNoemi in
      // gdo-context-note.ts), così la contextNote la porta davvero e non solo
      // il testo base — copre il mapping followupsSent nel call-site.
      gdo_video_followups_sent: 1,
    };
    const rows: FakeMsgRow[] = [
      AGENDA,
      { direction: 'in', body: 'sì l\'ho visto', template_sid: null, created_at: '2026-08-01T18:00:00Z' },
    ];
    const { supabase, calls } = makeDrainSupabase(claimedRow, rows);
    vi.mocked(generateMarioReply).mockResolvedValueOnce({
      visibleReply: 'Perfetto. Ti ricordo che prima della call ti chiama Noemi, sono 5-10 minuti.',
      appointmentFixed: false, passToHuman: false, videoWatched: true,
    });

    await drainMarioReplies(supabase, 61, '+391234567890', () => 0);

    expect(vi.mocked(generateMarioReply).mock.calls[0][1]?.contextNote).toContain(NOTA_NOEMI);
    expect(calls.convUpdates.some((u) => typeof u.gdo_noemi_reminded_at === 'string')).toBe(true);
  });

  it('non marca Noemi se il modello non l\'ha nominata', async () => {
    const claimedRow: ClaimedRow = {
      id: 62, ai_started_at: null, crm_lead_id: 'crm1', bot_outcome: null,
      gdo_agenda_at: '2026-08-01T14:00:00Z', gdo_video_url: 'https://corso.feniceacademy.it/conferenza-bx',
      gdo_video_sent_at: '2026-08-01T15:00:00Z',
    };
    const rows: FakeMsgRow[] = [
      AGENDA,
      { direction: 'in', body: 'ok grazie', template_sid: null, created_at: '2026-08-01T18:00:00Z' },
    ];
    const { supabase, calls } = makeDrainSupabase(claimedRow, rows);
    vi.mocked(generateMarioReply).mockResolvedValueOnce({
      visibleReply: 'Figurati, a presto.',
      appointmentFixed: false, passToHuman: false, videoWatched: false,
    });

    await drainMarioReplies(supabase, 62, '+391234567890', () => 0);

    expect(calls.convUpdates.some((u) => 'gdo_noemi_reminded_at' in u)).toBe(false);
  });

  it('il lead conferma il video prima di qualunque sollecito: si rigenera per infilarci Noemi e si manda SOLO quella risposta', async () => {
    const claimedRow: ClaimedRow = {
      id: 63, ai_started_at: null, crm_lead_id: 'crm1', bot_outcome: null,
      gdo_agenda_at: '2026-08-01T14:00:00Z', gdo_video_url: 'https://corso.feniceacademy.it/conferenza-bx',
      gdo_video_sent_at: '2026-08-01T15:00:00Z',
      // gdo_video_followups_sent resta a 0 (default): il lead risponde prima che
      // parta il primo sollecito. Senza la rigenerazione, serveNoemi non
      // scatterebbe mai per questo lead, da nessuno dei due canali.
    };
    const rows: FakeMsgRow[] = [
      AGENDA,
      { direction: 'in', body: 'l\'ho visto tutto', template_sid: null, created_at: '2026-08-01T18:00:00Z' },
    ];
    const { supabase, calls } = makeDrainSupabase(claimedRow, rows);
    vi.mocked(generateMarioReply)
      .mockResolvedValueOnce({
        visibleReply: 'Perfetto, ottimo.',
        appointmentFixed: false, passToHuman: false, videoWatched: true,
      })
      .mockResolvedValueOnce({
        visibleReply: 'Perfetto! Ti ricordo che prima della call ti chiama Noemi, sono 5-10 minuti.',
        appointmentFixed: false, passToHuman: false, videoWatched: false,
      });

    await drainMarioReplies(supabase, 63, '+391234567890', () => 0);

    expect(generateMarioReply).toHaveBeenCalledTimes(2);
    expect(vi.mocked(generateMarioReply).mock.calls[1][1]?.contextNote).toContain(NOTA_NOEMI);
    // Una bolla sola al lead: quella del secondo giro, non la somma dei due.
    expect(calls.messageInserts).toHaveLength(1);
    expect(calls.messageInserts[0].body).toBe('Perfetto! Ti ricordo che prima della call ti chiama Noemi, sono 5-10 minuti.');
    expect(calls.convUpdates.some((u) => typeof u.gdo_video_watched_at === 'string')).toBe(true);
    expect(calls.convUpdates.some((u) => typeof u.gdo_noemi_reminded_at === 'string')).toBe(true);
  });

  it('Noemi è già stata spiegata: la conferma del video non fa scattare una seconda chiamata al modello', async () => {
    const claimedRow: ClaimedRow = {
      id: 64, ai_started_at: null, crm_lead_id: 'crm1', bot_outcome: null,
      gdo_agenda_at: '2026-08-01T14:00:00Z', gdo_video_url: 'https://corso.feniceacademy.it/conferenza-bx',
      gdo_video_sent_at: '2026-08-01T15:00:00Z',
      gdo_noemi_reminded_at: '2026-08-01T16:00:00Z',
    };
    const rows: FakeMsgRow[] = [
      AGENDA,
      { direction: 'in', body: 'l\'ho visto tutto', template_sid: null, created_at: '2026-08-01T18:00:00Z' },
    ];
    const { supabase, calls } = makeDrainSupabase(claimedRow, rows);
    vi.mocked(generateMarioReply).mockResolvedValueOnce({
      visibleReply: 'Perfetto, ottimo.',
      appointmentFixed: false, passToHuman: false, videoWatched: true,
    });

    await drainMarioReplies(supabase, 64, '+391234567890', () => 0);

    expect(generateMarioReply).toHaveBeenCalledTimes(1);
    expect(calls.messageInserts).toHaveLength(1);
    expect(calls.messageInserts[0].body).toBe('Perfetto, ottimo.');
    expect(calls.convUpdates.some((u) => typeof u.gdo_video_watched_at === 'string')).toBe(true);
  });

  it('video visto E esito nello stesso turno: nessuna rigenerazione, vince la risposta all\'esito', async () => {
    // "L'ho visto, ma voglio annullare": la NOTA_NOEMI del secondo giro ("diglielo
    // adesso") sostituirebbe la risposta giusta con un promemoria della preselezione,
    // mentre al CRM parte la nota di disdetta.
    const claimedRow: ClaimedRow = {
      id: 67, ai_started_at: null, crm_lead_id: 'crm1', bot_outcome: null,
      gdo_agenda_at: '2026-08-01T14:00:00Z', gdo_video_url: 'https://corso.feniceacademy.it/conferenza-bx',
      gdo_video_sent_at: '2026-08-01T15:00:00Z',
      gdo_video_followups_sent: 1,
    };
    const rows: FakeMsgRow[] = [
      AGENDA,
      { direction: 'in', body: 'l\'ho visto ma voglio annullare tutto', template_sid: null, created_at: '2026-08-01T18:00:00Z' },
    ];
    const { supabase, calls } = makeDrainSupabase(claimedRow, rows);
    vi.mocked(generateMarioReply).mockResolvedValueOnce({
      visibleReply: 'Va bene, avviso il collega e annullo.',
      appointmentFixed: false, passToHuman: false, videoWatched: true,
      outcome: 'INTERROTTO', note: 'il lead vuole annullare',
    });

    await drainMarioReplies(supabase, 67, '+391234567890', () => 0);

    expect(generateMarioReply).toHaveBeenCalledTimes(1);
    expect(calls.messageInserts).toHaveLength(1);
    expect(calls.messageInserts[0].body).toBe('Va bene, avviso il collega e annullo.');
    expect(calls.convUpdates.some((u) => typeof u.gdo_noemi_reminded_at === 'string')).toBe(false);
  });

  it('video visto E passaggio umano nello stesso turno: nessuna rigenerazione', async () => {
    const claimedRow: ClaimedRow = {
      id: 68, ai_started_at: null, crm_lead_id: 'crm1', bot_outcome: null,
      gdo_agenda_at: '2026-08-01T14:00:00Z', gdo_video_url: 'https://corso.feniceacademy.it/conferenza-bx',
      gdo_video_sent_at: '2026-08-01T15:00:00Z',
      gdo_video_followups_sent: 1,
    };
    const rows: FakeMsgRow[] = [
      AGENDA,
      { direction: 'in', body: 'l\'ho visto, ma voglio parlare con una persona', template_sid: null, created_at: '2026-08-01T18:00:00Z' },
    ];
    const { supabase, calls } = makeDrainSupabase(claimedRow, rows);
    vi.mocked(generateMarioReply).mockResolvedValueOnce({
      visibleReply: 'Certo, ti faccio ricontattare da una collega.',
      appointmentFixed: false, passToHuman: true, videoWatched: true,
    });

    await drainMarioReplies(supabase, 68, '+391234567890', () => 0);

    expect(generateMarioReply).toHaveBeenCalledTimes(1);
    expect(calls.finalStatusWrites).toEqual(['handed_off']);
    expect(calls.convUpdates.some((u) => typeof u.gdo_noemi_reminded_at === 'string')).toBe(false);
  });

  it('la rigenerazione per Noemi fallisce con un eccezione: si manda comunque la prima risposta, nessuna perdita', async () => {
    const claimedRow: ClaimedRow = {
      id: 65, ai_started_at: null, crm_lead_id: 'crm1', bot_outcome: null,
      gdo_agenda_at: '2026-08-01T14:00:00Z', gdo_video_url: 'https://corso.feniceacademy.it/conferenza-bx',
      gdo_video_sent_at: '2026-08-01T15:00:00Z',
    };
    const rows: FakeMsgRow[] = [
      AGENDA,
      { direction: 'in', body: 'l\'ho visto tutto', template_sid: null, created_at: '2026-08-01T18:00:00Z' },
    ];
    const { supabase, calls } = makeDrainSupabase(claimedRow, rows);
    vi.mocked(generateMarioReply)
      .mockResolvedValueOnce({
        visibleReply: 'Perfetto, ottimo.',
        appointmentFixed: false, passToHuman: false, videoWatched: true,
      })
      .mockRejectedValueOnce(new Error('529 overloaded'));

    await drainMarioReplies(supabase, 65, '+391234567890', () => 0);

    expect(generateMarioReply).toHaveBeenCalledTimes(2);
    expect(calls.messageInserts).toHaveLength(1);
    expect(calls.messageInserts[0].body).toBe('Perfetto, ottimo.');
    expect(calls.convUpdates.some((u) => typeof u.gdo_video_watched_at === 'string')).toBe(true);
    expect(calls.events.some((e: { type: string }) => e.type === 'gdo_noemi_regen_failed')).toBe(true);
  });

  it('la rigenerazione per Noemi torna una risposta vuota: si manda comunque la prima', async () => {
    const claimedRow: ClaimedRow = {
      id: 66, ai_started_at: null, crm_lead_id: 'crm1', bot_outcome: null,
      gdo_agenda_at: '2026-08-01T14:00:00Z', gdo_video_url: 'https://corso.feniceacademy.it/conferenza-bx',
      gdo_video_sent_at: '2026-08-01T15:00:00Z',
    };
    const rows: FakeMsgRow[] = [
      AGENDA,
      { direction: 'in', body: 'l\'ho visto tutto', template_sid: null, created_at: '2026-08-01T18:00:00Z' },
    ];
    const { supabase, calls } = makeDrainSupabase(claimedRow, rows);
    vi.mocked(generateMarioReply)
      .mockResolvedValueOnce({
        visibleReply: 'Perfetto, ottimo.',
        appointmentFixed: false, passToHuman: false, videoWatched: true,
      })
      .mockResolvedValueOnce({
        visibleReply: '   ',
        appointmentFixed: false, passToHuman: false, videoWatched: false,
      });

    await drainMarioReplies(supabase, 66, '+391234567890', () => 0);

    expect(generateMarioReply).toHaveBeenCalledTimes(2);
    expect(calls.messageInserts).toHaveLength(1);
    expect(calls.messageInserts[0].body).toBe('Perfetto, ottimo.');
    expect(calls.convUpdates.some((u) => typeof u.gdo_video_watched_at === 'string')).toBe(true);
  });

  it('modalità postino senza link video: lo segnala e lascia rispondere Mario, niente silenzio', async () => {
    const { supabase, calls } = makeDrainSupabase(postino({ gdo_video_url: null }), [AGENDA, RISPOSTA]);
    vi.mocked(generateMarioReply).mockResolvedValueOnce({
      visibleReply: 'Ciao! Ti mando tutto tra poco.',
      appointmentFixed: false, passToHuman: false, videoWatched: false,
    });

    await drainMarioReplies(supabase, 90, '+391234567890', () => 0);

    expect(calls.events.some((e: any) => e.type === 'gdo_video_missing' && e.level === 'error')).toBe(true);
    expect(generateMarioReply).toHaveBeenCalledTimes(1);
  });

  it('una conversazione normale non è toccata: nessun video, risposta del modello senza contesto GDO', async () => {
    const rows: FakeMsgRow[] = [
      { direction: 'out', body: 'apertura', template_sid: null, created_at: '2026-07-01T10:00:00Z' },
      { direction: 'in', body: 'ciao', template_sid: null, created_at: '2026-07-25T09:00:00Z' },
    ];
    const { supabase, calls } = makeDrainSupabase(
      { id: 91, ai_started_at: null, crm_lead_id: 'crm1', bot_outcome: null, gdo_agenda_at: null, gdo_video_url: null, gdo_video_sent_at: null },
      rows,
    );
    vi.mocked(generateMarioReply).mockResolvedValueOnce({
      visibleReply: 'Ciao! Come va?', appointmentFixed: false, passToHuman: false, videoWatched: false,
    });

    await drainMarioReplies(supabase, 91, '+391234567890', () => 0);

    expect(generateMarioReply).toHaveBeenCalledTimes(1);
    expect(vi.mocked(generateMarioReply).mock.calls[0][1]?.contextNote).toBeUndefined();
    expect(calls.events.some((e: any) => e.type === 'gdo_video_sent')).toBe(false);
  });
});
