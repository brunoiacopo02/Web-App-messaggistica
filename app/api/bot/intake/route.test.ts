import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

// Lead di database (contratto v1.17): la rotta di intake prende la strada nuova SOLO con
// `database: true`. Senza quel campo deve restare quella di sempre, chiamata per chiamata.

const eventi: { type: string; payload: any }[] = [];
const tabelleLette: string[] = [];
const supabaseFinto = {
  from: (tabella: string) => ({
    insert: (r: any) => { eventi.push(r); return Promise.resolve({ error: null }); },
    select: () => {
      tabelleLette.push(tabella);
      const catena: any = {
        eq: () => catena, order: () => catena, maybeSingle: async () => ({ data: null, error: null }),
        limit: async () => ({ data: [], error: null }),
      };
      return catena;
    },
  }),
};

vi.mock('@/lib/supabase/admin', () => ({ getSupabaseAdmin: () => supabaseFinto }));
vi.mock('@/lib/bot-hmac', () => ({ verifySignature: () => ({ valid: true }) }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: () => ({ ok: true, resetAt: 0 }) }));
vi.mock('@/lib/fenice-enroll', () => ({ enrollLeadIntoMario: vi.fn() }));
vi.mock('@/lib/database-enroll', () => ({ enrollDatabaseLead: vi.fn() }));

import { POST } from './route';
import { enrollLeadIntoMario } from '@/lib/fenice-enroll';
import { enrollDatabaseLead } from '@/lib/database-enroll';
import { inCodaMarketing } from '@/lib/scelta-mittente';

const BASE = { leadId: 'lead-1', name: 'Giulia Rossi', phone: '+393331234567', email: 'g@example.it', funnel: 'TELEGRAM', companyId: 'fenice' };
const chiama = (body: Record<string, unknown>) => POST(new NextRequest('https://bot.test/api/bot/intake', {
  method: 'POST', body: JSON.stringify(body), headers: { 'x-bot-signature': 'x', 'content-type': 'application/json' },
}));

beforeEach(() => {
  eventi.length = 0;
  tabelleLette.length = 0;
  vi.stubEnv('BOT_WEBHOOK_SECRET', 'segreto-di-prova');
  vi.mocked(enrollLeadIntoMario).mockReset().mockResolvedValue({ ok: true, conversationId: 77, sid: 'SM1' });
  vi.mocked(enrollDatabaseLead).mockReset();
});
afterEach(() => { vi.unstubAllEnvs(); });

describe('intake senza `database`: tutto come prima', () => {
  /** Gli argomenti di `enrollLeadIntoMario` e la risposta com'erano prima di questa modifica. */
  const ARGS_DI_SEMPRE = {
    phone: '+393331234567', firstName: 'Giulia Rossi', email: 'g@example.it', crmLeadId: 'lead-1',
    crmFunnel: 'TELEGRAM', lancio: null, riscaldamento: false, numeroBot: 1, professione: null,
  };

  it.each([
    ['campo assente', {}],
    ['database: false', { database: false }],
    ['database sporco ("true", 1, "si")', { database: 'true' }],
    ['database: 1', { database: 1 }],
  ])('%s: arruolamento di Mario con gli stessi argomenti, stessa risposta, strada database mai toccata', async (_n, extra) => {
    const res = await chiama({ ...BASE, ...extra });
    expect(enrollDatabaseLead).not.toHaveBeenCalled();
    expect(enrollLeadIntoMario).toHaveBeenCalledTimes(1);
    expect(vi.mocked(enrollLeadIntoMario).mock.calls[0][1]).toEqual(ARGS_DI_SEMPRE);
    expect(await res.json()).toEqual({ ok: true, accettato: true, conversationId: 77, leadIdCorrente: 'lead-1' });
    // Nessuna lettura delle impostazioni: l'interruttore non viene nemmeno guardato.
    expect(tabelleLette).not.toContain('app_settings');
    expect(eventi.map((e) => e.type)).toEqual(['bot_intake']);
    expect(eventi[0].payload).toEqual({ crmLeadId: 'lead-1', conversationId: 77, ok: true });
  });

  it('un lead della coda marketing senza `database` resta un lead della coda di sempre', async () => {
    let inCoda: boolean | null = null;
    vi.mocked(enrollLeadIntoMario).mockImplementation(async () => { inCoda = inCodaMarketing(); return { ok: true, conversationId: 78 }; });
    await chiama({ ...BASE, codaMarketing: true });
    expect(inCoda).toBe(true);
    expect(enrollDatabaseLead).not.toHaveBeenCalled();
  });
});

