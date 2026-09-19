import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Il webhook Twilio, sul ramo del numero Fenice: l'adozione di chi scrive per primo e il
 * pulsante del webinar. Non c'e' un test di rotta storico (Twilio firma la richiesta e la
 * rotta e' un'orchestrazione): qui si coprono le due decisioni che NON stanno in una
 * funzione pura e che sbagliate costano lead veri —
 *
 *  - il compare-and-set dell'adozione: due inbound dello stesso numero nuovo in volo
 *    insieme non devono adottare due volte ne' spingere due lead al CRM;
 *  - l'interruttore `lancio_pulsante_attivo`: spento, il marker del pulsante vale come
 *    assente e non deve toccare ne' `lancio_slug` ne' `lancio_fase`.
 *
 * Finto Supabase ridotto a quello che la rotta chiede, con le scritture registrate.
 */

type Riga = Record<string, unknown>;

const stato = {
  /** La riga `conversations` che legge il ramo Fenice. */
  conv: {} as Riga,
  /** Righe tornate dal compare-and-set dell'adozione: vuoto = l'ha presa un altro. */
  adottate: [{ id: 7 }] as Riga[],
  /** Quanti outbound ha questa chat (per `hasOutbound`). */
  outbound: 0,
  /** Il primo inbound in cronologia. */
  primoInbound: { body: 'ciao', created_at: '2026-10-05T21:00:00Z' } as Riga | null,
  eventi: [] as Riga[],
  /** Ogni update su `conversations`, coi filtri con cui e' partito. */
  updates: [] as { valori: Riga; filtri: Record<string, unknown> }[],
  /** Il numero su cui vive la chat, null = non ancora scritto. */
  waNumberChat: null as string | null,
};

function from(table: string) {
  const s = {
    kind: null as null | 'select' | 'insert' | 'update',
    valori: null as Riga | null,
    colonne: '',
    head: false,
    filtri: {} as Record<string, unknown>,
  };

  const risolvi = async (singolo: boolean): Promise<Riga> => {
    if (table === 'event_log') {
      if (s.kind === 'insert') stato.eventi.push(s.valori as Riga);
      return { data: null, error: null };
    }
    if (table === 'leads') return { data: { id: 3 }, error: null };
    if (table === 'messages') {
      if (s.kind === 'insert') return { data: null, error: null };
      if (s.head) return { count: stato.outbound, error: null };
      const righe = stato.primoInbound ? [stato.primoInbound] : [];
      return singolo ? { data: righe[0] ?? null, error: null } : { data: righe, error: null };
    }
    // conversations
    if (s.kind === 'update') {
      stato.updates.push({ valori: s.valori as Riga, filtri: { ...s.filtri } });
      // Il compare-and-set dell'adozione: `.is('ai_owner', null)` + `.select('id')`.
      if ('is:ai_owner' in s.filtri) return { data: stato.adottate, error: null };
      return { data: null, error: null };
    }
    if (s.colonne.includes('unread_count')) {
      return { data: { unread_count: 0, wa_number: stato.waNumberChat }, error: null };
    }
    // La rilettura di `marcaCongedo`/`marcaNotaRestituzione`: solo `lancio_info`.
    if (s.colonne.trim() === 'lancio_info') return { data: { lancio_info: stato.conv.lancio_info }, error: null };
    if (s.colonne.includes('ai_owner')) return { data: stato.conv, error: null };
    return { data: { id: 7 }, error: null };
  };

  const q = {
    select(colonne?: string, opzioni?: { head?: boolean }) {
      if (s.kind === null) s.kind = 'select';
      s.colonne = colonne ?? '';
      if (opzioni?.head) s.head = true;
      return q;
    },
    insert(v: Riga) { s.kind = 'insert'; s.valori = v; return q; },
    update(v: Riga) { s.kind = 'update'; s.valori = v; return q; },
    eq(k: string, v: unknown) { s.filtri[k] = v; return q; },
    is(k: string, v: unknown) { s.filtri[`is:${k}`] = v; return q; },
    not() { return q; },
    in() { return q; },
    gte() { return q; },
    order() { return q; },
    limit() { return risolvi(false); },
    maybeSingle() { return risolvi(true); },
    single() { return risolvi(true); },
    then(ok: (v: Riga) => unknown, ko?: (e: unknown) => unknown) { return risolvi(false).then(ok, ko); },
  };
  return q;
}

