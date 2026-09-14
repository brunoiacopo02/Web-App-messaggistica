import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./twilio', () => ({ sendFreeText: vi.fn(async () => ({ sid: 'SM_L', status: 'queued' })) }));
vi.mock('./bot-outcome', () => ({ sendOutcome: vi.fn(async () => ({ sent: true })) }));
vi.mock('./lancio-settings', () => ({
  getLancioSettings: vi.fn(async () => ({ attivo: true, zoomLink: null, videoLiveLink: null, offertaDelMeseLink: null, eventoAt: '2026-10-05T21:00:00+02:00' })),
}));

import { eseguiTurnoLancio } from './lancio-turno';
import { sendFreeText } from './twilio';
import { sendOutcome } from './bot-outcome';
import { TESTO_POSTO_BLOCCATO, TESTO_CONGEDO, TESTO_CHIUSURA_DOMANDE, TESTO_PASSAGGIO_UMANO } from './lancio-fase';

type Row = { direction: string; body: string | null; template_sid: string | null };
const WELCOME: Row = { direction: 'out', body: "Ciao Anna, sono l'assistente virtuale...", template_sid: 'HX_W' };
const inb = (body: string): Row => ({ direction: 'in', body, template_sid: null });
const outLibero = (body: string): Row => ({ direction: 'out', body, template_sid: null });

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

const genera = vi.fn();
const base = (over: Partial<Parameters<typeof eseguiTurnoLancio>[1]> = {}) => ({
  conversationId: 42, phone: '+393331234567', from: 'whatsapp:+390000000000', crmLeadId: 'crm-L1',
  fase: 'attesa', nome: 'Anna', rows: [WELCOME, inb('si')], inboundBody: 'si', genera, ...over,
});

beforeEach(() => { vi.clearAllMocks(); genera.mockReset(); });

describe('eseguiTurnoLancio — sì', () => {
  it('manda il testo fisso, passa a posto_bloccato, scrive gli eventi; il modello non si chiama', async () => {
    const { supabase, calls } = makeSupabase();
    const stato = await eseguiTurnoLancio(supabase, base());
    expect(stato).toBe('active');
    expect(genera).not.toHaveBeenCalled();
    expect(vi.mocked(sendFreeText).mock.calls[0][0]).toMatchObject({ to: '+393331234567', body: TESTO_POSTO_BLOCCATO });
    expect(calls.messages[0]).toMatchObject({ conversation_id: 42, direction: 'out', body: TESTO_POSTO_BLOCCATO, sender: 'bot' });
    expect(calls.convUpdates.some((u) => u.lancio_fase === 'posto_bloccato')).toBe(true);
    expect(calls.events.some((e) => e.type === 'lancio_posto_bloccato')).toBe(true);
    expect(calls.events.some((e) => e.type === 'fenice_ai_reply' && e.payload.lancio === true)).toBe(true);
    expect(sendOutcome).not.toHaveBeenCalled();
  });

  it("un secondo sì in posto_bloccato: silenzio, ma la traccia fenice_ai_reply c'è (anti re-drive)", async () => {
    const { supabase, calls } = makeSupabase();
    await eseguiTurnoLancio(supabase, base({ fase: 'posto_bloccato', rows: [WELCOME, inb('si'), outLibero(TESTO_POSTO_BLOCCATO), inb('ok')], inboundBody: 'ok' }));
    expect(sendFreeText).not.toHaveBeenCalled();
    expect(calls.events.some((e) => e.type === 'lancio_silenzio' && e.payload.motivo === 'gia_bloccato')).toBe(true);
    expect(calls.events.some((e) => e.type === 'fenice_ai_reply')).toBe(true);
  });
});

