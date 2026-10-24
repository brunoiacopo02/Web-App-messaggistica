/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * Il sollecito prima del richiamo blu delle Conferme (ramo `promemoriaRichiamo` di
 * app/api/cron/precall-reminders), dal vivo con un finto Supabase: le righe parcheggiate
 * di `crm_lead_status`, la presa su `conversations.conf_richiamo_sollecito_for_at` PRIMA
 * dell'invio, template fuori dalle 24 ore e testo libero dentro.
 */

let db: ReturnType<typeof makeDb>;
vi.mock('@/lib/supabase/admin', () => ({ getSupabaseAdmin: () => db.supabase }));
vi.mock('@/lib/messaging', () => ({ sendTemplateAndLog: vi.fn() }));
vi.mock('@/lib/twilio', () => ({ sendFreeText: vi.fn() }));

import { GET } from '@/app/api/cron/precall-reminders/route';
import { sendTemplateAndLog } from '@/lib/messaging';
import { sendFreeText } from '@/lib/twilio';

const NOW = Date.parse('2026-10-20T12:00:00Z'); // 14:00 a Roma
const RICHIAMO = '2026-10-20T16:00:00+02:00'; // come lo manda il CRM
const RICHIAMO_UTC = '2026-10-20T14:00:00.000Z';
const TESTO =
  'Ciao Anna, oggi alle 16:00 ti richiama Noemi, una collega di Fenice Academy, da un numero di cellulare ' +
  "per confermare giorno e ora della tua videochiamata: rispondi, sono pochi minuti. Se non l'hai ancora " +
  'fatto, guarda il video che ti ho mandato qui.';

type Riga = Record<string, any>;

function filtroOr(expr: string): (r: Riga) => boolean {
  // Solo le forme usate qui: `col.is.null`, `col.neq.valore`, `col.in.(a,b)`.
  const clausole = expr.split(/,(?![^(]*\))/).map((c) => {
    const [col, op, ...resto] = c.split('.');
    const val = resto.join('.');
    if (op === 'is') return (r: Riga) => r[col] == null;
    if (op === 'neq') return (r: Riga) => r[col] !== val;
    if (op === 'in') return (r: Riga) => val.replace(/^\(|\)$/g, '').split(',').includes(String(r[col]));
    throw new Error(`op ${op} non gestito`);
  });
  return (r) => clausole.some((f) => f(r));
}

function makeDb(stato: { status: Riga[]; convs: Riga[]; ultimoInbound?: string | null }) {
  const events: Riga[] = [];
  const messaggi: Riga[] = [];
  const supabase: any = {
    from(table: string) {
      const filtri: Array<(r: Riga) => boolean> = [];
      const sorgente = table === 'crm_lead_status' ? stato.status : table === 'conversations' ? stato.convs : [];
      const q: any = {
        eq: (c: string, v: any) => { filtri.push((r) => r[c] === v); return q; },
        neq: (c: string, v: any) => { filtri.push((r) => r[c] !== v); return q; },
        is: (c: string, v: any) => { filtri.push((r) => (v === null ? r[c] == null : r[c] === v)); return q; },
        not: (c: string) => { filtri.push((r) => r[c] != null); return q; },
        in: (c: string, v: any[]) => { filtri.push((r) => v.includes(r[c])); return q; },
        gte: (c: string, v: string) => { filtri.push((r) => r[c] != null && Date.parse(r[c]) >= Date.parse(v)); return q; },
        lte: (c: string, v: string) => { filtri.push((r) => r[c] != null && Date.parse(r[c]) <= Date.parse(v)); return q; },
        or: (expr: string) => { filtri.push(filtroOr(expr)); return q; },
        order: () => q,
        limit: () => q,
        select: () => q,
        maybeSingle: async () => ({
          data: table === 'messages' && stato.ultimoInbound ? { created_at: stato.ultimoInbound } : null,
          error: null,
        }),
        then: (resolve: any) => resolve({ data: sorgente.filter((r) => filtri.every((f) => f(r))), error: null }),
      };
      return {
        select: () => q,
        insert: async (r: Riga) => {
          if (table === 'event_log') events.push(r);
          if (table === 'messages') messaggi.push(r);
          return { error: null };
        },
        update(payload: Riga) {
          const u: any = {
            eq: (c: string, v: any) => { filtri.push((r) => r[c] === v); return u; },
            or: (expr: string) => { filtri.push(filtroOr(expr)); return u; },
            select: () => u,
            then: (resolve: any) => {
              const toccate = sorgente.filter((r) => filtri.every((f) => f(r)));
              for (const r of toccate) Object.assign(r, payload);
              resolve({ data: toccate.map((r) => ({ id: r.id })), error: null });
            },
          };
          return u;
        },
      };
    },
  };
  return { supabase, events, messaggi, ...stato };
}