vi.mock('@/lib/supabase/admin', () => ({ getSupabaseAdmin: () => ({ from }) }));
vi.mock('@/lib/twilio', () => ({ validateTwilioSignature: async () => true }));
vi.mock('@/lib/fenice-settings', () => ({ getAutoReply: async () => true }));
vi.mock('@/lib/lancio-settings', async (originale) => ({
  ...(await originale<Record<string, unknown>>()),
  getLancioSettings: vi.fn(async () => ({
    attivo: false, pulsanteAttivo: false, zoomLink: null, videoLiveLink: null,
    offertaDelMeseLink: null, eventoAt: null, blastPerimetro: 'tutti', sender: 'principale', quotaSecondario: 0,
  })),
}));
vi.mock('@/lib/lead-entrante', () => ({ pushLeadEntrante: vi.fn(async () => ({ ok: true, leadId: 'L1' })) }));
vi.mock('@/lib/fenice-autoreply', async (originale) => ({
  ...(await originale<Record<string, unknown>>()),
  drainMarioReplies: vi.fn(async () => {}),
}));
vi.mock('@/lib/bot-outcome', async (originale) => ({
  ...(await originale<Record<string, unknown>>()),
  sendCrmNota: vi.fn(async () => ({ sent: true })),
}));
// `after()` fuori da una richiesta Next lancerebbe: qui la promessa e' gia' stata creata
// (e' quello che si vuole verificare), basta consumarla.
vi.mock('next/server', async (originale) => ({
  ...(await originale<Record<string, unknown>>()),
  after: (p: unknown) => { void Promise.resolve(p).catch(() => {}); },
}));

import { NextRequest } from 'next/server';
import { POST } from './route';
import { pushLeadEntrante } from '@/lib/lead-entrante';
import { getLancioSettings } from '@/lib/lancio-settings';
import { TESTO_PULSANTE_WEBINAR } from '@/lib/primo-messaggio';
import { sendCrmNota } from '@/lib/bot-outcome';
import { drainMarioReplies } from '@/lib/fenice-autoreply';

const FENICE = 'whatsapp:+390000000000';

async function inbound(body: string, to: string = FENICE) {
  const form = new URLSearchParams({
    MessageSid: 'SM' + Math.random().toString(36).slice(2),
    From: 'whatsapp:+393331234567',
    To: to,
    Body: body,
  }).toString();
  return POST(new NextRequest('https://x/api/webhooks/twilio', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': 'x' },
    body: form,
  }));
}

const eventi = (tipo: string) => stato.eventi.filter((e) => e.type === tipo);
const updateConSlug = () => stato.updates.filter((u) => 'lancio_slug' in u.valori);

beforeEach(() => {
  vi.stubEnv('TWILIO_WHATSAPP_NUMBER_FENICE', FENICE);
  vi.stubEnv('INBOUND_ADOPTION_ENABLED', '1');
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://x');
  stato.conv = {
    ai_owner: null, ai_status: null, ai_paused_at: null, handed_off_at: null,
    crm_lead_id: null, bot_outcome: null,
    lancio_slug: null, lancio_fase: null, lancio_ingresso: null, lancio_info: null,
  };
  stato.adottate = [{ id: 7 }];
  stato.outbound = 0;
  stato.primoInbound = { body: 'ciao', created_at: '2026-10-05T21:00:00Z' };
  stato.eventi = [];
  stato.updates = [];
  stato.waNumberChat = null;
  vi.mocked(pushLeadEntrante).mockClear();
});

afterEach(() => { vi.unstubAllEnvs(); });

describe('adozione — compare-and-set su ai_owner', () => {
  it('adotta, logga e spinge il lead al CRM quando la riga torna', async () => {
    await inbound('Ciao, mi interessa il corso');
    expect(eventi('inbound_adottato')).toHaveLength(1);
    expect(pushLeadEntrante).toHaveBeenCalledTimes(1);
    const adozione = stato.updates.find((u) => 'is:ai_owner' in u.filtri);
    expect(adozione?.filtri['is:ai_owner']).toBeNull();
    expect(adozione?.valori).toMatchObject({ ai_owner: 'mario', crm_funnel: 'INBOUND' });
  });

  it('nessuna riga tornata (l altra richiesta ha gia adottato): niente log, niente push', async () => {
    stato.adottate = [];
    await inbound('Ciao, mi interessa il corso');
    expect(eventi('inbound_adottato')).toHaveLength(0);
    expect(eventi('inbound_adozione_fallita')).toHaveLength(0);
    expect(pushLeadEntrante).not.toHaveBeenCalled();
  });
});