describe('eseguiTurnoLancio — no', () => {
  it('congedo fisso, fase chiuso, DA_SCARTARE al CRM con discardReason "non interessato", stato closed', async () => {
    const { supabase, calls } = makeSupabase();
    const stato = await eseguiTurnoLancio(supabase, base({ rows: [WELCOME, inb('non mi interessa')], inboundBody: 'non mi interessa' }));
    expect(stato).toBe('closed');
    expect(vi.mocked(sendFreeText).mock.calls[0][0].body).toBe(TESTO_CONGEDO);
    expect(calls.convUpdates.some((u) => u.lancio_fase === 'chiuso')).toBe(true);
    expect(vi.mocked(sendOutcome).mock.calls[0].slice(1)).toEqual([42, expect.objectContaining({
      outcome: 'DA_SCARTARE', discardReason: 'non interessato', leadWords: 'non mi interessa',
    })]);
    expect(calls.events.some((e) => e.type === 'lancio_congedo')).toBe(true);
  });

  it("se il CRM non risponde la conversazione resta active (ritentabile), il congedo è comunque partito", async () => {
    vi.mocked(sendOutcome).mockResolvedValueOnce({ sent: false, error: 'http_500' });
    const { supabase } = makeSupabase();
    const stato = await eseguiTurnoLancio(supabase, base({ rows: [WELCOME, inb('no')], inboundBody: 'no' }));
    expect(stato).toBe('active');
    expect(sendFreeText).toHaveBeenCalledTimes(1);
  });

  it('senza crmLeadId (arruolamento a mano) niente esito: chiude e basta', async () => {
    const { supabase } = makeSupabase();
    const stato = await eseguiTurnoLancio(supabase, base({ crmLeadId: null, rows: [WELCOME, inb('no')], inboundBody: 'no' }));
    expect(stato).toBe('closed');
    expect(sendOutcome).not.toHaveBeenCalled();
  });
});

describe('eseguiTurnoLancio — domanda', () => {
  it('chiama il modello con la fase e la data della live e manda UNA bolla col testo pulito', async () => {
    genera.mockResolvedValueOnce({ classe: 'domanda', passToHuman: false, visibleReply: 'È gratuita.\nIl link ti arriva qui il 5.' });
    const { supabase, calls } = makeSupabase();
    await eseguiTurnoLancio(supabase, base({ rows: [WELCOME, inb('è a pagamento?')], inboundBody: 'è a pagamento?' }));
    expect(genera).toHaveBeenCalledTimes(1);
    expect(genera.mock.calls[0][0]).toEqual([{ role: 'assistant', content: WELCOME.body }, { role: 'user', content: 'è a pagamento?' }]);
    expect(genera.mock.calls[0][1]).toMatchObject({ fase: 'attesa', nome: 'Anna', eventoAt: '2026-10-05T21:00:00+02:00' });
    expect(sendFreeText).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendFreeText).mock.calls[0][0].body).toBe('È gratuita.\nIl link ti arriva qui il 5.');
    expect(calls.events.some((e) => e.type === 'lancio_domanda')).toBe(true);
    expect(calls.convUpdates.some((u) => 'lancio_fase' in u)).toBe(false); // una domanda non cambia fase
  });

  it('un messaggio incerto va al modello, che con [LANCIO:SI] fa scattare il posto bloccato (testo fisso, non il suo)', async () => {
    genera.mockResolvedValueOnce({ classe: 'si', passToHuman: false, visibleReply: 'Che bello!' });
    const { supabase, calls } = makeSupabase();
    await eseguiTurnoLancio(supabase, base({ rows: [WELCOME, inb("non vedo l'ora")], inboundBody: "non vedo l'ora" }));
    expect(vi.mocked(sendFreeText).mock.calls[0][0].body).toBe(TESTO_POSTO_BLOCCATO);
    expect(calls.convUpdates.some((u) => u.lancio_fase === 'posto_bloccato')).toBe(true);
  });

  it('alla terza risposta aggiunge "Ci sentiamo il 5!" nella stessa bolla', async () => {
    genera.mockResolvedValueOnce({ classe: 'domanda', passToHuman: false, visibleReply: 'Sì, dal telefono va benissimo.' });
    const { supabase } = makeSupabase();
    const rows = [WELCOME, inb('costa?'), outLibero('No.'), inb('a che ora?'), outLibero('Alle 21.'), inb('posso dal telefono?')];
    await eseguiTurnoLancio(supabase, base({ rows, inboundBody: 'posso dal telefono?' }));
    expect(vi.mocked(sendFreeText).mock.calls[0][0].body).toBe(`Sì, dal telefono va benissimo.\n${TESTO_CHIUSURA_DOMANDE}`);
  });

  it('dalla quarta domanda tace fino al link: niente modello, niente invio, traccia scritta', async () => {
    const { supabase, calls } = makeSupabase();
    const rows = [WELCOME, inb('a?'), outLibero('1'), inb('b?'), outLibero('2'), inb('c?'), outLibero(`3\n${TESTO_CHIUSURA_DOMANDE}`), inb('d?')];
    await eseguiTurnoLancio(supabase, base({ rows, inboundBody: 'd?' }));
    expect(genera).not.toHaveBeenCalled();
    expect(sendFreeText).not.toHaveBeenCalled();
    expect(calls.events.some((e) => e.type === 'lancio_silenzio' && e.payload.motivo === 'domande_esaurite')).toBe(true);
    expect(calls.events.some((e) => e.type === 'fenice_ai_reply')).toBe(true);
  });

  it('il modello risponde vuoto → silenzio registrato, non una bolla vuota', async () => {
    genera.mockResolvedValueOnce({ classe: 'domanda', passToHuman: false, visibleReply: '' });
    const { supabase, calls } = makeSupabase();
    await eseguiTurnoLancio(supabase, base({ rows: [WELCOME, inb('come?')], inboundBody: 'come?' }));
    expect(sendFreeText).not.toHaveBeenCalled();
    expect(calls.events.some((e) => e.type === 'lancio_silenzio' && e.payload.motivo === 'risposta_vuota')).toBe(true);
  });
});

