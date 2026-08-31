import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { decideAgendaFollowup, agendaFollowupText, AGENDA_FOLLOWUP_DELAY_MS, runAgendaFollowups } from './agenda-followup';
import { sendFreeText } from './twilio';

const H = 3600_000;
const base = {
  agendaSentAtMs: 0,
  nowMs: 3 * H,            // 3h dopo l'agenda
  terminal: false,
  followupAlreadySent: false,
  lastInboundAtMs: 2.5 * H, // inbound recente → finestra 24h aperta
  lastMessageIsInbound: false,
  romeHour: 15,             // orario buono
  gdoPostino: false,        // conversazione normale, non un lead del GDO
};

describe('decideAgendaFollowup', () => {
  it('manda quando: ≥2h, non preso, mai inviato, finestra aperta, orario ok', () => {
    expect(decideAgendaFollowup(base)).toBe('send');
  });
  it('niente se agenda inviata da meno di 2h', () => {
    expect(decideAgendaFollowup({ ...base, nowMs: 1 * H })).toBe('none');
  });
  it('niente se la conversazione ha un esito terminale (preso/scartato/interrotto)', () => {
    expect(decideAgendaFollowup({ ...base, terminal: true })).toBe('none');
  });
  it('niente se il follow-up è già stato inviato', () => {
    expect(decideAgendaFollowup({ ...base, followupAlreadySent: true })).toBe('none');
  });
  it('niente se non c\'è alcun inbound (finestra non apribile)', () => {
    expect(decideAgendaFollowup({ ...base, lastInboundAtMs: null })).toBe('none');
  });
  it('niente se l\'ultimo inbound è oltre 24h fa (finestra chiusa)', () => {
    expect(decideAgendaFollowup({ ...base, nowMs: 30 * H, lastInboundAtMs: 2.5 * H })).toBe('none');
  });
  it('niente di notte (prima delle 9)', () => {
    expect(decideAgendaFollowup({ ...base, romeHour: 7 })).toBe('none');
  });
  it('niente a tarda sera (dalle 21 in poi)', () => {
    expect(decideAgendaFollowup({ ...base, romeHour: 21 })).toBe('none');
  });
  it('niente se l\'ultimo messaggio è un inbound non ancora risposto (lo gestisce il backstop)', () => {
    expect(decideAgendaFollowup({ ...base, lastMessageIsInbound: true })).toBe('none');
  });
  it('la costante di ritardo è 2h', () => {
    expect(AGENDA_FOLLOWUP_DELAY_MS).toBe(2 * H);
  });
});

describe('decideAgendaFollowup — lead dei GDO', () => {
  // Il link di prenotazione è LO STESSO del bot: senza questa guardia il follow-up
  // "non ho ancora visto la conferma" arriverebbe a chi ha appena preso l'appuntamento
  // al telefono col commerciale. È esattamente ciò che il CRM ci ha chiesto di evitare.
  it('mai il follow-up "prenota" a un lead che ha già l’appuntamento col GDO', () => {
    expect(decideAgendaFollowup({ ...base, gdoPostino: true })).toBe('none');
  });
});

describe('agendaFollowupText', () => {
  it('interpola il nome del lead', () => {
    expect(agendaFollowupText('Luca')).toContain('Luca');
    expect(agendaFollowupText('Luca')).toContain('slot');
  });
  it('funziona anche senza nome', () => {
    const t = agendaFollowupText(null);
    expect(t.length).toBeGreaterThan(0);
    expect(t).not.toContain('null');
  });
  it('usa solo il nome quando dal CRM arriva anche il cognome', () => {
    const t = agendaFollowupText('LUCA VERDI');
    expect(t).toContain('Ciao Luca');
    expect(t).not.toContain('VERDI');
  });
});

// --- giro completo di runAgendaFollowups: da quale numero esce il follow-up ---

vi.mock('./twilio', () => ({ sendFreeText: vi.fn(async () => ({ sid: 'SM_fake', status: 'queued' })) }));

/**
 * Fake Supabase per runAgendaFollowups: una sola conversazione candidata, con
 * l'agenda mandata 3h fa e un inbound recente (finestra 24h aperta).
 */
function makeFollowupSupabase(conv: Record<string, unknown>) {
  const oraMs = Date.parse('2026-08-31T12:00:00Z');
  const agendaAt = new Date(oraMs - 3 * 3600_000).toISOString();
  const inboundAt = new Date(oraMs - 2 * 3600_000).toISOString();
  const inseriti: any[] = [];

  const supabase: any = {
    from(table: string) {
      if (table === 'messages') {
        const q: any = {
          _conv: false, _dir: null as string | null,
          select(cols: string) { q._cols = cols; return q; },
          eq(col: string, val: any) { if (col === 'conversation_id') q._conv = true; if (col === 'direction') q._dir = val; return q; },
          ilike() { return q; }, not() { return q; }, lte() { return q; }, gte() { return q; },
          order() { return q; },
          limit() {
            // per-conversazione: ultimo inbound / ultimo messaggio
            if (q._dir === 'in') return Promise.resolve({ data: [{ created_at: inboundAt }] });
            return Promise.resolve({ data: [{ direction: 'out' }] });
          },
          insert(row: any) { inseriti.push(row); return Promise.resolve({}); },
          then(res: any) { res({ data: [{ conversation_id: conv.id, created_at: agendaAt }] }); },
        };
        return q;
      }
      if (table === 'conversations') {
        return {
          select() { return { in: async () => ({ data: [conv] }) }; },
          update() { return { eq: async () => ({}) }; },
        };
      }
      if (table === 'leads') {
        return { select() { return { in: async () => ({ data: [{ id: 1, phone_e164: '+393331234567', first_name: 'Anna' }] }) }; } };
      }
      return { insert: async () => ({}) };
    },
  };
  return { supabase, inseriti };
}

describe('runAgendaFollowups — numero mittente', () => {
  beforeEach(() => {
    vi.stubEnv('TWILIO_WHATSAPP_NUMBER_FENICE', 'whatsapp:+390000000000');
    vi.mocked(sendFreeText).mockClear();
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  const convBase = { id: 42, lead_id: 1, ai_status: 'active', bot_outcome: null, bot_followups_sent: 0, gdo_agenda_at: null };

  it('manda il follow-up dal numero della conversazione', async () => {
    const { supabase } = makeFollowupSupabase({ ...convBase, wa_number: 'whatsapp:+391111111111' });

    const res = await runAgendaFollowups(supabase, new Date('2026-08-31T12:00:00Z'));

    expect(res.sent).toBe(1);
    expect(vi.mocked(sendFreeText).mock.calls[0][0]).toMatchObject({ from: 'whatsapp:+391111111111' });
  });

  it('senza numero salvato usa il primario', async () => {
    const { supabase } = makeFollowupSupabase({ ...convBase, wa_number: null });

    const res = await runAgendaFollowups(supabase, new Date('2026-08-31T12:00:00Z'));

    expect(res.sent).toBe(1);
    expect(vi.mocked(sendFreeText).mock.calls[0][0]).toMatchObject({ from: 'whatsapp:+390000000000' });
  });
});