describe('pulsante del webinar — interruttore lancio_pulsante_attivo', () => {
  it('spento: nessuna scrittura sul lancio, un evento orfano, e il lead resta INBOUND', async () => {
    await inbound(TESTO_PULSANTE_WEBINAR);
    expect(updateConSlug()).toHaveLength(0);
    expect(eventi('lancio_fase_cambiata')).toHaveLength(0);
    const orfano = eventi('lancio_pulsante');
    expect(orfano).toHaveLength(1);
    expect(orfano[0].payload).toMatchObject({ orfano: true, motivo: 'pulsante_spento' });
    // L'adozione va avanti come prima del lancio: provenienza INBOUND, non il lancio.
    expect(stato.updates.find((u) => 'crm_funnel' in u.valori)?.valori.crm_funnel).toBe('INBOUND');
  });

  it('acceso su una chat di Mario libera: slug, ingresso e post_pitch', async () => {
    vi.mocked(getLancioSettings).mockResolvedValueOnce({
      attivo: true, pulsanteAttivo: true, zoomLink: null, videoLiveLink: null,
      offertaDelMeseLink: null, eventoAt: null, blastPerimetro: 'tutti', sender: 'principale', quotaSecondario: 0,
    });
    stato.conv.ai_owner = 'mario';
    stato.conv.ai_status = 'active';
    stato.conv.lancio_fase = 'attesa';
    stato.conv.lancio_slug = 'webdev-2026-10';
    stato.conv.lancio_ingresso = 'lista';
    await inbound(TESTO_PULSANTE_WEBINAR);
    // Slug e ingresso c'erano gia' (entrata dalla lista): non si riscrivono.
    expect(updateConSlug()).toHaveLength(0);
    const fase = stato.updates.find((u) => 'lancio_fase' in u.valori);
    expect(fase?.valori.lancio_fase).toBe('post_pitch');
    expect(eventi('lancio_pulsante')[0].payload).toMatchObject({ giaDiMario: true });
    expect(eventi('lancio_pulsante')[0].payload).not.toHaveProperty('orfano');
  });

  it('acceso su una chat che nessuno possiede: adottata, e ci entra col pulsante', async () => {
    vi.mocked(getLancioSettings).mockResolvedValueOnce({
      attivo: true, pulsanteAttivo: true, zoomLink: null, videoLiveLink: null,
      offertaDelMeseLink: null, eventoAt: null, blastPerimetro: 'tutti', sender: 'principale', quotaSecondario: 0,
    });
    await inbound(TESTO_PULSANTE_WEBINAR);
    expect(updateConSlug()[0].valori).toMatchObject({
      lancio_slug: 'webdev-2026-10', lancio_ingresso: 'pulsante_webinar',
    });
    expect(stato.updates.find((u) => 'crm_funnel' in u.valori)?.valori.crm_funnel).toBe('Lancio Web Dev AI');
    expect(pushLeadEntrante).toHaveBeenCalledTimes(1);
  });
});

describe('lead restituito al pool che riscrive (C8)', () => {
  beforeEach(() => {
    stato.conv = {
      ai_owner: 'mario', ai_status: 'closed', ai_paused_at: null, handed_off_at: null,
      crm_lead_id: 'L9', bot_outcome: 'NON_RISPOSTO',
      lancio_slug: 'webdev-2026-10', lancio_fase: 'restituito', lancio_ingresso: 'lista', lancio_info: null,
    };
    vi.mocked(sendCrmNota).mockClear();
    vi.mocked(drainMarioReplies).mockClear();
  });

  it('non si riapre, il bot non risponde, si scrive l evento e la nota al CRM', async () => {
    const res = await inbound('ci sono ancora?');
    expect(res.status).toBe(200);
    expect(stato.updates.some((u) => u.valori.ai_status === 'active')).toBe(false);
    expect(eventi('lancio_inbound_dopo_restituzione')).toHaveLength(1);
    expect(sendCrmNota).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(sendCrmNota).mock.calls[0][2])).toContain('dopo il ritorno nel pool');
    expect(drainMarioReplies).not.toHaveBeenCalled();
  });

  it('senza crm_lead_id: evento si, nota no', async () => {
    stato.conv.crm_lead_id = null;
    await inbound('ci sono ancora?');
    expect(eventi('lancio_inbound_dopo_restituzione')).toHaveLength(1);
    expect(sendCrmNota).not.toHaveBeenCalled();
  });
});

