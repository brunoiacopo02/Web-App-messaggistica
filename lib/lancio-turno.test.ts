import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./twilio', () => ({ sendFreeText: vi.fn(async () => ({ sid: 'SM_L', status: 'queued' })) }));
vi.mock('./bot-outcome', () => ({ sendOutcome: vi.fn(async () => ({ sent: true })) }));
vi.mock('./lancio-settings', () => ({
  getLancioSettings: vi.fn(async () => ({ attivo: true, pulsanteAttivo: false, zoomLink: null, videoLiveLink: null, offertaDelMeseLink: null, eventoAt: '2026-10-05T21:00:00+02:00' , blastPerimetro: 'tutti', sender: 'principale'})),
}));
// I turni del B4: qui si verifica solo che lo `switch` per fase li chiami con le righe
// gia' tagliate al lancio e con l'orologio del turno. Quello che fanno dentro e' provato
// in lancio-assistenza.test.ts e lancio-post-pitch.test.ts.
vi.mock('./lancio-assistenza', () => ({ turnoAssistenza: vi.fn(async () => 'active') }));
vi.mock('./lancio-post-pitch', () => ({ turnoPostPitch: vi.fn(async () => 'closed'), turnoDopoScelta: vi.fn(async () => 'closed') }));

import { eseguiTurnoLancio } from './lancio-turno';
import { sendFreeText } from './twilio';
import { sendOutcome } from './bot-outcome';
import { turnoAssistenza } from './lancio-assistenza';
import { turnoPostPitch, turnoDopoScelta } from './lancio-post-pitch';
import { getLancioSettings } from './lancio-settings';
import { TESTO_POSTO_BLOCCATO, TESTO_CONGEDO, TESTO_CHIUSURA_DOMANDE, TESTO_NIENTE_PASSAGGIO, MAX_SCAMBI_DOMANDE, TESTO_REGISTRAZIONE_PROMESSA } from './lancio-fase';

type Row = { direction: string; body: string | null; template_sid: string | null };
const WELCOME: Row = { direction: 'out', body: "Ciao Anna, sono l'assistente virtuale...", template_sid: 'HX_W' };
const inb = (body: string): Row => ({ direction: 'in', body, template_sid: null });
const outLibero = (body: string): Row => ({ direction: 'out', body, template_sid: null });

function makeSupabase(ingressoAt: string | null = null, lancioInfo: any = null) {
  const calls = { convUpdates: [] as any[], events: [] as any[], messages: [] as any[] };
  const supabase: any = {
    from(table: string) {
      if (table === 'conversations') {
        return {
          update(p: any) { calls.convUpdates.push(p); const c: any = { eq: () => c, then: (r: any) => r({ data: null, error: null }) }; return c; },
          // `marcaCongedo` rilegge `lancio_info` per non buttare le chiavi di B4.
          select() { const c: any = { eq: () => c, maybeSingle: () => Promise.resolve({ data: { lancio_info: lancioInfo }, error: null }) }; return c; },
        };
      }
      if (table === 'messages') return { insert(p: any) { calls.messages.push(p); return Promise.resolve({ data: null }); } };
      // event_log: insert per le tracce, select per l'istante di ingresso nel lancio.
      const q: any = {
        eq: () => q, order: () => q, limit: () => q,
        maybeSingle: () => Promise.resolve({ data: ingressoAt ? { created_at: ingressoAt } : null }),
      };
      return {
        insert(p: any) { calls.events.push(p); return Promise.resolve({ data: null }); },
        select: () => q,
      };
    },
  };
  return { supabase, calls };
}

