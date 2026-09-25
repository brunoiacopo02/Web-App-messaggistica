import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./twilio', () => ({ sendFreeText: vi.fn(async () => ({ sid: 'SM_A', status: 'queued' })) }));
vi.mock('./bot-outcome', () => ({ sendOutcome: vi.fn(async () => ({ sent: true })) }));
// `congedoLancio` marca il congedo come il turno del B1: il marcatore durevole e il
// cambio di fase sono gli unici due scrittori di `conversations` che si verificano qui.
vi.mock('./lancio-db', () => ({
  impostaFaseLancio: vi.fn(async () => undefined),
  marcaCongedo: vi.fn(async () => undefined),
}));

import { turnoAssistenza, TESTO_ASSISTENZA_SENZA_PASSAGGIO } from './lancio-assistenza';
import { sendFreeText } from './twilio';
import { sendOutcome } from './bot-outcome';
import { impostaFaseLancio, marcaCongedo } from './lancio-db';
import { TESTO_CONGEDO } from './lancio-fase';
import type { LancioSettings } from './lancio-settings';

type Row = { direction: string; body: string | null; template_sid: string | null; created_at?: string | null };
const LINK: Row = { direction: 'out', body: 'Ciao Anna, ci siamo! ... https://us06web.zoom.us/j/89845223337', template_sid: 'HX_ZOOM', created_at: '2026-10-05T19:35:00+02:00' };
const inb = (body: string, at = '2026-10-05T21:30:00+02:00'): Row => ({ direction: 'in', body, template_sid: null, created_at: at });
const outLibero = (body: string): Row => ({ direction: 'out', body, template_sid: null, created_at: '2026-10-05T21:31:00+02:00' });

function makeSupabase() {
  const calls = { convUpdates: [] as any[], events: [] as any[], messages: [] as any[] };
  const supabase: any = {
    from(table: string) {
      if (table === 'conversations') {
        return { update(p: any) { calls.convUpdates.push(p); const c: any = { eq: () => c, then: (r: any) => r({ data: null, error: null }) }; return c; } };
      }
      if (table === 'messages') return { insert(p: any) { calls.messages.push(p); return Promise.resolve({ data: null }); } };
      return { insert(p: any) { calls.events.push(p); return Promise.resolve({ data: null }); } };
    },
  };
  return { supabase, calls };
}

const SETTINGS: LancioSettings = {
  attivo: true, pulsanteAttivo: false,
  zoomLink: 'https://us06web.zoom.us/j/89845223337',
  videoLiveLink: null,
  offertaDelMeseLink: null,
  eventoAt: '2026-10-05T21:00:00+02:00',
  blastPerimetro: 'tutti',
  sender: 'principale',
  quotaSecondario: 0,
};
const NOTTE5 = new Date('2026-10-05T21:30:00+02:00');
const genera = vi.fn();
const base = (over: Record<string, unknown> = {}) => ({
  conversationId: 42, phone: '+393331234567', from: 'whatsapp:+390000000000', crmLeadId: 'crm-L1',
  fase: 'link_inviato', nome: 'Anna', rows: [LINK, inb('qual è il codice riunione?')], inboundBody: 'qual è il codice riunione?', genera, ...over,
}) as any;
const tipiEventi = (calls: { events: any[] }) => calls.events.map((e) => e.type);

beforeEach(() => { vi.clearAllMocks(); genera.mockReset(); });

