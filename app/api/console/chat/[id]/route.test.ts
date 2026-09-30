import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

type Filtro = [string, string, unknown];

const stato = {
  admin: { ok: true, email: 'admin@fenice.com' } as
    | { ok: true; email: string }
    | { ok: false; risposta: Response },
  nelPerimetro: true,
  conv: null as Record<string, unknown> | null,
  crm: null as Record<string, unknown> | null,
  eventi: [] as Record<string, unknown>[],
  eventiErrore: null as null | 'errore' | 'eccezione',
  segnali: 0,
  query: [] as { tabella: string; colonne?: string; filtri: Filtro[]; limite?: number; ordine?: [string, unknown] }[],
  conErrori: [] as number[],
};

/** Query builder finto: registra i filtri e risolve con i dati della tabella. */
function builder(tabella: string) {
  const q = { tabella, colonne: undefined as string | undefined, filtri: [] as Filtro[], limite: undefined as number | undefined, ordine: undefined as [string, unknown] | undefined };
  stato.query.push(q);
  const risultato = () => {
    if (tabella === 'conversations') return { data: stato.conv, error: null };
    if (tabella === 'crm_lead_status') return { data: stato.crm, error: null };
    if (stato.eventiErrore === 'errore') return { data: null, error: { message: 'canceling statement due to statement timeout' } };
    return { data: stato.eventi, error: null };
  };
  const b: Record<string, unknown> = {
    select: (c: string) => ((q.colonne = c), b),
    eq: (c: string, v: unknown) => (q.filtri.push(['eq', c, v]), b),
    in: (c: string, v: unknown) => (q.filtri.push(['in', c, v]), b),
    gte: (c: string, v: unknown) => (q.filtri.push(['gte', c, v]), b),
    order: (c: string, o: unknown) => ((q.ordine = [c, o]), b),
    limit: (n: number) => ((q.limite = n), b),
    abortSignal: (sg: AbortSignal) => ((stato.segnali += sg instanceof AbortSignal ? 1 : 0), b),
    maybeSingle: async () => risultato(),
    then: (ok: (x: unknown) => unknown, ko?: (e: unknown) => unknown) =>
      (tabella === 'event_log' && stato.eventiErrore === 'eccezione' ? Promise.reject(new Error('aborted')) : Promise.resolve(risultato())).then(ok, ko),
  };
  return b;
}

vi.mock('@/lib/supabase/admin', () => ({ getSupabaseAdmin: () => ({ from: builder }) }));
vi.mock('@/lib/console/viste-db', () => ({ idsConErrori: async () => stato.conErrori }));
vi.mock('@/lib/console/guardia', () => ({ richiediAdmin: async () => stato.admin }));
vi.mock('@/lib/chat-perimetro', async (orig) => ({
  ...(await orig<typeof import('@/lib/chat-perimetro')>()),
  isConversazioneChat: async () => stato.nelPerimetro,
}));

const { GET } = await import('./route');
const chiama = (id: string, qs = '') => GET(new NextRequest(`http://x/api/console/chat/${id}${qs}`), { params: Promise.resolve({ id }) });

const CONV = {
  id: 42, ai_owner: 'mario', ai_status: 'active', ai_paused_at: null, bot_outcome: null, bot_scheduled_at: null,
  lancio_fase: 'posto_bloccato', lancio_slug: 'webdev-ottobre', wa_number: 'whatsapp:+393520413199',
  crm_lead_id: 'abc-123', ai_summary: 'Chiede del posto.', handed_off_reason: null,
  last_inbound_at: '2026-10-05T19:14:00Z', gdo_agenda_at: null, gdo_video_sent_at: null, campaign_id: null,
  unread_count: 2, lead: { id: 48213, first_name: 'Giulia', last_name: 'Ferraresi', phone_e164: '+393334028817' },
};

beforeEach(() => {
  stato.admin = { ok: true, email: 'admin@fenice.com' };
  stato.nelPerimetro = true;
  stato.conv = { ...CONV };
  stato.crm = { lead_id: 'abc-123', status: 'NEW', conferme_outcome: null, sales_outcome: null };
  stato.eventi = [{ created_at: '2026-10-05T19:20:00Z', type: 'bot_paused', message: '[chat] bot fermato', level: 'warn' }];
  stato.eventiErrore = null;
  stato.segnali = 0;
  stato.query = [];
  stato.conErrori = [];
});

