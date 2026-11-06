import { describe, it, expect, vi } from 'vitest';

vi.mock('./twilio', () => ({
  sendTemplate: vi.fn(async () => ({ sid: 'SMfinto', status: 'queued' })),
  getTemplateBody: vi.fn(async () => 'testo'),
}));

import { depsRecupero } from './recupero-aperture-deps';
import { EVENTO_APERTURA_MARIO } from './bot2-tetto';
import type { ConfigRecupero } from './recupero-aperture';

/**
 * PO 06/11/2026: i recuperi sono SOLO AGGIUNTIVI ai tetti dei freschi. Il tetto dei
 * freschi per numero si conta su `mittente_apertura` (apertureMarioOggi) e, in passato,
 * su conversations.created_at+wa_number (chatNateOggi). Il recupero non deve scrivere
 * ne' l'uno ne' l'altro: niente `mittente_apertura`, nessuna chat nuova, e la
 * riassegnazione tocca solo wa_number (created_at resta quello del 03-06/11).
 */
function supaFinto() {
  const scritture: { tabella: string; op: 'insert' | 'update'; riga: Record<string, unknown> }[] = [];
  const supa = {
    from: (tabella: string) => ({
      insert: (riga: Record<string, unknown>) => {
        scritture.push({ tabella, op: 'insert', riga });
        return Promise.resolve({ error: null });
      },
      update: (riga: Record<string, unknown>) => {
        scritture.push({ tabella, op: 'update', riga });
        return { eq: () => Promise.resolve({ error: null }) };
      },
    }),
  };
  return { supa, scritture };
}

const CFG: ConfigRecupero = { tetto: 60, numeri: ['whatsapp:+393522622245'], maxPerGiro: 8, tettiNumero: new Map([['whatsapp:+393522622245', 6]]) };

describe('recupero: non consuma i posti dei freschi', () => {
  it('riassegnazione + invio: nessun mittente_apertura, nessuna chat nuova, created_at intatto', async () => {
    const prev = { a: process.env.NEW_OPENING_ENABLED, b: process.env.FENICE_OPENING_TEMPLATE_SID };
    delete process.env.NEW_OPENING_ENABLED;
    process.env.FENICE_OPENING_TEMPLATE_SID = 'HXfinto';
    try {
      const { supa, scritture } = supaFinto();
      const deps = depsRecupero(supa as never, CFG, new Date('2026-11-07T10:00:00Z'));
      const numero = 'whatsapp:+393522622245';
      expect(await deps.riassegnaNumero(7, numero)).toBe(true);
      const r = await deps.invia({
        id: 7, ai_started_at: '2026-11-03T08:00:00Z', crm_lead_id: 'crm-7', crm_funnel: null,
        wa_number: numero, phone: '+393330000007', firstName: 'Anna',
      }, numero);
      expect(r.ok).toBe(true);
      await deps.log('recupero_apertura_inviata', 'info', { conversationId: 7, numero }, 'x');

      // Nessun evento che il tetto dei freschi conta.
      expect(scritture.some((s) => s.tabella === 'event_log' && s.riga.type === EVENTO_APERTURA_MARIO)).toBe(false);
      // Nessuna conversazione nuova (chatNateOggi conta created_at di oggi).
      expect(scritture.some((s) => s.tabella === 'conversations' && s.op === 'insert')).toBe(false);
      // Sulla chat si cambiano solo wa_number e last_message_at, mai created_at.
      const campi = scritture.filter((s) => s.tabella === 'conversations' && s.op === 'update').flatMap((s) => Object.keys(s.riga));
      expect(new Set(campi)).toEqual(new Set(['wa_number', 'last_message_at']));
      // L'unico evento di conteggio e' quello del recupero.
      expect(scritture.filter((s) => s.tabella === 'event_log').map((s) => s.riga.type)).toEqual(['recupero_apertura_inviata']);
    } finally {
      if (prev.a === undefined) delete process.env.NEW_OPENING_ENABLED; else process.env.NEW_OPENING_ENABLED = prev.a;
      if (prev.b === undefined) delete process.env.FENICE_OPENING_TEMPLATE_SID; else process.env.FENICE_OPENING_TEMPLATE_SID = prev.b;
    }
  });
});