describe('turnoAssistenza — nella finestra', () => {
  it('chiama il modello con la fase, il link e l ID riunione, manda UNA bolla, traccia il turno', async () => {
    genera.mockResolvedValueOnce({ classe: 'domanda', passToHuman: false, visibleReply: "L'ID è 898 4522 3337, niente passcode.", lancioTag: null });
    const { supabase, calls } = makeSupabase();
    const stato = await turnoAssistenza(supabase, base(), { settings: SETTINGS, now: NOTTE5 });
    expect(stato).toBe('active');
    expect(genera.mock.calls[0][0]).toEqual([{ role: 'assistant', content: LINK.body }, { role: 'user', content: 'qual è il codice riunione?' }]);
    expect(genera.mock.calls[0][1]).toMatchObject({ fase: 'link_inviato', nome: 'Anna', eventoAt: SETTINGS.eventoAt, zoomLink: SETTINGS.zoomLink, meetingId: '898 4522 3337', now: NOTTE5 });
    expect(sendFreeText).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendFreeText).mock.calls[0][0]).toMatchObject({ to: '+393331234567', from: 'whatsapp:+390000000000', body: "L'ID è 898 4522 3337, niente passcode." });
    expect(calls.messages[0]).toMatchObject({ conversation_id: 42, direction: 'out', sender: 'bot' });
    expect(calls.convUpdates.some((u) => 'last_message_at' in u)).toBe(true);
    expect(tipiEventi(calls)).toContain('lancio_assistenza');
    expect(calls.events.find((e) => e.type === 'fenice_ai_reply').payload).toMatchObject({ conversationId: 42, lancio: true, azione: 'assistenza' });
    expect(impostaFaseLancio).not.toHaveBeenCalled();
  });

  it('senza link nelle impostazioni non inventa l ID: meetingId null', async () => {
    genera.mockResolvedValueOnce({ classe: 'domanda', passToHuman: false, visibleReply: 'Usa il link che hai ricevuto qui.', lancioTag: null });
    const { supabase } = makeSupabase();
    await turnoAssistenza(supabase, base(), { settings: { ...SETTINGS, zoomLink: null }, now: NOTTE5 });
    expect(genera.mock.calls[0][1]).toMatchObject({ zoomLink: null, meetingId: null });
  });

  it('alle 19:35, appena dopo il blast, risponde; alle 23:50 anche', async () => {
    genera.mockResolvedValue({ classe: 'domanda', passToHuman: false, visibleReply: 'Sì.', lancioTag: null });
    const { supabase } = makeSupabase();
    await turnoAssistenza(supabase, base(), { settings: SETTINGS, now: new Date('2026-10-05T19:35:00+02:00') });
    await turnoAssistenza(supabase, base(), { settings: SETTINGS, now: new Date('2026-10-05T23:50:00+02:00') });
    expect(sendFreeText).toHaveBeenCalledTimes(2);
  });

  it('un no netto: congedo fisso, fase chiuso, DA_SCARTARE "non interessato", closed, modello non chiamato', async () => {
    const { supabase, calls } = makeSupabase();
    const stato = await turnoAssistenza(supabase, base({ rows: [LINK, inb('toglietemi dalla lista')], inboundBody: 'toglietemi dalla lista' }), { settings: SETTINGS, now: NOTTE5 });
    expect(stato).toBe('closed');
    expect(genera).not.toHaveBeenCalled();
    expect(vi.mocked(sendFreeText).mock.calls[0][0].body).toBe(TESTO_CONGEDO);
    expect(marcaCongedo).toHaveBeenCalledWith(expect.anything(), 42);
    expect(impostaFaseLancio).toHaveBeenCalledWith(expect.anything(), 42, 'chiuso');
    expect(vi.mocked(sendOutcome).mock.calls[0].slice(1)).toEqual([42, expect.objectContaining({ outcome: 'DA_SCARTARE', discardReason: 'non interessato', leadWords: 'toglietemi dalla lista' })]);
    expect(tipiEventi(calls)).toContain('lancio_congedo');
    expect(calls.events.find((e) => e.type === 'fenice_ai_reply').payload).toMatchObject({ azione: 'congedo' });
  });

  // In assistenza le domande le fa il BOT ("hai l'app Zoom?", "ti si apre il link?"): il
  // "no" secco è la risposta a quelle. Prima le regex lo leggevano come un congedo e
  // scartavano al CRM un lead che stava chiedendo aiuto per entrare nella live.
  it('un "no" alle 21:05 non è un congedo: risponde il modello, nessuno scarto', async () => {
    genera.mockResolvedValueOnce({ classe: 'domanda', passToHuman: false, visibleReply: 'Nessun problema: apri il link dal browser, funziona uguale.', lancioTag: null });
    const { supabase, calls } = makeSupabase();
    const stato = await turnoAssistenza(supabase, base({
      rows: [LINK, { direction: 'out', body: "Hai l'app Zoom installata?", template_sid: null, created_at: '2026-10-05T21:04:00+02:00' }, inb('no', '2026-10-05T21:05:00+02:00')],
      inboundBody: 'no',
    }), { settings: SETTINGS, now: new Date('2026-10-05T21:05:00+02:00') });
    expect(stato).toBe('active');
    expect(genera).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendFreeText).mock.calls[0][0].body).toBe('Nessun problema: apri il link dal browser, funziona uguale.');
    expect(sendOutcome).not.toHaveBeenCalled();
    expect(marcaCongedo).not.toHaveBeenCalled();
    expect(impostaFaseLancio).not.toHaveBeenCalled();
    expect(tipiEventi(calls)).not.toContain('lancio_congedo');
  });

  it('il rifiuto ESPLICITO resta un congedo senza passare dal modello: "non mi interessa più"', async () => {
    const { supabase } = makeSupabase();
    const stato = await turnoAssistenza(supabase, base({
      rows: [LINK, inb('non mi interessa più', '2026-10-05T21:05:00+02:00')],
      inboundBody: 'non mi interessa più',
    }), { settings: SETTINGS, now: new Date('2026-10-05T21:05:00+02:00') });
    expect(stato).toBe('closed');
    expect(genera).not.toHaveBeenCalled();
    expect(vi.mocked(sendFreeText).mock.calls[0][0].body).toBe(TESTO_CONGEDO);
    expect(vi.mocked(sendOutcome).mock.calls[0][2]).toMatchObject({ outcome: 'DA_SCARTARE', leadWords: 'non mi interessa più' });
  });

  it('il no lo può dire anche il modello con [LANCIO:NO]: stesso congedo', async () => {
    genera.mockResolvedValueOnce({ classe: 'domanda', passToHuman: false, visibleReply: 'Capisco.', lancioTag: { tag: 'NO' } });
    const { supabase } = makeSupabase();
    const stato = await turnoAssistenza(supabase, base({ rows: [LINK, inb('lasciate perdere, ho cambiato idea')], inboundBody: 'lasciate perdere, ho cambiato idea' }), { settings: SETTINGS, now: NOTTE5 });
    expect(stato).toBe('closed');
    expect(vi.mocked(sendFreeText).mock.calls[0][0].body).toBe(TESTO_CONGEDO);
  });

  it('si classifica sul LOTTO, non sul primo inbound: "ok" e poi "toglimi" è un no', async () => {
    const { supabase } = makeSupabase();
    const stato = await turnoAssistenza(supabase, base({
      rows: [LINK, inb('ok'), inb('anzi toglimi dalla lista')],
      inboundBody: 'ok',
    }), { settings: SETTINGS, now: NOTTE5 });
    expect(stato).toBe('closed');
    expect(genera).not.toHaveBeenCalled();
    expect(vi.mocked(sendOutcome).mock.calls[0][2]).toMatchObject({ leadWords: 'anzi toglimi dalla lista' });
  });

  it('CRM giù sul congedo: il testo è partito e il congedo è marcato, ma la fase NON si chiude e lo stato resta active (ritentabile)', async () => {
    vi.mocked(sendOutcome).mockResolvedValueOnce({ sent: false, error: 'http_500' });
    const { supabase, calls } = makeSupabase();
    const stato = await turnoAssistenza(supabase, base({ rows: [LINK, inb('non mi interessa')], inboundBody: 'non mi interessa' }), { settings: SETTINGS, now: NOTTE5 });
    expect(stato).toBe('active');
    expect(sendFreeText).toHaveBeenCalledTimes(1);
    expect(marcaCongedo).toHaveBeenCalledTimes(1);
    expect(impostaFaseLancio).not.toHaveBeenCalled();
    expect(calls.events.find((e) => e.type === 'lancio_congedo')).toMatchObject({ level: 'warn', payload: { accettato: false, motivo: 'http_500' } });
  });

  it('il 403 del CRM è definitivo quanto un 200: fase chiusa, closed', async () => {
    vi.mocked(sendOutcome).mockResolvedValueOnce({ sent: false, status: 403, error: 'forbidden' });
    const { supabase } = makeSupabase();
    const stato = await turnoAssistenza(supabase, base({ rows: [LINK, inb('non mi interessa')], inboundBody: 'non mi interessa' }), { settings: SETTINGS, now: NOTTE5 });
    expect(stato).toBe('closed');
    expect(impostaFaseLancio).toHaveBeenCalledWith(expect.anything(), 42, 'chiuso');
  });

  it('congedo già uscito e fase ancora link_inviato: si ritenta solo l esito, nessuna seconda bolla e nessuna riclassificazione', async () => {
    const { supabase } = makeSupabase();
    const stato = await turnoAssistenza(supabase, base({
      rows: [LINK, inb('no grazie'), outLibero(TESTO_CONGEDO), inb('ok va bene')],
      inboundBody: 'ok va bene',
    }), { settings: SETTINGS, now: NOTTE5 });
    expect(stato).toBe('closed');
    expect(sendFreeText).not.toHaveBeenCalled();
    expect(marcaCongedo).not.toHaveBeenCalled();
    expect(genera).not.toHaveBeenCalled();
    // Le parole che vanno al CRM sono quelle di ALLORA, non l "ok va bene" di adesso.
    expect(vi.mocked(sendOutcome).mock.calls[0][2]).toMatchObject({ leadWords: 'no grazie' });
  });

  it('senza crmLeadId il congedo chiude lo stesso: niente esito al CRM', async () => {
    const { supabase } = makeSupabase();
    const stato = await turnoAssistenza(supabase, base({ crmLeadId: null, rows: [LINK, inb('non mi interessa')], inboundBody: 'non mi interessa' }), { settings: SETTINGS, now: NOTTE5 });
    expect(stato).toBe('closed');
    expect(sendOutcome).not.toHaveBeenCalled();
    expect(impostaFaseLancio).toHaveBeenCalledWith(expect.anything(), 42, 'chiuso');
  });

  it("[PASSAGGIO_UMANO] si ignora (PO 25/09/2026): niente CONTATTO_UMANO, esce l'ultima mossa utile", async () => {
    genera.mockResolvedValueOnce({ classe: 'domanda', passToHuman: true, visibleReply: 'Ti aiuta subito un collega.', lancioTag: null });
    const { supabase, calls } = makeSupabase();
    const stato = await turnoAssistenza(supabase, base({ rows: [LINK, inb('non riesco a entrare')], inboundBody: 'non riesco a entrare' }), { settings: SETTINGS, now: NOTTE5 });
    expect(stato).toBe('active');
    expect(vi.mocked(sendFreeText).mock.calls[0][0].body).toBe(TESTO_ASSISTENZA_SENZA_PASSAGGIO);
    expect(sendOutcome).not.toHaveBeenCalled();
    expect(calls.convUpdates.some((u) => u.handed_off_at)).toBe(false);
    expect(calls.events.some((e) => e.type === 'lancio_passaggio_umano_ignorato')).toBe(true);
  });

  it('modello vuoto: silenzio risposta_vuota, tracciato, niente bolla', async () => {
    genera.mockResolvedValueOnce({ classe: 'domanda', passToHuman: false, visibleReply: '', lancioTag: null });
    const { supabase, calls } = makeSupabase();
    await turnoAssistenza(supabase, base(), { settings: SETTINGS, now: NOTTE5 });
    expect(sendFreeText).not.toHaveBeenCalled();
    expect(calls.events.find((e) => e.type === 'lancio_silenzio').payload.motivo).toBe('risposta_vuota');
    expect(tipiEventi(calls)).toContain('fenice_ai_reply');
  });

  it('solo media, nessun testo: silenzio tracciato, il modello non si paga', async () => {
    const { supabase, calls } = makeSupabase();
    const stato = await turnoAssistenza(supabase, base({ rows: [LINK, { direction: 'in', body: null, template_sid: null, created_at: '2026-10-05T21:30:00+02:00' }], inboundBody: '' }), { settings: SETTINGS, now: NOTTE5 });
    expect(stato).toBe('active');
    expect(genera).not.toHaveBeenCalled();
    expect(sendFreeText).not.toHaveBeenCalled();
    expect(calls.events.find((e) => e.type === 'lancio_silenzio').payload.motivo).toBe('inbound_senza_testo');
    expect(tipiEventi(calls)).toContain('fenice_ai_reply');
  });
});