const genera = vi.fn();
const base = (over: Partial<Parameters<typeof eseguiTurnoLancio>[1]> = {}) => ({
  conversationId: 42, phone: '+393331234567', from: 'whatsapp:+390000000000', crmLeadId: 'crm-L1',
  fase: 'attesa', nome: 'Anna', rows: [WELCOME, inb('si')], inboundBody: 'si', genera, ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  genera.mockReset();
  vi.stubEnv('LANCIO_WELCOME_TEMPLATE_SID', 'HX_W');
});
afterEach(() => { vi.unstubAllEnvs(); });

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

  it('se il CRM non risponde la fase NON diventa terminale: il turno dopo ritenta lo scarto senza un secondo congedo', async () => {
    vi.mocked(sendOutcome).mockResolvedValueOnce({ sent: false, error: 'http_500' });
    const { supabase, calls } = makeSupabase();
    const stato = await eseguiTurnoLancio(supabase, base({ rows: [WELCOME, inb('no')], inboundBody: 'no' }));
    expect(stato).toBe('active');
    expect(sendFreeText).toHaveBeenCalledTimes(1);
    // La fase resta 'attesa': chiuderla qui manderebbe il messaggio dopo a Mario, sul
    // lead che ha appena detto no, e nessuno ritenterebbe piu' il DA_SCARTARE.
    expect(calls.convUpdates.some((u) => 'lancio_fase' in u)).toBe(false);

    // Giro successivo: il congedo e' in cronologia e il lead ha riscritto (per giunta
    // qualcosa che da solo sembrerebbe un sì).
    const { supabase: s2, calls: c2 } = makeSupabase();
    const stato2 = await eseguiTurnoLancio(s2, base({
      rows: [WELCOME, inb('no'), outLibero(TESTO_CONGEDO), inb('ok va bene')],
      inboundBody: 'ok va bene',
    }));
    expect(stato2).toBe('closed');
    expect(sendFreeText).toHaveBeenCalledTimes(1); // nessuna seconda bolla di congedo
    expect(genera).not.toHaveBeenCalled();
    expect(vi.mocked(sendOutcome).mock.calls[1][2]).toMatchObject({ outcome: 'DA_SCARTARE' });
    expect(c2.convUpdates.some((u) => u.lancio_fase === 'chiuso')).toBe(true);
    expect(c2.convUpdates.some((u) => u.lancio_fase === 'posto_bloccato')).toBe(false);
  });

  // Task 3 (piano 2026-10-01): il webhook ha sciolto il congedo perche' il lead ha
  // riscritto con una domanda. La frase del congedo e' ancora in cronologia, ma il turno
  // NON deve ritentare lo scarto: risponde alla domanda col modello.
  it('congedo sciolto (congedo_revocato_at): niente ritentativo, risponde il modello', async () => {
    genera.mockResolvedValueOnce({ classe: 'domanda', passToHuman: false, visibleReply: 'Il percorso dura sei mesi.' });
    const { supabase, calls } = makeSupabase();
    const stato = await eseguiTurnoLancio(supabase, base({
      rows: [WELCOME, inb('non mi interessa'), outLibero(TESTO_CONGEDO), inb('Vorrei sapere del percorso')],
      inboundBody: 'Vorrei sapere del percorso',
      lancioInfo: { congedo_revocato_at: '2026-10-01T10:00:00Z' } as never,
    }));
    expect(stato).toBe('active');
    expect(genera).toHaveBeenCalledTimes(1);
    expect(sendOutcome).not.toHaveBeenCalled();
    expect(vi.mocked(sendFreeText).mock.calls[0][0].body).toBe('Il percorso dura sei mesi.');
    expect(calls.convUpdates.some((u) => u.lancio_fase === 'chiuso')).toBe(false);
  });

  it('senza crmLeadId (arruolamento a mano) niente esito: chiude e basta', async () => {
    const { supabase } = makeSupabase();
    const stato = await eseguiTurnoLancio(supabase, base({ crmLeadId: null, rows: [WELCOME, inb('no')], inboundBody: 'no' }));
    expect(stato).toBe('closed');
    expect(sendOutcome).not.toHaveBeenCalled();
  });
});