describe('GET /api/console/chat/[id]', () => {
  it('401 inoltrato dalla guardia, senza toccare il DB', async () => {
    stato.admin = { ok: false, risposta: new NextResponse('unauthorized', { status: 401 }) };
    const res = await chiama('42');
    expect(res.status).toBe(401);
    expect(stato.query).toHaveLength(0);
  });

  it('id non numerico: 400', async () => {
    const res = await chiama('abc');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'id_non_valido' });
    expect((await chiama('12x')).status).toBe(400);
  });

  it('fuori perimetro: 404', async () => {
    stato.nelPerimetro = false;
    const res = await chiama('42');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'chat_non_trovata' });
  });

  it('conversazione inesistente: 404', async () => {
    stato.conv = null;
    expect((await chiama('42')).status).toBe(404);
  });

  it('200 con la forma attesa', async () => {
    const res = await chiama('42');
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.conv).toEqual({
      id: 42, aiOwner: 'mario', aiStatus: 'active', aiPausedAt: null, botOutcome: null, botScheduledAt: null,
      lancioFase: 'posto_bloccato', lancioSlug: 'webdev-ottobre', waNumber: 'whatsapp:+393520413199',
      crmLeadId: 'abc-123', aiSummary: 'Chiede del posto.', handedOffReason: null,
      lastInboundAt: '2026-10-05T19:14:00Z', mondo: 'MARIO', unreadCount: 2,
      contesto: { testo: 'Posto bloccato', tono: 'onda' },
    });
    expect(j.lead).toEqual({ id: 48213, nome: 'Giulia Ferraresi', telefono: '+393334028817' });
    expect(j.crm).toMatchObject({ status: 'NEW' });
    expect(j.eventi).toEqual([{ at: '2026-10-05T19:20:00Z', tipo: 'bot_paused', testo: '[chat] bot fermato', livello: 'warn' }]);
    expect(j.eventiParziali).toBe(false);
  });

  it('eventi: la lettura ha un tetto di tempo (abortSignal)', async () => {
    await chiama('42');
    expect(stato.segnali).toBe(1);
  });

  it('eventi in errore (es. statement timeout): 200, eventi vuoti e eventiParziali true', async () => {
    stato.eventiErrore = 'errore';
    const res = await chiama('42');
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.eventi).toEqual([]);
    expect(j.eventiParziali).toBe(true);
    expect(j.lead.nome).toBe('Giulia Ferraresi');
    expect(j.crm).toMatchObject({ status: 'NEW' });
  });

  it('eventi che lanciano (query abortita): 200 con eventiParziali true', async () => {
    stato.eventiErrore = 'eccezione';
    const res = await chiama('42');
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.eventi).toEqual([]);
    expect(j.eventiParziali).toBe(true);
  });

  it('eventi ordinati dal più vecchio al più recente', async () => {
    stato.eventi = [
      { created_at: '2026-10-05T19:30:00Z', type: 'bot_resumed', message: null, level: 'info' },
      { created_at: '2026-10-05T19:20:00Z', type: 'bot_paused', message: null, level: 'warn' },
    ];
    const j = await (await chiama('42')).json();
    expect(j.eventi.map((e: { at: string }) => e.at)).toEqual(['2026-10-05T19:20:00Z', '2026-10-05T19:30:00Z']);
  });


  it('eventi: per conversazione, tipi ristretti, ultimi 7 giorni, max 60, dal più recente', async () => {
    await chiama('42');
    const ev = stato.query.find((q) => q.tabella === 'event_log')!;
    expect(ev.filtri).toContainEqual(['eq', 'payload->>conversationId', '42']);
    expect(ev.filtri.some(([op, c]) => op === 'in' && c === 'type')).toBe(true);
    const da = ev.filtri.find(([op]) => op === 'gte')![2] as string;
    expect(Date.now() - Date.parse(da)).toBeGreaterThan(6.9 * 864e5);
    expect(Date.now() - Date.parse(da)).toBeLessThan(7.1 * 864e5);
    expect(ev.limite).toBe(60);
    expect(ev.ordine).toEqual(['created_at', { ascending: false }]);
  });

  it('?eventi=0: non legge event_log, eventi vuoti, eventiSaltati true e non parziali', async () => {
    const res = await chiama('42', '?eventi=0');
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(stato.query.some((q) => q.tabella === 'event_log')).toBe(false);
    expect(j.eventi).toEqual([]);
    expect(j.eventiParziali).toBe(false);
    expect(j.eventiSaltati).toBe(true);
    expect(j.lead.nome).toBe('Giulia Ferraresi');
  });

  it('senza ?eventi=0 legge event_log e eventiSaltati è false', async () => {
    const j = await (await chiama('42', '?eventi=1')).json();
    expect(stato.query.some((q) => q.tabella === 'event_log')).toBe(true);
    expect(j.eventiSaltati).toBe(false);
  });

  it("chat con l'ultimo invio fallito: contesto in tono errore, come nella lista", async () => {
    stato.conv = { ...CONV, lancio_slug: null, lancio_fase: null };
    stato.conErrori = [42];
    const j = await (await chiama('42')).json();
    expect(j.conv.contesto).toEqual({ testo: 'Invio non riuscito', tono: 'errore' });
  });

  it('crm_lead_status: solo le colonne che servono', async () => {
    await chiama('42');
    expect(stato.query.find((q) => q.tabella === 'crm_lead_status')!.colonne).toBe('status, conferme_outcome, sales_outcome');
  });

  it('senza crmLeadId non legge crm_lead_status e crm è null', async () => {
    stato.conv = { ...CONV, crm_lead_id: null };
    const j = await (await chiama('42')).json();
    expect(j.crm).toBeNull();
    expect(stato.query.some((q) => q.tabella === 'crm_lead_status')).toBe(false);
  });

  it('lead senza nome: nome null', async () => {
    stato.conv = { ...CONV, lead: { id: 7, first_name: null, last_name: ' ', phone_e164: '+39333' } };
    const j = await (await chiama('42')).json();
    expect(j.lead).toEqual({ id: 7, nome: null, telefono: '+39333' });
  });
});