const status = (over: Riga = {}): Riga => ({
  lead_id: 'L1', conversation_id: 5, conferme_outcome: 'da_rifissare', recall_at: RICHIAMO,
  crm_updated_at: '2026-10-20T09:00:00Z', ...over,
});
const conv = (over: Riga = {}): Riga => ({
  id: 5, crm_lead_id: 'L1', ai_paused_at: null, cancel_requested_at: null, wa_number: null,
  lancio_slug: null, lancio_fase: null, conf_richiamo_sollecito_for_at: null,
  leads: { phone_e164: '+393331112233', first_name: 'anna' },
  ...over,
});

const giro = async () => (await GET(new NextRequest('http://localhost/api/cron/precall-reminders', {
  headers: { authorization: 'Bearer s' },
}))).json();

describe('sollecito prima del richiamo blu delle Conferme', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    vi.stubEnv('CRON_SECRET', 's');
    vi.stubEnv('PRECALL_REMINDERS_ENABLED', '');
    vi.stubEnv('GDO_PRECALL_24H_ENABLED', '');
    vi.stubEnv('CONF_RICHIAMO_SOLLECITO_ENABLED', '1');
    vi.stubEnv('CONF_RICHIAMO_TEMPLATE_SID', 'HXrich');
    vi.mocked(sendTemplateAndLog).mockReset();
    vi.mocked(sendTemplateAndLog).mockResolvedValue({ ok: true, sid: 'SM1' });
    vi.mocked(sendFreeText).mockReset();
    vi.mocked(sendFreeText).mockResolvedValue({ sid: 'SM2', status: 'queued' } as never);
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

  it('interruttore spento (e gli altri due pure): uscita immediata', async () => {
    vi.stubEnv('CONF_RICHIAMO_SOLLECITO_ENABLED', '');
    db = makeDb({ status: [status()], convs: [conv()] });
    expect(await giro()).toEqual({ ok: true, skipped: 'disabled' });
    expect(sendTemplateAndLog).not.toHaveBeenCalled();
  });

  it('finestra delle 24 ore chiusa: template col testo vero, presa sulla colonna, evento', async () => {
    db = makeDb({ status: [status()], convs: [conv()] });
    const body = await giro();
    expect(body.richiamo).toEqual({ sent: 1, skipped: 0 });
    expect(sendTemplateAndLog).toHaveBeenCalledTimes(1);
    const [, id, phone, sid, , , vars, testo] = vi.mocked(sendTemplateAndLog).mock.calls[0];
    expect([id, phone, sid]).toEqual([5, '+393331112233', 'HXrich']);
    expect(vars).toEqual({ '1': 'Anna', '2': 'oggi alle 16:00' });
    expect(testo).toBe(TESTO);
    expect(db.convs[0].conf_richiamo_sollecito_for_at).toBe(RICHIAMO_UTC);
    expect(db.events.map((e) => e.type)).toContain('conf_richiamo_sollecito_sent');
  });

  it('il lead ha scritto 3 ore fa: testo libero, scritto in messages', async () => {
    db = makeDb({ status: [status()], convs: [conv()], ultimoInbound: '2026-10-20T09:00:00Z' });
    await giro();
    expect(sendTemplateAndLog).not.toHaveBeenCalled();
    expect(sendFreeText).toHaveBeenCalledWith({ to: '+393331112233', body: TESTO, from: undefined });
    expect(db.messaggi).toHaveLength(1);
    expect(db.messaggi[0]).toMatchObject({ conversation_id: 5, direction: 'out', body: TESTO, sender: 'bot' });
  });

  it("il giro dell'ora dopo non lo rimanda (stesso richiamo, scritto in un altro fuso)", async () => {
    db = makeDb({ status: [status()], convs: [conv()] });
    await giro();
    vi.setSystemTime(NOW + 3600_000);
    const body = await giro();
    expect(sendTemplateAndLog).toHaveBeenCalledTimes(1);
    expect(body.richiamo).toEqual({ sent: 0, skipped: 1 });
  });

  it('due giri sovrapposti: un solo sollecito', async () => {
    db = makeDb({ status: [status()], convs: [conv()] });
    await Promise.all([giro(), giro()]);
    expect(sendTemplateAndLog).toHaveBeenCalledTimes(1);
  });

  it('invio non partito: la presa si rilascia e il giro dopo riprova', async () => {
    db = makeDb({ status: [status()], convs: [conv()] });
    vi.mocked(sendTemplateAndLog).mockResolvedValueOnce({ ok: false, error: 'twilio giù' });
    await giro();
    expect(db.convs[0].conf_richiamo_sollecito_for_at).toBeNull();
    expect(db.events.map((e) => e.type)).toContain('conf_richiamo_sollecito_error');
    await giro();
    expect(sendTemplateAndLog).toHaveBeenCalledTimes(2);
    expect(db.convs[0].conf_richiamo_sollecito_for_at).toBe(RICHIAMO_UTC);
  });

  it('richiamo spostato dalle Conferme: il sollecito riparte per il nuovo orario', async () => {
    db = makeDb({ status: [status()], convs: [conv({ conf_richiamo_sollecito_for_at: '2026-10-19T14:00:00.000Z' })] });
    await giro();
    expect(sendTemplateAndLog).toHaveBeenCalledTimes(1);
  });

  it('fuori dalle 24 ore e senza template: saltato in silenzio, nessun evento di errore', async () => {
    vi.stubEnv('CONF_RICHIAMO_TEMPLATE_SID', '');
    db = makeDb({ status: [status()], convs: [conv()] });
    const body = await giro();
    expect(body.richiamo).toEqual({ sent: 0, skipped: 1 });
    expect(sendTemplateAndLog).not.toHaveBeenCalled();
    expect(db.events).toHaveLength(0);
    expect(db.convs[0].conf_richiamo_sollecito_for_at).toBeNull();
  });

  it('una disdetta chiesta non lo ferma (il parcheggio di solito segue uno spostamento)', async () => {
    db = makeDb({ status: [status()], convs: [conv({ cancel_requested_at: '2026-10-19T10:00:00Z' })] });
    await giro();
    expect(sendTemplateAndLog).toHaveBeenCalledTimes(1);
  });

  it('chat in pausa, chat del lancio in corso, esito non parcheggiato: niente', async () => {
    db = makeDb({
      status: [
        status(),
        status({ lead_id: 'L2', conversation_id: 6 }),
        status({ lead_id: 'L3', conversation_id: 7, conferme_outcome: 'confermato' }),
      ],
      convs: [
        conv({ ai_paused_at: '2026-10-20T08:00:00Z' }),
        conv({ id: 6, crm_lead_id: 'L2', lancio_slug: 'webdev-2026-10', lancio_fase: 'attesa' }),
        conv({ id: 7, crm_lead_id: 'L3' }),
      ],
    });
    await giro();
    expect(sendTemplateAndLog).not.toHaveBeenCalled();
  });

  it('riga gemella vecchia (lead_id non più quello della chat): nessun sollecito', async () => {
    db = makeDb({
      status: [
        status({ lead_id: 'L1-vecchio' }),
        // La riga vera della chat: confermata, quindi fuori dalla query dei parcheggiati.
        status({ conferme_outcome: 'confermato' }),
      ],
      convs: [conv()],
    });
    const body = await giro();
    expect(sendTemplateAndLog).not.toHaveBeenCalled();
    expect(body.richiamo).toEqual({ sent: 0, skipped: 1 });
  });

  it('riga gemella vecchia con un richiamo diverso: vale quello della riga della chat', async () => {
    db = makeDb({
      status: [
        status({ lead_id: 'L1-vecchio', recall_at: '2026-10-20T15:00:00+02:00', crm_updated_at: '2026-10-20T11:00:00Z' }),
        status(),
      ],
      convs: [conv()],
    });
    await giro();
    expect(sendTemplateAndLog).toHaveBeenCalledTimes(1);
    expect(db.convs[0].conf_richiamo_sollecito_for_at).toBe(RICHIAMO_UTC);
  });

  it('richiamo troppo lontano o già passato: fuori dalla query', async () => {
    db = makeDb({
      status: [
        status({ recall_at: '2026-10-21T16:00:00+02:00' }),
        status({ lead_id: 'L2', conversation_id: 6, recall_at: '2026-10-20T11:00:00+02:00' }),
      ],
      convs: [conv(), conv({ id: 6, crm_lead_id: 'L2' })],
    });
    await giro();
    expect(sendTemplateAndLog).not.toHaveBeenCalled();
  });
});