describe('turnoAssistenza — dopo mezzanotte', () => {
  it('alle 00:10 del 6: nessun modello, nessuna bolla, silenzio DEFINITIVO tracciato (il 6 risponde il follow-up)', async () => {
    const { supabase, calls } = makeSupabase();
    const stato = await turnoAssistenza(supabase, base({ rows: [LINK, inb('come rivedo la live?', '2026-10-06T00:10:00+02:00')], inboundBody: 'come rivedo la live?' }), { settings: SETTINGS, now: new Date('2026-10-06T00:10:00+02:00') });
    expect(stato).toBe('active');
    expect(genera).not.toHaveBeenCalled();
    expect(sendFreeText).not.toHaveBeenCalled();
    expect(calls.events.find((e) => e.type === 'lancio_silenzio').payload.motivo).toBe('assistenza_finita');
    expect(tipiEventi(calls)).toContain('fenice_ai_reply');
    expect(impostaFaseLancio).not.toHaveBeenCalled();
  });

  it('alle 23:59:59 si risponde ancora, alle 00:00:00 no: il confine è la mezzanotte di Roma', async () => {
    genera.mockResolvedValue({ classe: 'domanda', passToHuman: false, visibleReply: 'Ok.', lancioTag: null });
    const { supabase } = makeSupabase();
    await turnoAssistenza(supabase, base(), { settings: SETTINGS, now: new Date('2026-10-05T23:59:59+02:00') });
    expect(sendFreeText).toHaveBeenCalledTimes(1);
    await turnoAssistenza(supabase, base(), { settings: SETTINGS, now: new Date('2026-10-06T00:00:00+02:00') });
    expect(sendFreeText).toHaveBeenCalledTimes(1);
  });

  it('prima della finestra del blast (90 minuti) si tace: alle 19:29 no, alle 19:30 sì', async () => {
    genera.mockResolvedValue({ classe: 'domanda', passToHuman: false, visibleReply: 'Ok.', lancioTag: null });
    const { supabase } = makeSupabase();
    await turnoAssistenza(supabase, base(), { settings: SETTINGS, now: new Date('2026-10-05T19:29:00+02:00') });
    expect(sendFreeText).not.toHaveBeenCalled();
    await turnoAssistenza(supabase, base(), { settings: SETTINGS, now: new Date('2026-10-05T19:30:00+02:00') });
    expect(sendFreeText).toHaveBeenCalledTimes(1);
  });

  it('alle 10:00 del 6 idem: la fase resta link_inviato per il cron del follow-up (B5)', async () => {
    const { supabase, calls } = makeSupabase();
    await turnoAssistenza(supabase, base(), { settings: SETTINGS, now: new Date('2026-10-06T10:00:00+02:00') });
    expect(sendFreeText).not.toHaveBeenCalled();
    expect(calls.events.find((e) => e.type === 'lancio_silenzio').payload.motivo).toBe('assistenza_finita');
  });

  it('un no arrivato dopo mezzanotte non parla più: lo prende il follow-up del B5', async () => {
    const { supabase, calls } = makeSupabase();
    const stato = await turnoAssistenza(supabase, base({ rows: [LINK, inb('non mi interessa più', '2026-10-06T00:30:00+02:00')], inboundBody: 'non mi interessa più' }), { settings: SETTINGS, now: new Date('2026-10-06T00:30:00+02:00') });
    expect(stato).toBe('active');
    expect(sendFreeText).not.toHaveBeenCalled();
    expect(sendOutcome).not.toHaveBeenCalled();
    expect(calls.events.find((e) => e.type === 'lancio_silenzio').payload.motivo).toBe('assistenza_finita');
  });

  it('un esito di congedo rimasto da ritentare si ritenta a qualunque ora: nessuna bolla, solo il CRM', async () => {
    const { supabase } = makeSupabase();
    const stato = await turnoAssistenza(supabase, base({
      rows: [LINK, inb('no grazie'), outLibero(TESTO_CONGEDO), inb('ok', '2026-10-06T09:00:00+02:00')],
      inboundBody: 'ok',
    }), { settings: SETTINGS, now: new Date('2026-10-06T09:00:00+02:00') });
    expect(stato).toBe('closed');
    expect(sendFreeText).not.toHaveBeenCalled();
    expect(vi.mocked(sendOutcome).mock.calls[0][2]).toMatchObject({ outcome: 'DA_SCARTARE', leadWords: 'no grazie' });
  });

  it('senza eventoAt nelle impostazioni si usa il 5/10 alle 21', async () => {
    genera.mockResolvedValueOnce({ classe: 'domanda', passToHuman: false, visibleReply: 'Ok.', lancioTag: null });
    const { supabase } = makeSupabase();
    await turnoAssistenza(supabase, base(), { settings: { ...SETTINGS, eventoAt: null }, now: NOTTE5 });
    expect(sendFreeText).toHaveBeenCalledTimes(1);
  });

  it('un eventoAt illeggibile non spegne l assistenza: si cade sul 5/10 alle 21', async () => {
    genera.mockResolvedValueOnce({ classe: 'domanda', passToHuman: false, visibleReply: 'Ok.', lancioTag: null });
    const { supabase } = makeSupabase();
    await turnoAssistenza(supabase, base(), { settings: { ...SETTINGS, eventoAt: 'quando capita' }, now: NOTTE5 });
    expect(sendFreeText).toHaveBeenCalledTimes(1);
  });
});
