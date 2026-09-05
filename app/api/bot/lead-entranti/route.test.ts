import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Finto Supabase, ridotto a quello che questa rotta chiede: la pagina di
 * `conversations` (letta da `fetchAllRows`, quindi con `.range()`) e il primo messaggio
 * in ingresso di ogni conversazione.
 */
const righe = {
  conversazioni: [] as Record<string, unknown>[],
  primoInbound: 'ciao' as string | null,
  /** Gli outbound PARTITI, per `botHaRisposto`: id delle conversazioni che li hanno. */
  outboundPartiti: [] as number[],
};

function query(table: string) {
  const q: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'is', 'not', 'order', 'gte', 'lte', 'in']) q[m] = () => q;
  q.limit = () => Promise.resolve({
    data: [{ body: righe.primoInbound, created_at: '2026-09-01T10:00:00Z' }],
  });
  q.range = () => Promise.resolve({
    data: table === 'conversations'
      ? righe.conversazioni
      // `messages` letta con `.range()` = la query degli outbound partiti.
      : righe.outboundPartiti.map((id, i) => ({ id: i + 1, conversation_id: id })),
    error: null,
  });
  q.insert = () => Promise.resolve({});
  return q;
}

vi.mock('@/lib/supabase/admin', () => ({
  getSupabaseAdmin: () => ({ from: (table: string) => query(table) }),
}));

import { POST } from './route';
import { signPayload } from '@/lib/bot-hmac';

const SEGRETO = 'segreto-di-test';

async function chiedi(corpo: unknown = {}) {
  const body = JSON.stringify(corpo);
  const res = await POST(new Request('https://x/api/bot/lead-entranti', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bot-signature': signPayload(body, SEGRETO) },
    body,
  }) as never);
  return res.json() as Promise<{ ok: boolean; totale: number; totaleCompleto: number; lead: Record<string, unknown>[] }>;
}

function conversazione(extra: Record<string, unknown>) {
  return {
    id: 7246,
    crm_funnel: 'TELEGRAM',
    ai_status: 'closed',
    bot_outcome: null,
    bot_scheduled_at: null,
    ai_started_at: '2026-09-01T09:00:00Z',
    last_message_at: '2026-09-01T11:00:00Z',
    leads: { phone_e164: '+393331234567', first_name: null, last_name: null },
    ...extra,
  };
}

beforeEach(() => {
  vi.stubEnv('BOT_WEBHOOK_SECRET', SEGRETO);
  vi.stubEnv('TWILIO_WHATSAPP_NUMBER_FENICE', 'whatsapp:+390000000000');
  righe.conversazioni = [];
  righe.primoInbound = 'Buongiorno, sono nel canale Telegram';
  righe.outboundPartiti = [];
});
afterEach(() => { vi.unstubAllEnvs(); });

describe('/api/bot/lead-entranti — il campo appuntamento', () => {
  // `bot_scheduled_at` porta la data di QUALUNQUE esito con un quando, RICHIAMO
  // compreso: nel documento mandato al CRM `appuntamento` significa "ha gia' una call
  // in agenda", e consegnare li' la data di un richiamo la manderebbe alle Conferme
  // come un appuntamento che non esiste.
  it('la data di un RICHIAMO non esce come appuntamento', async () => {
    righe.conversazioni = [conversazione({
      bot_outcome: 'RICHIAMO', bot_scheduled_at: '2026-09-20T10:00:00+02:00',
    })];

    const body = await chiedi();

    expect(body.lead[0].esito).toBe('RICHIAMO');
    expect(body.lead[0].appuntamento).toBeNull();
  });

  it('la data di un APPUNTAMENTO esce eccome: e\' quella che al CRM serve di piu\'', async () => {
    righe.conversazioni = [conversazione({
      bot_outcome: 'APPUNTAMENTO', bot_scheduled_at: '2026-09-10T15:00:00+02:00',
    })];

    const body = await chiedi();

    expect(body.lead[0].esito).toBe('APPUNTAMENTO');
    expect(body.lead[0].appuntamento).toBe('2026-09-10T15:00:00+02:00');
  });

  it('un lead ancora in corso esce senza esito e senza data', async () => {
    righe.conversazioni = [conversazione({ ai_status: 'active' })];

    const body = await chiedi();

    expect(body.lead[0]).toMatchObject({ esito: null, appuntamento: null, statoBot: 'active' });
    expect(body.lead[0].provenienza).toBe('TELEGRAM');
  });

  // `totale` e' quanti ne sono usciti, `totaleCompleto` quanti ce ne sono: senza il
  // secondo il CRM non sa che la lista e' tagliata dal suo stesso `limit`.
  it('il totale completo dice quanti ce ne sono davvero, anche a lista tagliata', async () => {
    righe.conversazioni = [
      conversazione({ id: 1 }), conversazione({ id: 2 }), conversazione({ id: 3 }),
    ];

    const body = await chiedi({ limit: 2 });

    expect(body.totale).toBe(2);
    expect(body.totaleCompleto).toBe(3);
  });
});

describe('botHaRisposto', () => {
  // La finestra fra l'adozione e la prima risposta: li' la guardia di
  // `apreSopraChatViva` non scatta, perche' vuole un outbound partito. Un intake mandato
  // in quel momento farebbe cadere "Ciao, sono Marta..." sopra un lead che aspetta ancora
  // la risposta alla sua domanda. Di norma dura qualche decina di secondi, ma se il drain
  // fallisce non si chiude da sola.
  it("falso finche' il bot non ha ancora scritto", async () => {
    righe.conversazioni = [conversazione({ ai_status: 'active' })];
    righe.outboundPartiti = [];
    const r = await chiedi();
    expect(r.lead[0].botHaRisposto).toBe(false);
  });

  it("vero appena un messaggio del bot e' partito", async () => {
    righe.conversazioni = [conversazione({ ai_status: 'active' })];
    righe.outboundPartiti = [7246];
    const r = await chiedi();
    expect(r.lead[0].botHaRisposto).toBe(true);
  });

  it('distingue conversazione per conversazione', async () => {
    righe.conversazioni = [conversazione({ id: 7246 }), conversazione({ id: 7300 })];
    righe.outboundPartiti = [7300];
    const r = await chiedi();
    const perId = Object.fromEntries(r.lead.map((l) => [l.conversationId as number, l.botHaRisposto]));
    expect(perId[7246]).toBe(false);
    expect(perId[7300]).toBe(true);
  });
});