describe('pulsante del webinar su una chat restituita (C8)', () => {
  beforeEach(() => {
    vi.mocked(getLancioSettings).mockResolvedValue({
      attivo: true, pulsanteAttivo: true, zoomLink: null, videoLiveLink: null,
      offertaDelMeseLink: null, eventoAt: null, blastPerimetro: 'tutti', sender: 'principale', quotaSecondario: 0,
    });
    stato.conv = {
      ai_owner: 'mario', ai_status: 'closed', ai_paused_at: null, handed_off_at: null,
      crm_lead_id: 'L9', bot_outcome: 'NON_RISPOSTO',
      lancio_slug: 'webdev-2026-10', lancio_fase: 'restituito', lancio_ingresso: 'lista', lancio_info: null,
    };
  });
  afterEach(() => {
    vi.mocked(getLancioSettings).mockReset();
  });

  it('la fase non si muove e nemmeno ai_status: la chat resta closed e il cron non la ridraina', async () => {
    await inbound(TESTO_PULSANTE_WEBINAR);
    expect(stato.updates.find((u) => 'lancio_fase' in u.valori)).toBeUndefined();
    expect(stato.updates.some((u) => u.valori.ai_status === 'active')).toBe(false);
    expect(eventi('lancio_pulsante')[0].payload).toMatchObject({ faseInvariata: true });
    expect(drainMarioReplies).not.toHaveBeenCalled();
  });
});

describe('nota al CRM ogni ora per chat restituita (C8)', () => {
  beforeEach(() => {
    stato.conv = {
      ai_owner: 'mario', ai_status: 'closed', ai_paused_at: null, handed_off_at: null,
      crm_lead_id: 'L9', bot_outcome: 'NON_RISPOSTO',
      lancio_slug: 'webdev-2026-10', lancio_fase: 'restituito', lancio_ingresso: 'lista', lancio_info: null,
    };
    vi.mocked(sendCrmNota).mockClear();
  });

  it('prima nota: si scrive il marcatore accanto alle chiavi gia presenti', async () => {
    stato.conv.lancio_info = { congedo_at: '2026-10-08T09:00:00.000Z' };
    await inbound('ci sono ancora?');
    expect(sendCrmNota).toHaveBeenCalledTimes(1);
    const marcatore = stato.updates.find((u) => 'lancio_info' in u.valori)?.valori.lancio_info as Riga;
    expect(marcatore.congedo_at).toBe('2026-10-08T09:00:00.000Z');
    expect(typeof marcatore.restituito_nota_at).toBe('string');
  });

  it('secondo messaggio entro l ora: evento si, nota no', async () => {
    stato.conv.lancio_info = { restituito_nota_at: new Date(Date.now() - 30 * 60_000).toISOString() };
    await inbound('allora?');
    expect(eventi('lancio_inbound_dopo_restituzione')).toHaveLength(1);
    expect(eventi('lancio_inbound_dopo_restituzione')[0].payload).toMatchObject({ notaSoppressa: true });
    expect(sendCrmNota).not.toHaveBeenCalled();
    expect(stato.updates.find((u) => 'lancio_info' in u.valori)).toBeUndefined();
  });

  it('passata l ora: si torna ad avvisare, con le parole nuove', async () => {
    stato.conv.lancio_info = { restituito_nota_at: new Date(Date.now() - 61 * 60_000).toISOString() };
    await inbound('mi richiamate?');
    expect(sendCrmNota).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(sendCrmNota).mock.calls[0][2])).toContain('mi richiamate?');
  });
});


// Il 18/09/2026 un invio e' partito per errore da +393520158061 (su Meta si
// presenta come "SerenaMente") e le chat dei lead che hanno risposto ci sono
// MIGRATE sopra: quelle persone si sono ritrovate tre nostri numeri nella
// stessa conversazione. La regola del PO e' che un lead senta sempre lo stesso
// numero, e vale piu' della finestra 24h.
describe('il numero della chat non si sposta', () => {
  const ALTRO = 'whatsapp:+393520158061';

  it('chat senza numero: lo scrive alla prima risposta', async () => {
    stato.waNumberChat = null;
    await inbound('ciao');
    const u = stato.updates.find((x) => 'wa_number' in x.valori);
    expect(u?.valori.wa_number).toBe(FENICE);
  });

  it('risposta sullo STESSO numero: nessuna riscrittura, nessun allarme', async () => {
    stato.waNumberChat = FENICE;
    await inbound('ciao');
    expect(stato.updates.find((x) => 'wa_number' in x.valori)).toBeUndefined();
    expect(eventi('inbound_su_altro_numero')).toHaveLength(0);
  });

  it('risposta su un ALTRO numero: la chat NON si sposta, e resta scritto nel registro', async () => {
    stato.waNumberChat = FENICE;
    await inbound('ciao', ALTRO);
    expect(stato.updates.find((x) => 'wa_number' in x.valori)).toBeUndefined();
    const avviso = eventi('inbound_su_altro_numero');
    expect(avviso).toHaveLength(1);
    expect(avviso[0].payload).toMatchObject({ numeroChat: FENICE, numeroEntrante: ALTRO });
  });
});