describe('intake con `database: true`', () => {
  it('passa dalla strada database e non dall\'arruolamento di Mario', async () => {
    vi.mocked(enrollDatabaseLead).mockResolvedValue({ tipo: 'aperto', ok: true, conversationId: 90, variante: 'c', numero: 'whatsapp:+393522018718', sid: 'SM9' });
    const res = await chiama({ ...BASE, funnel: 'Database', codaMarketing: true, database: true });
    expect(enrollLeadIntoMario).not.toHaveBeenCalled();
    expect(vi.mocked(enrollDatabaseLead).mock.calls[0][1]).toEqual({
      phone: '+393331234567', firstName: 'Giulia Rossi', email: 'g@example.it', crmLeadId: 'lead-1', crmFunnel: 'Database',
    });
    expect(await res.json()).toEqual({ ok: true, accettato: true, conversationId: 90, leadIdCorrente: 'lead-1', database: { variante: 'c' } });
  });

  it('interruttore spento o tetti pieni: accettato:false con database_non_aperto (il CRM lo ripropone)', async () => {
    vi.mocked(enrollDatabaseLead).mockResolvedValue({ tipo: 'rifiuto', motivo: 'database_non_aperto', dettaglio: 'spento' });
    const res = await chiama({ ...BASE, database: true });
    expect(await res.json()).toEqual({ ok: true, accettato: false, motivo: 'database_non_aperto', dettaglio: 'spento' });
    expect(enrollLeadIntoMario).not.toHaveBeenCalled();
  });

  it('numero con una chat gia\' esistente: accettato:false con database_chat_esistente', async () => {
    vi.mocked(enrollDatabaseLead).mockResolvedValue({ tipo: 'rifiuto', motivo: 'database_chat_esistente', dettaglio: 'chat_esistente', conversationId: 12 });
    const res = await chiama({ ...BASE, database: true });
    expect(await res.json()).toEqual({ ok: true, accettato: false, motivo: 'database_chat_esistente', dettaglio: 'chat_esistente', conversationId: 12 });
  });

  it('ritento dello stesso intake: duplicato', async () => {
    vi.mocked(enrollDatabaseLead).mockResolvedValue({ tipo: 'duplicato', conversationId: 90 });
    const res = await chiama({ ...BASE, database: true });
    expect(await res.json()).toEqual({ ok: true, accettato: true, duplicato: true, conversationId: 90, leadIdCorrente: 'lead-1' });
  });

  it('apertura non partita: lo dice, come per ogni altro lead', async () => {
    vi.mocked(enrollDatabaseLead).mockResolvedValue({ tipo: 'aperto', ok: false, conversationId: 91, variante: 'a', numero: 'whatsapp:+393522018718', error: 'boom' });
    const res = await chiama({ ...BASE, database: true });
    expect(await res.json()).toEqual({ ok: true, accettato: false, motivo: 'apertura_non_partita', conversationId: 91, error: 'boom' });
  });

  it('errore imprevisto: arruolamento_fallito, mai un 500', async () => {
    vi.mocked(enrollDatabaseLead).mockRejectedValue(new Error('giu'));
    const res = await chiama({ ...BASE, database: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ accettato: false, motivo: 'arruolamento_fallito' });
  });
});