describe('eseguiTurnoLancio — congedo rifiutato dal CRM', () => {
  it('403: il CRM rifiuta lo scarto ma e definitivo — fase chiuso, stato closed, nessun ritentativo dopo', async () => {
    // sendOutcome sul 403 registra gia' l'esito in locale e chiude la conversazione:
    // trattarlo come ritentabile terrebbe il lead nel pubblico del lancio per sempre.
    vi.mocked(sendOutcome).mockResolvedValueOnce({ sent: false, status: 403, error: 'http_403' });
    const { supabase, calls } = makeSupabase();
    const stato = await eseguiTurnoLancio(supabase, base({ rows: [WELCOME, inb('no')], inboundBody: 'no' }));
    expect(stato).toBe('closed');
    expect(calls.convUpdates.some((u) => u.lancio_fase === 'chiuso')).toBe(true);
    expect(calls.events.some((e) => e.type === 'lancio_congedo' && e.payload.motivo === 'crm_403')).toBe(true);

    // La fase e' terminale: al messaggio dopo il lancio non riprende nemmeno il turno
    // (lo ferma `lancioInCorso` nel drain) e comunque nessuno ri-POSTa lo scarto.
    const { supabase: s2 } = makeSupabase();
    await eseguiTurnoLancio(s2, base({
      fase: 'chiuso',
      rows: [WELCOME, inb('no'), outLibero(TESTO_CONGEDO), inb('ok va bene')],
      inboundBody: 'ok va bene',
    }));
    expect(sendOutcome).toHaveBeenCalledTimes(1);
    expect(sendFreeText).toHaveBeenCalledTimes(1);
  });

  it('sul ritentativo al CRM vanno le parole del no, non quelle scritte dopo il congedo', async () => {
    vi.mocked(sendOutcome).mockResolvedValueOnce({ sent: false, error: 'http_500' });
    const { supabase } = makeSupabase();
    await eseguiTurnoLancio(supabase, base({ rows: [WELCOME, inb('non mi interessa')], inboundBody: 'non mi interessa' }));
    expect(vi.mocked(sendOutcome).mock.calls[0][2]).toMatchObject({ leadWords: 'non mi interessa' });

    const { supabase: s2 } = makeSupabase();
    await eseguiTurnoLancio(s2, base({
      rows: [WELCOME, inb('non mi interessa'), outLibero(TESTO_CONGEDO), inb('ok va bene')],
      inboundBody: 'ok va bene',
    }));
    expect(vi.mocked(sendOutcome).mock.calls[1][2]).toMatchObject({ leadWords: 'non mi interessa' });
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

  it('dopo tre domande risponde ancora (PO 29/09: prima della live il bot ci parla)', async () => {
    genera.mockResolvedValueOnce({ classe: 'domanda', passToHuman: false, visibleReply: 'Sì, dal telefono va benissimo.' });
    const { supabase } = makeSupabase();
    const rows = [WELCOME, inb('a?'), outLibero('1'), inb('b?'), outLibero('2'), inb('c?'), outLibero('3'), inb('posso dal telefono?')];
    await eseguiTurnoLancio(supabase, base({ rows, inboundBody: 'posso dal telefono?' }));
    expect(vi.mocked(sendFreeText).mock.calls[0][0].body).toBe('Sì, dal telefono va benissimo.');
  });

  /** Una chat con `n` scambi di domande già risposti; l'ultima risposta chiude se `chiusa`. */
  const scambi = (n: number, chiusa = false) => Array.from({ length: n }, (_, k) => [
    inb(`d${k}?`), outLibero(chiusa && k === n - 1 ? `${k}\n${TESTO_CHIUSURA_DOMANDE}` : `${k}`),
  ]).flat();

  it('all\'ultima risposta prima del fusibile aggiunge "Ci sentiamo il 5!" nella stessa bolla', async () => {
    genera.mockResolvedValueOnce({ classe: 'domanda', passToHuman: false, visibleReply: 'Sì, dal telefono va benissimo.' });
    const { supabase } = makeSupabase();
    const rows = [WELCOME, ...scambi(MAX_SCAMBI_DOMANDE - 1), inb('posso dal telefono?')];
    await eseguiTurnoLancio(supabase, base({ rows, inboundBody: 'posso dal telefono?' }));
    expect(vi.mocked(sendFreeText).mock.calls[0][0].body).toBe(`Sì, dal telefono va benissimo.\n${TESTO_CHIUSURA_DOMANDE}`);
  });

  it('oltre il fusibile tace fino al link: niente modello, niente invio, traccia scritta', async () => {
    const { supabase, calls } = makeSupabase();
    const rows = [WELCOME, ...scambi(MAX_SCAMBI_DOMANDE, true), inb('ancora?')];
    await eseguiTurnoLancio(supabase, base({ rows, inboundBody: 'ancora?' }));
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

describe('eseguiTurnoLancio — cronologia di questo lancio', () => {
  const vecchieDiMario = [
    { direction: 'out', body: 'Ciao, sono Mario', template_sid: 'HX_MARIO', created_at: '2026-08-01T09:00:00Z' },
    { direction: 'in', body: 'chi sei?', template_sid: null, created_at: '2026-08-01T09:05:00Z' },
    { direction: 'out', body: 'Ti va una call?', template_sid: null, created_at: '2026-08-01T09:06:00Z' },
    { direction: 'in', body: 'quando?', template_sid: null, created_at: '2026-08-01T09:07:00Z' },
    { direction: 'out', body: 'Domani alle 18', template_sid: null, created_at: '2026-08-01T09:08:00Z' },
    { direction: 'in', body: 'ok', template_sid: null, created_at: '2026-08-01T09:09:00Z' },
    { direction: 'out', body: 'Perfetto, a domani', template_sid: null, created_at: '2026-08-01T09:10:00Z' },
  ];

  it("chat riusata senza benvenuto: il giro precedente di Mario non conta come domande gia' fatte", async () => {
    genera.mockResolvedValueOnce({ classe: 'domanda', passToHuman: false, visibleReply: 'E gratuita.' });
    // Nessun benvenuto in cronologia (guardia anti-doppione dell'intake): il taglio
    // arriva dall'evento lancio_intake. Senza, i 3 outbound liberi di Mario varrebbero
    // come tre domande gia' spese e la prima del lancio finirebbe nel silenzio.
    const { supabase } = makeSupabase('2026-09-20T10:00:00Z');
    const rows = [...vecchieDiMario, { direction: 'in', body: 'e gratis?', template_sid: null, created_at: '2026-09-20T10:05:00Z' }];
    await eseguiTurnoLancio(supabase, base({ rows, inboundBody: 'e gratis?' }));
    expect(genera).toHaveBeenCalledTimes(1);
    expect(genera.mock.calls[0][0]).toEqual([{ role: 'user', content: 'e gratis?' }]);
    expect(vi.mocked(sendFreeText).mock.calls[0][0].body).toBe('E gratuita.');
  });

  it("col benvenuto in cronologia il taglio parte da li, senza leggere l'evento", async () => {
    genera.mockResolvedValueOnce({ classe: 'domanda', passToHuman: false, visibleReply: 'Alle 21.' });
    const { supabase } = makeSupabase(); // nessun evento lancio_intake da leggere
    const rows = [...vecchieDiMario, { ...WELCOME, created_at: '2026-09-20T10:00:00Z' }, inb('a che ora?')];
    await eseguiTurnoLancio(supabase, base({ rows, inboundBody: 'a che ora?' }));
    expect(genera.mock.calls[0][0]).toEqual([
      { role: 'assistant', content: WELCOME.body },
      { role: 'user', content: 'a che ora?' },
    ]);
  });
});

describe('eseguiTurnoLancio — niente modello quando non serve', () => {
  it('una foto senza didascalia non si manda al modello: silenzio tracciato', async () => {
    const { supabase, calls } = makeSupabase();
    await eseguiTurnoLancio(supabase, base({ rows: [WELCOME, inb('')], inboundBody: '' }));
    expect(genera).not.toHaveBeenCalled();
    expect(sendFreeText).not.toHaveBeenCalled();
    expect(calls.events.some((e) => e.type === 'lancio_silenzio' && e.payload.motivo === 'classe_incerta')).toBe(true);
    expect(calls.events.some((e) => e.type === 'fenice_ai_reply')).toBe(true);
  });

  it('un inbound di prima del lancio non e la risposta al benvenuto: silenzio tracciato', async () => {
    // Chat riusata: il drain pesca l'inbound dalle righe NON tagliate e potrebbe
    // passarci un "si" rimasto senza risposta nel giro di Mario. Non deve bloccare
    // nessun posto.
    const { supabase, calls } = makeSupabase('2026-09-20T10:00:00Z');
    const rows = [
      { direction: 'in', body: 'si', template_sid: null, created_at: '2026-08-01T09:00:00Z' },
      { ...WELCOME, created_at: '2026-09-20T10:00:00Z' },
    ];
    await eseguiTurnoLancio(supabase, base({ rows, inboundBody: 'si' }));
    expect(genera).not.toHaveBeenCalled();
    expect(sendFreeText).not.toHaveBeenCalled();
    expect(calls.convUpdates.some((u) => 'lancio_fase' in u)).toBe(false);
    expect(calls.events.some((e) => e.type === 'lancio_silenzio' && e.payload.motivo === 'inbound_fuori_lancio')).toBe(true);
    expect(calls.events.some((e) => e.type === 'fenice_ai_reply')).toBe(true);
  });

  it('un incerto oltre il fusibile non paga una chiamata al modello', async () => {
    const { supabase, calls } = makeSupabase();
    const giaRisposte = Array.from({ length: MAX_SCAMBI_DOMANDE }, (_, k) => [inb(`d${k}?`), outLibero(`${k}`)]).flat();
    const rows = [WELCOME, ...giaRisposte, inb('mah')];
    await eseguiTurnoLancio(supabase, base({ rows, inboundBody: 'mah' }));
    expect(genera).not.toHaveBeenCalled();
    expect(sendFreeText).not.toHaveBeenCalled();
    expect(calls.events.some((e) => e.type === 'lancio_silenzio')).toBe(true);
  });
});

describe('eseguiTurnoLancio — mai un passaggio a una persona (PO 25/09/2026)', () => {
  it('[PASSAGGIO_UMANO] si ignora: niente CONTATTO_UMANO, niente handed_off, esce la frase fissa', async () => {
    genera.mockResolvedValueOnce({ classe: 'domanda', passToHuman: true, visibleReply: 'Certo, ti faccio contattare.' });
    const { supabase, calls } = makeSupabase();
    const stato = await eseguiTurnoLancio(supabase, base({ rows: [WELCOME, inb('voglio parlare con una persona')], inboundBody: 'voglio parlare con una persona' }));
    expect(stato).toBe('active');
    expect(vi.mocked(sendFreeText).mock.calls[0][0].body).toBe(TESTO_NIENTE_PASSAGGIO);
    expect(sendOutcome).not.toHaveBeenCalled();
    expect(calls.convUpdates.some((u) => u.handed_off_at)).toBe(false);
    expect(calls.events.some((e) => e.type === 'lancio_passaggio_umano_ignorato')).toBe(true);
  });

  it('il caso del 25/09: "quanto dura?" ripetuto non porta a nessun contatto', async () => {
    genera.mockResolvedValueOnce({ classe: 'domanda', passToHuman: true, visibleReply: 'Ti faccio contattare da una persona del team.' });
    const { supabase } = makeSupabase();
    const stato = await eseguiTurnoLancio(supabase, base({ fase: 'posto_bloccato', rows: [WELCOME, inb('La live quanto dura?')], inboundBody: 'La live quanto dura?' }));
    expect(stato).toBe('active');
    expect(sendOutcome).not.toHaveBeenCalled();
    expect(vi.mocked(sendFreeText).mock.calls[0][0].body).not.toMatch(/contattare/);
  });
});

describe('eseguiTurnoLancio — le fasi del B4 delegano ai loro turni', () => {
  const NOW = new Date('2026-10-05T22:40:00+02:00');

  it('link_inviato → turnoAssistenza con settings e now; il turno del B1 non parte', async () => {
    const { supabase, calls } = makeSupabase();
    const stato = await eseguiTurnoLancio(supabase, base({ fase: 'link_inviato', rows: [WELCOME, inb('codice?')], inboundBody: 'codice?', now: NOW }));
    expect(stato).toBe('active');
    expect(turnoAssistenza).toHaveBeenCalledTimes(1);
    const [, input, ctx] = vi.mocked(turnoAssistenza).mock.calls[0];
    expect(input).toMatchObject({ conversationId: 42, fase: 'link_inviato', inboundBody: 'codice?' });
    expect(ctx).toMatchObject({ now: NOW, settings: expect.objectContaining({ eventoAt: '2026-10-05T21:00:00+02:00' }) });
    // Le impostazioni si leggono una volta sola per turno, non una per ramo.
    expect(getLancioSettings).toHaveBeenCalledTimes(1);
    expect(genera).not.toHaveBeenCalled();
    expect(sendFreeText).not.toHaveBeenCalled();
    expect(calls.events.some((e) => e.type === 'lancio_silenzio')).toBe(false);
  });

  it("post_pitch → turnoPostPitch, con lancioInfo passato com'è; lo stato è quello del turno", async () => {
    const { supabase } = makeSupabase();
    const info = { risposte: ['faccio il barista'] };
    const stato = await eseguiTurnoLancio(supabase, base({ fase: 'post_pitch', lancioInfo: info, rows: [WELCOME, inb('adesso')], inboundBody: 'adesso', now: NOW }));
    expect(stato).toBe('closed');
    expect(vi.mocked(turnoPostPitch).mock.calls[0][1]).toMatchObject({ fase: 'post_pitch', lancioInfo: info });
    expect(vi.mocked(turnoPostPitch).mock.calls[0][2]).toMatchObject({ now: NOW });
  });

  it('scelta_fatta → turnoDopoScelta, con la stessa finestra (settings e now)', async () => {
    const { supabase } = makeSupabase();
    await eseguiTurnoLancio(supabase, base({ fase: 'scelta_fatta', rows: [WELCOME, inb('grazie')], inboundBody: 'grazie', now: NOW }));
    expect(turnoDopoScelta).toHaveBeenCalledTimes(1);
    expect(vi.mocked(turnoDopoScelta).mock.calls[0][2]).toMatchObject({ now: NOW, settings: expect.objectContaining({ eventoAt: '2026-10-05T21:00:00+02:00' }) });
  });

  it("senza now in input l'orologio è quello del turno (una Date), non undefined", async () => {
    const { supabase } = makeSupabase();
    await eseguiTurnoLancio(supabase, base({ fase: 'link_inviato', rows: [WELCOME, inb('?')], inboundBody: '?' }));
    expect(vi.mocked(turnoAssistenza).mock.calls[0][2].now).toBeInstanceOf(Date);
  });

  // Il taglio si fa UNA volta qui, prima dello switch: senza, su una chat riusata il giro
  // precedente di Mario finirebbe nella cronologia che l'assistenza manda al modello.
  it('le righe arrivano al turno del B4 gia tagliate al lancio', async () => {
    const { supabase } = makeSupabase();
    const vecchia = { direction: 'in', body: 'ok', template_sid: null, created_at: '2026-08-01T09:09:00Z' };
    const rows = [vecchia, { ...WELCOME, created_at: '2026-09-20T10:00:00Z' }, inb('codice?')];
    await eseguiTurnoLancio(supabase, base({ fase: 'link_inviato', rows, inboundBody: 'codice?' }));
    const righe = vi.mocked(turnoAssistenza).mock.calls[0][1].rows;
    expect(righe.map((m) => m.body)).toEqual([WELCOME.body, 'codice?']);
  });

  // Chi entra dal pulsante la sera della live (B2, spec §6.3) non ha nessun benvenuto in
  // cronologia, e l'evento `lancio_intake` viene scritto DOPO la riga del pulsante (il
  // webhook salva il messaggio e poi arruola): l'ancora del taglio è il pulsante stesso.
  describe('ingresso dal pulsante del webinar', () => {
    const MARKER = 'Ho seguito la live Web Developer AI e voglio saperne di più 🚀';
    const pulsante = (at: string): Row & { created_at: string } => ({ direction: 'in', body: MARKER, template_sid: null, created_at: at });
    const vecchieDiMario = [
      { direction: 'out', body: 'Ciao, sono Mario', template_sid: 'HX_MARIO', created_at: '2026-08-01T09:00:00Z' },
      { direction: 'in', body: 'ok', template_sid: null, created_at: '2026-08-01T09:09:00Z' },
      { direction: 'out', body: 'Perfetto, a domani', template_sid: null, created_at: '2026-08-01T09:10:00Z' },
    ];

    it("il taglio parte dalla pressione, che l'evento di ingresso butterebbe via", async () => {
      // `lancio_intake` è di 5 secondi DOPO il pulsante: col vecchio taglio la riga del
      // lead spariva, il lotto restava vuoto e il post-pitch spendeva una bolla al buio.
      const { supabase } = makeSupabase('2026-10-05T20:38:05Z');
      const rows = [...vecchieDiMario, pulsante('2026-10-05T20:38:00Z')];
      await eseguiTurnoLancio(supabase, base({ fase: 'post_pitch', rows, inboundBody: MARKER }));
      const righe = vi.mocked(turnoPostPitch).mock.calls[0][1].rows;
      expect(righe.map((m) => m.body)).toEqual([MARKER]);
    });

    it('se il pulsante è stato premuto due volte vale l ultima pressione', async () => {
      const { supabase } = makeSupabase();
      const rows = [
        ...vecchieDiMario,
        pulsante('2026-10-05T20:38:00Z'),
        outLibero('Ciao Anna! Cosa fai oggi?'),
        pulsante('2026-10-06T09:00:00Z'),
      ];
      await eseguiTurnoLancio(supabase, base({ fase: 'post_pitch', rows, inboundBody: MARKER }));
      const righe = vi.mocked(turnoPostPitch).mock.calls[0][1].rows;
      expect(righe).toHaveLength(1);
      expect(righe[0].created_at).toBe('2026-10-06T09:00:00Z');
    });

    it('chi è entrato dalla lista non cambia: il taglio resta il benvenuto', async () => {
      const { supabase } = makeSupabase();
      const rows = [
        ...vecchieDiMario,
        { ...WELCOME, created_at: '2026-09-20T10:00:00Z' },
        inb('a che ora?'),
        outLibero('Alle 21.'),
        { ...pulsante('2026-10-05T20:38:00Z') },
      ];
      await eseguiTurnoLancio(supabase, base({ fase: 'post_pitch', rows, inboundBody: MARKER }));
      const righe = vi.mocked(turnoPostPitch).mock.calls[0][1].rows;
      expect(righe.map((m) => m.body)).toEqual([WELCOME.body, 'a che ora?', 'Alle 21.', MARKER]);
    });
  });

  // Era il segnaposto del B4 (silenzio `fase_non_gestita`): dal B5 questa fase ha il suo
  // ramo, che passa la mano a Mario. Quello che non cambia e' che i turni del B4 non la
  // toccano e che nessuna bolla del lancio esce da qui.
  it('followup_inviato non passa dai turni del B4: e il ramo del B5 a prenderlo', async () => {
    const { supabase, calls } = makeSupabase();
    const esito = await eseguiTurnoLancio(supabase, base({ fase: 'followup_inviato', rows: [WELCOME, inb('ok')], inboundBody: 'ok' }));
    expect(esito).toBe('handed_to_mario');
    expect(turnoAssistenza).not.toHaveBeenCalled();
    expect(turnoPostPitch).not.toHaveBeenCalled();
    expect(sendFreeText).not.toHaveBeenCalled();
    expect(calls.events.some((e) => e.type === 'lancio_silenzio')).toBe(false);
  });
});

describe('eseguiTurnoLancio — si risponde al lotto, non al primo messaggio', () => {
  /** Quello che il drain passa: il PRIMO inbound rimasto senza risposta. */
  const inboundDelDrain = (rows: Row[]): string => {
    let ultimoOut = -1;
    for (let k = 0; k < rows.length; k++) if (rows[k].direction === 'out') ultimoOut = k;
    for (let k = ultimoOut + 1; k < rows.length; k++) if (rows[k].direction === 'in') return rows[k].body ?? '';
    return '';
  };

  it("uno sticker prima del si non fa piu' un turno muto: il posto si blocca", async () => {
    // Il drain sceglie il primo inbound senza risposta — qui la foto senza didascalia —
    // e prima si classificava quello: turno muto, traccia fenice_ai_reply (quindi
    // niente re-drive) e il "si" del lead non bloccava il posto mai piu'.
    const rows = [WELCOME, inb(''), inb('si')];
    const { supabase, calls } = makeSupabase();
    await eseguiTurnoLancio(supabase, base({ rows, inboundBody: inboundDelDrain(rows) }));
    expect(vi.mocked(sendFreeText).mock.calls[0][0].body).toBe(TESTO_POSTO_BLOCCATO);
    expect(calls.convUpdates.some((u) => u.lancio_fase === 'posto_bloccato')).toBe(true);
  });

  it('un "no grazie" dopo un "ok" arriva al CRM: vale l ultimo, non il primo', async () => {
    const rows = [WELCOME, inb('ok'), outLibero(TESTO_POSTO_BLOCCATO), inb('ok'), inb('no grazie')];
    const { supabase, calls } = makeSupabase();
    const stato = await eseguiTurnoLancio(supabase, base({
      fase: 'posto_bloccato', rows, inboundBody: inboundDelDrain(rows),
    }));
    expect(stato).toBe('closed');
    expect(vi.mocked(sendFreeText).mock.calls[0][0].body).toBe(TESTO_CONGEDO);
    expect(vi.mocked(sendOutcome).mock.calls[0][2]).toMatchObject({ outcome: 'DA_SCARTARE', leadWords: 'no grazie' });
    expect(calls.convUpdates.some((u) => u.lancio_fase === 'chiuso')).toBe(true);
  });

  it("una domanda dopo un'emoji riceve risposta, e il modello legge tutto il lotto", async () => {
    genera.mockResolvedValueOnce({ classe: 'domanda', passToHuman: false, visibleReply: 'Alle 21.' });
    const rows = [WELCOME, inb('👍'), inb('a che ora?')];
    const { supabase } = makeSupabase();
    await eseguiTurnoLancio(supabase, base({ rows, inboundBody: inboundDelDrain(rows) }));
    expect(genera).toHaveBeenCalledTimes(1);
    expect(genera.mock.calls[0][0]).toEqual([
      { role: 'assistant', content: WELCOME.body },
      { role: 'user', content: '👍' },
      { role: 'user', content: 'a che ora?' },
    ]);
    expect(vi.mocked(sendFreeText).mock.calls[0][0].body).toBe('Alle 21.');
  });

  it('un lotto di soli media resta un silenzio, come prima', async () => {
    const rows = [WELCOME, inb(''), inb('')];
    const { supabase, calls } = makeSupabase();
    await eseguiTurnoLancio(supabase, base({ rows, inboundBody: '' }));
    expect(genera).not.toHaveBeenCalled();
    expect(sendFreeText).not.toHaveBeenCalled();
    expect(calls.events.some((e) => e.type === 'lancio_silenzio' && e.payload.motivo === 'classe_incerta')).toBe(true);
  });
});

describe('eseguiTurnoLancio — marcatore del congedo', () => {
  it('scrive congedo_at in lancio_info tenendo le chiavi gia presenti, anche se il CRM rifiuta', async () => {
    vi.mocked(sendOutcome).mockResolvedValueOnce({ sent: false, error: 'http_500' });
    const { supabase, calls } = makeSupabase(null, { risposta1: 'gia scritta da B4' });
    await eseguiTurnoLancio(supabase, base({ rows: [WELCOME, inb('non mi interessa')], inboundBody: 'non mi interessa' }));
    const marker = calls.convUpdates.find((u) => u.lancio_info);
    expect(marker.lancio_info).toMatchObject({ risposta1: 'gia scritta da B4' });
    expect(typeof marker.lancio_info.congedo_at).toBe('string');
    // La fase resta 'attesa' (lo scarto va ritentato) ma il marcatore c'e' lo stesso.
    expect(calls.convUpdates.some((u) => 'lancio_fase' in u)).toBe(false);
  });

  it('sul ritentativo dello scarto non si riscrive il marcatore (la frase non riparte)', async () => {
    const { supabase, calls } = makeSupabase();
    await eseguiTurnoLancio(supabase, base({
      rows: [WELCOME, inb('non mi interessa'), outLibero(TESTO_CONGEDO), inb('ok va bene')],
      inboundBody: 'ok va bene',
    }));
    expect(sendFreeText).not.toHaveBeenCalled();
    expect(calls.convUpdates.some((u) => u.lancio_info)).toBe(false);
  });
});

describe('followup_inviato — il lead ha risposto al follow-up: la chat passa a Mario', () => {
  it('porta la fase a chiuso, scrive l evento e torna handed_to_mario senza bolle, senza modello, senza traccia', async () => {
    const { supabase, calls } = makeSupabase();
    const esito = await eseguiTurnoLancio(supabase, base({
      fase: 'followup_inviato',
      rows: [WELCOME, inb('si'), { direction: 'out', body: 'Ciao Anna, ieri sera alla live...', template_sid: 'HX_FU' }, inb('si mi interessa, dimmi')],
      inboundBody: 'si mi interessa, dimmi',
    }));
    expect(esito).toBe('handed_to_mario');
    expect(calls.convUpdates).toContainEqual(expect.objectContaining({ lancio_fase: 'chiuso' }));
    expect(calls.events.map((e) => e.type)).toContain('lancio_followup_risposta');
    expect(sendFreeText).not.toHaveBeenCalled();
    expect(genera).not.toHaveBeenCalled();
    expect(turnoAssistenza).not.toHaveBeenCalled();
    expect(turnoPostPitch).not.toHaveBeenCalled();
    // Nessuna traccia fenice_ai_reply qui: la scrive il giro di Mario che segue.
    expect(calls.events.map((e) => e.type)).not.toContain('fenice_ai_reply');
  });
});

describe('eseguiTurnoLancio — chi non può esserci: la registrazione (PO 01/10/2026)', () => {
  const MSG = 'Purtroppo lunedì non riesco.';

  it('manda la frase fissa, scrive il marcatore, niente esito al CRM, fase invariata, modello non chiamato', async () => {
    const { supabase, calls } = makeSupabase(null, { risposte: [] });
    const stato = await eseguiTurnoLancio(supabase, base({ rows: [WELCOME, inb(MSG)], inboundBody: MSG }));
    expect(stato).toBe('active');
    expect(genera).not.toHaveBeenCalled();
    expect(sendFreeText).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendFreeText).mock.calls[0][0].body).toBe(TESTO_REGISTRAZIONE_PROMESSA);
    expect(calls.convUpdates.find((u) => u.lancio_info)?.lancio_info).toMatchObject({
      risposte: [], registrazione_promessa_at: expect.any(String),
    });
    expect(calls.convUpdates.some((u) => 'lancio_fase' in u)).toBe(false);
    expect(sendOutcome).not.toHaveBeenCalled();
    expect(calls.events.some((e) => e.type === 'lancio_registrazione_promessa')).toBe(true);
    expect(calls.events.some((e) => e.type === 'lancio_congedo')).toBe(false);
    expect(calls.events.find((e) => e.type === 'fenice_ai_reply').payload).toMatchObject({ azione: 'registrazione' });
  });

  it('in posto_bloccato: stessa promessa, la fase resta posto_bloccato', async () => {
    const { supabase, calls } = makeSupabase();
    const stato = await eseguiTurnoLancio(supabase, base({
      fase: 'posto_bloccato', rows: [WELCOME, inb('si'), outLibero(TESTO_POSTO_BLOCCATO), inb('ci sarà la registrazione?')], inboundBody: 'ci sarà la registrazione?',
    }));
    expect(stato).toBe('active');
    expect(vi.mocked(sendFreeText).mock.calls[0][0].body).toBe(TESTO_REGISTRAZIONE_PROMESSA);
    expect(calls.convUpdates.some((u) => 'lancio_fase' in u)).toBe(false);
  });

  it('il modello col tag REGISTRAZIONE su un messaggio che le regex non vedono: stessa azione', async () => {
    genera.mockResolvedValueOnce({ classe: 'registrazione', passToHuman: false, visibleReply: 'Capisco.' });
    const { supabase, calls } = makeSupabase();
    const msg = 'il 5 sono a Milano per un matrimonio, si può avere dopo?';
    await eseguiTurnoLancio(supabase, base({ rows: [WELCOME, inb(msg)], inboundBody: msg }));
    expect(genera).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendFreeText).mock.calls[0][0].body).toBe(TESTO_REGISTRAZIONE_PROMESSA);
    expect(calls.events.some((e) => e.type === 'lancio_registrazione_promessa')).toBe(true);
    expect(sendOutcome).not.toHaveBeenCalled();
  });

  it('già promessa: la frase non riparte, risponde il modello (che lo sa dal prompt)', async () => {
    genera.mockResolvedValueOnce({ classe: 'domanda', passToHuman: false, visibleReply: 'Sì, te la mandiamo qui dopo la live.' });
    const { supabase, calls } = makeSupabase(null, { registrazione_promessa_at: '2026-10-01T10:00:00.000Z' });
    const rows = [WELCOME, inb(MSG), outLibero(TESTO_REGISTRAZIONE_PROMESSA), inb('quindi la registrazione arriva qui?')];
    await eseguiTurnoLancio(supabase, base({ rows, inboundBody: 'quindi la registrazione arriva qui?', lancioInfo: { registrazione_promessa_at: '2026-10-01T10:00:00.000Z' } as any }));
    expect(genera).toHaveBeenCalledTimes(1);
    expect(genera.mock.calls[0][1]).toMatchObject({ registrazionePromessa: true });
    expect(vi.mocked(sendFreeText).mock.calls[0][0].body).toBe('Sì, te la mandiamo qui dopo la live.');
    expect(calls.events.some((e) => e.type === 'lancio_registrazione_promessa')).toBe(false);
    expect(calls.convUpdates.some((u) => u.lancio_info)).toBe(false);
  });

  it('chi chiede di cancellare l iscrizione perché non può esserci resta un congedo', async () => {
    const { supabase } = makeSupabase();
    const msg = 'Ciao e grazie, ma ti chiedo di cancellare la mia iscrizione in quanto non potrò partecipare. Grazie';
    const stato = await eseguiTurnoLancio(supabase, base({ rows: [WELCOME, inb(msg)], inboundBody: msg }));
    expect(stato).toBe('closed');
    expect(vi.mocked(sendFreeText).mock.calls[0][0].body).toBe(TESTO_CONGEDO);
  });
});

// Task 5 (piano 2026-10-01), conv 9676: chat del lancio in posto_bloccato che e' anche il
// lead di un GDO. "Buongiorno, non dovevamo sentirci alle 12?" riguarda la call: il turno
// del lancio non risponde e passa la mano al postino.
describe('eseguiTurnoLancio — messaggio per il postino GDO', () => {
  const DOMANDA_CALL = 'Buongiorno, non dovevamo sentirci alle 12?';
  const conGdo = { gdoAgendaAt: '2026-10-01T08:00:00Z', gdoAppuntamentoAt: null };

  it('contesto GDO + [LANCIO:ALTRO]: handed_to_postino, nessuna bolla, fase invariata, niente fenice_ai_reply', async () => {
    genera.mockResolvedValueOnce({ classe: 'altro', passToHuman: false, visibleReply: '', lancioTag: null });
    const { supabase, calls } = makeSupabase();
    const esito = await eseguiTurnoLancio(supabase, base({
      fase: 'posto_bloccato', rows: [WELCOME, inb('si'), outLibero(TESTO_POSTO_BLOCCATO), inb(DOMANDA_CALL)],
      inboundBody: DOMANDA_CALL, contestoGdo: conGdo,
    }));
    expect(esito).toBe('handed_to_postino');
    expect(genera.mock.calls[0][1]).toMatchObject({ contestoGdo: true });
    expect(sendFreeText).not.toHaveBeenCalled();
    expect(calls.messages).toHaveLength(0);
    expect(calls.convUpdates.some((u) => 'lancio_fase' in u)).toBe(false);
    expect(calls.events.some((e) => e.type === 'fenice_ai_reply')).toBe(false);
    expect(calls.events.find((e) => e.type === 'lancio_messaggio_al_postino')?.payload).toMatchObject({ testo: DOMANDA_CALL });
    expect(sendOutcome).not.toHaveBeenCalled();
  });

  it('col solo appuntamento GDO, senza agenda, non passa: il ramo postino non si accenderebbe', async () => {
    genera.mockResolvedValueOnce({ classe: 'altro', passToHuman: false, visibleReply: 'Ne parliamo dopo la live.', lancioTag: null });
    const { supabase } = makeSupabase();
    const esito = await eseguiTurnoLancio(supabase, base({
      rows: [WELCOME, inb(DOMANDA_CALL)], inboundBody: DOMANDA_CALL,
      contestoGdo: { gdoAgendaAt: null, gdoAppuntamentoAt: '2026-10-01T10:00:00Z' },
    }));
    expect(esito).toBe('active');
    expect(genera.mock.calls[0][1]).not.toHaveProperty('contestoGdo');
  });

  it('contesto GDO ma messaggio sulla live: risponde il lancio come sempre', async () => {
    genera.mockResolvedValueOnce({ classe: 'domanda', passToHuman: false, visibleReply: 'Dura circa due ore.', lancioTag: null });
    const { supabase } = makeSupabase();
    const esito = await eseguiTurnoLancio(supabase, base({
      rows: [WELCOME, inb('quanto dura la live?')], inboundBody: 'quanto dura la live?', contestoGdo: conGdo,
    }));
    expect(esito).toBe('active');
    expect(vi.mocked(sendFreeText).mock.calls[0][0].body).toBe('Dura circa due ore.');
  });

  it('senza contesto GDO il prompt non lo sa e un ALTRO spurio non passa a nessuno', async () => {
    genera.mockResolvedValueOnce({ classe: 'altro', passToHuman: false, visibleReply: 'Ne parliamo dopo la live.', lancioTag: null });
    const { supabase } = makeSupabase();
    const esito = await eseguiTurnoLancio(supabase, base({ rows: [WELCOME, inb(DOMANDA_CALL)], inboundBody: DOMANDA_CALL }));
    expect(esito).toBe('active');
    expect(genera.mock.calls[0][1]).not.toHaveProperty('contestoGdo');
    expect(vi.mocked(sendFreeText).mock.calls[0][0].body).toBe('Ne parliamo dopo la live.');
  });
});