describe('eseguiTurnoLancio — passaggio umano', () => {
  it('[PASSAGGIO_UMANO] → CONTATTO_UMANO al CRM con le parole del lead, handed_off', async () => {
    genera.mockResolvedValueOnce({ classe: 'domanda', passToHuman: true, visibleReply: 'Certo, ti faccio contattare.' });
    const { supabase, calls } = makeSupabase();
    const stato = await eseguiTurnoLancio(supabase, base({ rows: [WELCOME, inb('voglio parlare con una persona')], inboundBody: 'voglio parlare con una persona' }));
    expect(stato).toBe('handed_off');
    expect(vi.mocked(sendFreeText).mock.calls[0][0].body).toBe('Certo, ti faccio contattare.');
    expect(vi.mocked(sendOutcome).mock.calls[0][2]).toMatchObject({ outcome: 'CONTATTO_UMANO', note: 'voglio parlare con una persona' });
    expect(calls.convUpdates.some((u) => u.handed_off_at && u.handed_off_reason === 'voglio parlare con una persona')).toBe(true);
  });

  it('senza testo del modello usa la frase fissa di passaggio', async () => {
    genera.mockResolvedValueOnce({ classe: 'domanda', passToHuman: true, visibleReply: '' });
    const { supabase } = makeSupabase();
    await eseguiTurnoLancio(supabase, base({ rows: [WELCOME, inb('mi chiamate?')], inboundBody: 'mi chiamate?' }));
    expect(vi.mocked(sendFreeText).mock.calls[0][0].body).toBe(TESTO_PASSAGGIO_UMANO);
  });
});

describe('eseguiTurnoLancio — fasi di B4/B5', () => {
  it('link_inviato: silenzio con motivo fase_non_gestita, mai il pitch', async () => {
    const { supabase, calls } = makeSupabase();
    await eseguiTurnoLancio(supabase, base({ fase: 'link_inviato', rows: [WELCOME, inb('codice?')], inboundBody: 'codice?' }));
    expect(sendFreeText).not.toHaveBeenCalled();
    expect(genera).not.toHaveBeenCalled();
    expect(calls.events.some((e) => e.type === 'lancio_silenzio' && e.payload.motivo === 'fase_non_gestita')).toBe(true);
  });
});
