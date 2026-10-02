import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./twilio', () => ({
  sendFreeText: vi.fn(async () => ({ sid: 'SM_P', status: 'queued' })),
  sendTemplate: vi.fn(async () => ({ sid: 'SM_T', status: 'queued' })),
}));
vi.mock('./bot-outcome', () => ({
  sendOutcome: vi.fn(async () => ({ sent: true })),
  sendCrmNota: vi.fn(async () => ({ sent: true })),
}));
// `congedoLancio` (Task 7) scrive il marcatore durevole e cambia fase: sono gli unici
// due scrittori di `conversations` che non passano da questo modulo.
vi.mock('./lancio-db', () => ({
  impostaFaseLancio: vi.fn(async () => undefined),
  marcaCongedo: vi.fn(async () => undefined),
}));
vi.mock('./lancio-crm', () => ({ lancioProssimi: vi.fn(), lancioBook: vi.fn(), lancioCallNow: vi.fn() }));
vi.mock('./lead-entrante', () => ({ pushLeadEntrante: vi.fn(async () => ({ ok: true, leadId: 'crm-NEW' })) }));

import { turnoPostPitch, turnoDopoScelta, NOTA_SCELTA, PROVENIENZA_LANCIO } from './lancio-post-pitch';
import { sendFreeText, sendTemplate } from './twilio';
import { sendOutcome, sendCrmNota } from './bot-outcome';
import { impostaFaseLancio, marcaCongedo } from './lancio-db';
import { lancioProssimi, lancioBook, lancioCallNow, type LancioProssimi } from './lancio-crm';
import { pushLeadEntrante } from './lead-entrante';
import {
  TESTO_NESSUN_VENDITORE, TESTO_CHIAMATA_FUORI_ORARIO, TESTO_ERRORE_CRM, TESTO_DOPO_SCELTA, TESTO_CONGEDO_POST_PITCH,
  TESTO_INTRO_PREQUALIFICA, TESTO_INTRO_CONFERME, TESTO_NESSUNA_ORA, testoOreTreStrade, oreDaProssimi, testoConfermaChiamata,
} from './lancio-scelta';
import { TESTO_CONGEDO } from './lancio-fase';
import { DOMANDA_SCELTA_GIORNO, testoScelta } from './lancio-prompt';
import type { LancioSettings } from './lancio-settings';

type Row = { direction: string; body: string | null; template_sid: string | null; created_at?: string | null };
const MARKER = 'Ho seguito la live Web Developer AI e voglio saperne di più 🚀';
const LINK: Row = { direction: 'out', body: 'Ciao Anna, ci siamo! https://us06web.zoom.us/j/89845223337', template_sid: 'HX_ZOOM', created_at: '2026-10-05T19:35:00+02:00' };
const PULSANTE: Row = { direction: 'in', body: MARKER, template_sid: null, created_at: '2026-10-05T22:38:00+02:00' };
const inb = (body: string, at = '2026-10-05T22:40:00+02:00'): Row => ({ direction: 'in', body, template_sid: null, created_at: at });
const out = (body: string): Row => ({ direction: 'out', body, template_sid: null, created_at: '2026-10-05T22:39:00+02:00' });

function makeSupabase(crmLeadIdDb: string | null = 'crm-L1') {
  const calls = { convUpdates: [] as any[], events: [] as any[], messages: [] as any[] };
  const supabase: any = {
    from(table: string) {
      if (table === 'conversations') {
        return {
          update(p: any) { calls.convUpdates.push(p); const c: any = { eq: () => c, then: (r: any) => r({ data: null, error: null }) }; return c; },
          select() { const c: any = { eq: () => c, maybeSingle: async () => ({ data: { crm_lead_id: crmLeadIdDb } }) }; return c; },
        };
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
const NOTTE = new Date('2026-10-05T22:40:00+02:00');
const GIORNO6 = new Date('2026-10-06T10:00:00+02:00');
const oreGiorno = (date: string, ore: number[]) => ({ date, ore: ore.map((hour) => ({ hour, liberi: 1 })) });
/** Il CRM la sera della live: la mattina del 6 dei venditori, il pomeriggio del 6 alle Conferme. */
const PROSSIMI: LancioProssimi = { mattina: oreGiorno('2026-10-06', [9, 11, 14]), conferme: oreGiorno('2026-10-06', [15, 16, 17, 18, 19, 20]), saltati: [] };
/** Il CRM chiesto dal giorno dopo il primo giorno Conferme (ruling 1): il 7, tutta la fascia. */
const PROSSIMI_DAL_7: LancioProssimi = { mattina: null, conferme: oreGiorno('2026-10-07', [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]), saltati: [] };
/** Un CRM finto che risponde secondo `from`, come quello vero. */
const crmPerGiorno = (perFrom: Record<string, LancioProssimi>) => async (from: string) =>
  ({ ok: true as const, prossimi: perFrom[from] ?? { mattina: null, conferme: null, saltati: [] } });
const oreTesto = (p: LancioProssimi, now: Date) => testoOreTreStrade(oreDaProssimi(p, now), now);
const SLOT_TEXT_NOTTE = 'Per la videocall ho domattina alle 9, alle 11 o alle 14, oppure domani pomeriggio dalle 15 alle 20: a che ora ci saresti?';

const genera = vi.fn();
const modello = (over: Record<string, unknown>) => ({ classe: 'domanda', passToHuman: false, visibleReply: 'ok', lancioTag: null, ...over });
const base = (over: Record<string, unknown> = {}) => ({
  conversationId: 42, phone: '+393331234567', from: 'whatsapp:+390000000000', crmLeadId: 'crm-L1',
  fase: 'post_pitch', nome: 'Anna', rows: [LINK, PULSANTE], inboundBody: MARKER, lancioInfo: null, genera, ...over,
}) as any;
/** Una chat già riscaldata: due risposte in lancio_info, il lead ha appena risposto alla scelta. */
const scelta = (inbound: string, over: Record<string, unknown> = {}) => base({
  rows: [LINK, PULSANTE, out('Ciao Anna! Cosa fai oggi?'), inb('studio informatica'), out('E cosa ti ha colpito?'), inb('il progetto finale'), out('Preferisci adesso o domani?'), inb(inbound)],
  inboundBody: inbound, lancioInfo: { risposte: ['studio informatica', 'il progetto finale'] }, ...over,
});
/** Una chat con lo stato del percorso gia' in `lancio_info` (risposte comprese). */
const inPercorso = (inbound: string, stato: Record<string, unknown>) =>
  scelta(inbound, { lancioInfo: { risposte: ['studio informatica', 'il progetto finale'], ...stato } });
const bolle = () => vi.mocked(sendFreeText).mock.calls.map((c) => c[0].body);
const eventi = (calls: { events: any[] }, type: string) => calls.events.filter((e) => e.type === type);
const infoSalvata = (calls: { convUpdates: any[] }) => calls.convUpdates.filter((u) => 'lancio_info' in u).at(-1)?.lancio_info;
const ctx = (now: Date = NOTTE) => ({ settings: SETTINGS, now });

beforeEach(() => {
  vi.clearAllMocks();
  genera.mockReset();
  vi.mocked(lancioProssimi).mockImplementation(crmPerGiorno({ '2026-10-06': PROSSIMI, '2026-10-07': PROSSIMI_DAL_7 }));
  vi.mocked(lancioBook).mockReset();
  vi.mocked(lancioCallNow).mockReset();
  vi.mocked(pushLeadEntrante).mockResolvedValue({ ok: true, leadId: 'crm-NEW' });
  vi.mocked(sendOutcome).mockResolvedValue({ sent: true });
  vi.mocked(sendCrmNota).mockResolvedValue({ sent: true });
});

describe('turnoPostPitch — riscaldamento', () => {
  it('primo turno (il pulsante): PO 02/10 niente riscaldamento, le ore ci sono subito; modello con 0 risposte in modo notte, UNA bolla, lancio_info senza il marker', async () => {
    genera.mockResolvedValueOnce(modello({ visibleReply: 'Ciao Anna! Cosa fai oggi nella vita?' }));
    const { supabase, calls } = makeSupabase();
    const stato = await turnoPostPitch(supabase, base(), ctx());
    expect(stato).toBe('active');
    expect(lancioProssimi).toHaveBeenCalledWith('2026-10-06');
    expect(genera.mock.calls[0][1]).toMatchObject({ fase: 'post_pitch', nome: 'Anna', modo: 'notte', risposteRaccolte: 0, now: NOTTE });
    expect(bolle()).toEqual(['Ciao Anna! Cosa fai oggi nella vita?']);
    expect(infoSalvata(calls)).toEqual({ risposte: [] });
    expect(eventi(calls, 'lancio_post_pitch_domanda')).toHaveLength(1);
    expect(eventi(calls, 'fenice_ai_reply')[0].payload).toMatchObject({ lancio: true, azione: 'post_pitch' });
    expect(impostaFaseLancio).not.toHaveBeenCalled();
  });

  it('alla seconda risposta le ore entrano nel prompt: slot chiesti al CRM per il giorno dopo, blocco con le ISO', async () => {
    genera.mockResolvedValueOnce(modello({ visibleReply: 'Preferisci adesso o domani?' }));
    const { supabase, calls } = makeSupabase();
    await turnoPostPitch(supabase, base({ rows: [LINK, PULSANTE, out('Cosa fai oggi?'), inb('studio informatica'), out('E cosa ti ha colpito?'), inb('il progetto finale')], inboundBody: 'il progetto finale', lancioInfo: { risposte: ['studio informatica'] } }), ctx());
    expect(lancioProssimi).toHaveBeenNthCalledWith(1, '2026-10-06');
    // Ruling 1: il giorno Conferme dopo il primo, una lettura in piu'.
    expect(lancioProssimi).toHaveBeenNthCalledWith(2, '2026-10-07');
    expect(lancioProssimi).toHaveBeenCalledTimes(2);
    const opts = genera.mock.calls[0][1];
    expect(opts.risposteRaccolte).toBe(2);
    expect(opts.bloccoSlot).toContain('2026-10-06T09:00:00+02:00');
    expect(opts.bloccoSlot).toContain('2026-10-06T20:00:00+02:00');
    expect(opts).toMatchObject({ percorso: null, domandeFatte: 0 });
    expect(infoSalvata(calls)).toEqual({ risposte: ['studio informatica', 'il progetto finale'] });
  });

  it("[PASSAGGIO_UMANO] (PO 25/09/2026): nessun CONTATTO_UMANO, la persona e' il consulente -> le ore della call", async () => {
    genera.mockResolvedValueOnce(modello({ passToHuman: true, visibleReply: 'Certo, ti faccio contattare.' }));
    const { supabase, calls } = makeSupabase();
    expect(await turnoPostPitch(supabase, scelta('voglio parlare con una persona'), ctx())).toBe('active');
    expect(sendOutcome).not.toHaveBeenCalled();
    expect(bolle()).toEqual([SLOT_TEXT_NOTTE]);
    expect(eventi(calls, 'lancio_passaggio_umano_ignorato')).toHaveLength(1);
  });
});

describe('turnoPostPitch — [LANCIO:CHIAMA_ORA] dentro il percorso chiamata', () => {
  const CONFERMA_LUCA = "Perfetto, ti faccio chiamare subito da Luca. È una chiamata breve per valutare insieme le ultime cose e fare l'iscrizione, così blocchi il tuo posto: sono limitati.";

  it('di notte, seconda risposta: call-now con leadId, SOLO le risposte e la nota; conferma fissa col nome; scelta_fatta; closed', async () => {
    genera.mockResolvedValueOnce(modello({ visibleReply: 'Perfetto!', lancioTag: { tag: 'CHIAMA_ORA' } }));
    vi.mocked(lancioCallNow).mockResolvedValueOnce({ ok: true, venditore: { id: 'u7', nome: 'Luca' } });
    const { supabase, calls } = makeSupabase();
    const stato = await turnoPostPitch(supabase, inPercorso('adesso', { percorso: 'chiamata', domande: 1 }), ctx());
    expect(stato).toBe('closed');
    expect(lancioCallNow).toHaveBeenCalledWith({ leadId: 'crm-L1', info: { risposte: ['studio informatica', 'il progetto finale', 'adesso'] }, note: NOTA_SCELTA });
    expect(bolle()).toEqual([CONFERMA_LUCA]);
    expect(impostaFaseLancio).toHaveBeenCalledWith(expect.anything(), 42, 'scelta_fatta', { lancio_info: { risposte: ['studio informatica', 'il progetto finale', 'adesso'], percorso: 'chiamata', domande: 2 } });
    expect(eventi(calls, 'lancio_scelta')[0].payload).toMatchObject({ tipo: 'chiama_ora', venditore: { id: 'u7', nome: 'Luca' } });
    expect(eventi(calls, 'fenice_ai_reply')).toHaveLength(1);
  });

  it('409 nessun_venditore: "tutti al telefono" + le ore, percorso e conteggio azzerati, active', async () => {
    genera.mockResolvedValueOnce(modello({ lancioTag: { tag: 'CHIAMA_ORA' } }));
    vi.mocked(lancioCallNow).mockResolvedValueOnce({ ok: false, motivo: 'nessun_venditore' });
    const { supabase, calls } = makeSupabase();
    expect(await turnoPostPitch(supabase, inPercorso('adesso', { percorso: 'chiamata', domande: 1 }), ctx())).toBe('active');
    expect(bolle()).toEqual([`${TESTO_NESSUN_VENDITORE} ${SLOT_TEXT_NOTTE}`]);
    // Le risposte della chiamata restano (vanno al CRM), il conteggio no: non e' la prequalifica.
    expect(infoSalvata(calls)).toMatchObject({ percorso: null, domande: 0, slotsMostratiAt: NOTTE.toISOString() });
    expect(infoSalvata(calls).risposte).toEqual(['studio informatica', 'il progetto finale', 'adesso']);
    expect(impostaFaseLancio).not.toHaveBeenCalled();
  });

  it('409 gia_prenotato: gli si ricorda l ora che ha gia, niente seconda chiamata, scelta_fatta, closed', async () => {
    genera.mockResolvedValueOnce(modello({ lancioTag: { tag: 'CHIAMA_ORA' } }));
    vi.mocked(lancioCallNow).mockResolvedValueOnce({ ok: false, motivo: 'gia_prenotato', appointmentAt: '2026-10-06T11:00:00+02:00', kind: 'mattina' });
    const { supabase, calls } = makeSupabase();
    expect(await turnoPostPitch(supabase, inPercorso('adesso', { percorso: 'chiamata', domande: 1 }), ctx())).toBe('closed');
    expect(lancioCallNow).toHaveBeenCalledTimes(1);
    expect(bolle()).toEqual(['Risulta che hai già un appuntamento con noi martedì 6 ottobre alle 11:00: ti chiamiamo lì, non serve fissarne un altro.']);
    expect(eventi(calls, 'lancio_scelta')[0].payload).toMatchObject({ tipo: 'gia_prenotato', at: '2026-10-06T11:00:00+02:00', kind: 'mattina' });
    expect(eventi(calls, 'lancio_crm_errore')).toHaveLength(0);
  });

  it('409 gia_prenotato senza appointmentAt: testo generico, stessa strada', async () => {
    genera.mockResolvedValueOnce(modello({ lancioTag: { tag: 'CHIAMA_ORA' } }));
    vi.mocked(lancioCallNow).mockResolvedValueOnce({ ok: false, motivo: 'gia_prenotato', appointmentAt: null, kind: null });
    const { supabase } = makeSupabase();
    expect(await turnoPostPitch(supabase, inPercorso('adesso', { percorso: 'chiamata', domande: 1 }), ctx())).toBe('closed');
    expect(bolle()).toEqual(['Risulta che hai già un appuntamento fissato con noi: ti richiamiamo noi, non serve fissarne un altro.']);
  });

  it('CRM in errore (rete/http): testo di errore, evento error, active, niente fase', async () => {
    genera.mockResolvedValueOnce(modello({ lancioTag: { tag: 'CHIAMA_ORA' } }));
    vi.mocked(lancioCallNow).mockResolvedValueOnce({ ok: false, motivo: 'rete', detail: 'ECONNRESET' });
    const { supabase, calls } = makeSupabase();
    expect(await turnoPostPitch(supabase, inPercorso('adesso', { percorso: 'chiamata', domande: 1 }), ctx())).toBe('active');
    expect(bolle()).toEqual([TESTO_ERRORE_CRM]);
    expect(eventi(calls, 'lancio_crm_errore')[0].level).toBe('error');
    expect(impostaFaseLancio).not.toHaveBeenCalled();
  });

  it.each(['info_non_valida', 'forbidden', 'not_found', 'not_configured'] as const)(
    '%s dal CRM: testo di errore, evento error, active, niente fase',
    async (motivo) => {
      genera.mockResolvedValueOnce(modello({ lancioTag: { tag: 'CHIAMA_ORA' } }));
      vi.mocked(lancioCallNow).mockResolvedValueOnce({ ok: false, motivo });
      const { supabase, calls } = makeSupabase();
      expect(await turnoPostPitch(supabase, inPercorso('adesso', { percorso: 'chiamata', domande: 1 }), ctx())).toBe('active');
      expect(bolle()).toEqual([TESTO_ERRORE_CRM]);
      expect(eventi(calls, 'lancio_crm_errore')[0].level).toBe('error');
      expect(eventi(calls, 'lancio_crm_errore')[0].payload).toMatchObject({ motivo });
      expect(impostaFaseLancio).not.toHaveBeenCalled();
    },
  );

  it('409 conflitto (gia ritentato dal client): errore, nessun terzo tentativo', async () => {
    genera.mockResolvedValueOnce(modello({ lancioTag: { tag: 'CHIAMA_ORA' } }));
    vi.mocked(lancioCallNow).mockResolvedValueOnce({ ok: false, motivo: 'conflitto' });
    const { supabase, calls } = makeSupabase();
    expect(await turnoPostPitch(supabase, inPercorso('adesso', { percorso: 'chiamata', domande: 1 }), ctx())).toBe('active');
    expect(lancioCallNow).toHaveBeenCalledTimes(1);
    expect(bolle()).toEqual([TESTO_ERRORE_CRM]);
    expect(eventi(calls, 'lancio_crm_errore')[0].payload).toMatchObject({ motivo: 'conflitto' });
  });
});

describe('turnoPostPitch — [LANCIO:PRENOTA|iso] di chi ha già risposto alle domande', () => {
  const AT9 = '2026-10-06T09:00:00+02:00';
  const prenota = (at: string) => modello({ lancioTag: { tag: 'PRENOTA', at } });
  /** Dopo un'ora esaurita: percorso azzerato, ma le tre domande sono gia' fatte. */
  const risposto = (inbound: string) => inPercorso(inbound, { domande: 3 });

  it('ora valida: book SUBITO con leadId, at, solo le risposte e la nota; conferma fissa; scelta_fatta; closed', async () => {
    genera.mockResolvedValueOnce(prenota(AT9));
    vi.mocked(lancioBook).mockResolvedValueOnce({ ok: true, kind: 'mattina', venditore: { id: 'u7', nome: 'Luca' } });
    const { supabase, calls } = makeSupabase();
    expect(await turnoPostPitch(supabase, risposto('domattina alle 9'), ctx())).toBe('closed');
    expect(genera).toHaveBeenCalledTimes(1);
    expect(lancioBook).toHaveBeenCalledWith({ leadId: 'crm-L1', at: AT9, info: { risposte: ['studio informatica', 'il progetto finale', 'domattina alle 9'] }, note: NOTA_SCELTA });
    expect(bolle()).toEqual(['Perfetto, ci vediamo in videocall martedì 6 ottobre alle 9:00 con Luca: il link per collegarti ti arriva per email.']);
    expect(impostaFaseLancio).toHaveBeenCalledWith(expect.anything(), 42, 'scelta_fatta', expect.objectContaining({ lancio_info: expect.objectContaining({ percorso: 'mattina', oraScelta: AT9, domande: 3 }) }));
    expect(eventi(calls, 'lancio_scelta')[0].payload).toMatchObject({ tipo: 'prenota', at: AT9, kind: 'mattina' });
  });

  it('pomeriggio: il testo delle Conferme con Noemi', async () => {
    genera.mockResolvedValueOnce(prenota('2026-10-06T17:00:00+02:00'));
    vi.mocked(lancioBook).mockResolvedValueOnce({ ok: true, kind: 'pomeriggio' });
    const { supabase } = makeSupabase();
    await turnoPostPitch(supabase, risposto('alle 17'), ctx());
    expect(bolle()).toEqual(['Fissato per martedì 6 ottobre alle 17:00. Ti chiamerà Noemi per confermare e mandarti il link della videocall: rispondile!']);
  });

  it('409 ora_esaurita: ripropone dalle ore AGGIORNATE del 409, non da quelle lette prima', async () => {
    genera.mockResolvedValueOnce(prenota(AT9));
    const aggiornate: LancioProssimi = { mattina: oreGiorno('2026-10-06', [11]), conferme: oreGiorno('2026-10-06', [15, 16, 17, 18, 19, 20]), saltati: [] };
    vi.mocked(lancioBook).mockResolvedValueOnce({ ok: false, motivo: 'ora_esaurita', slots: null, prossimi: aggiornate });
    const { supabase, calls } = makeSupabase();
    expect(await turnoPostPitch(supabase, risposto('alle 9'), ctx())).toBe('active');
    expect(bolle()).toEqual([`Le 9 si sono appena riempite. ${oreTesto(aggiornate, NOTTE)}`]);
    // Le due letture del blocco (primo giorno Conferme e il successivo); il 409 non rilegge.
    expect(lancioProssimi).toHaveBeenCalledTimes(2);
    expect(infoSalvata(calls)).toMatchObject({ slotsMostratiAt: NOTTE.toISOString(), percorso: null, oraScelta: null, domande: 3 });
    expect(impostaFaseLancio).not.toHaveBeenCalled();
  });

  it('409 ora_esaurita senza prossimi nel corpo: le ore si rileggono dal CRM', async () => {
    genera.mockResolvedValueOnce(prenota(AT9));
    vi.mocked(lancioBook).mockResolvedValueOnce({ ok: false, motivo: 'ora_esaurita', slots: null, prossimi: null });
    const { supabase } = makeSupabase();
    await turnoPostPitch(supabase, risposto('alle 9'), ctx());
    // Blocco (2 letture) + rilettura dopo il 409 (altre 2).
    expect(lancioProssimi).toHaveBeenCalledTimes(4);
    expect(bolle()).toEqual([`Le 9 si sono appena riempite. ${SLOT_TEXT_NOTTE}`]);
  });

  it('409 nessun_venditore su book: propone le ore', async () => {
    genera.mockResolvedValueOnce(prenota(AT9));
    vi.mocked(lancioBook).mockResolvedValueOnce({ ok: false, motivo: 'nessun_venditore' });
    const { supabase } = makeSupabase();
    await turnoPostPitch(supabase, risposto('alle 9'), ctx());
    expect(bolle()).toEqual([`${TESTO_NESSUN_VENDITORE} ${SLOT_TEXT_NOTTE}`]);
  });

  it('409 gia_prenotato su book: l ora che ha gia, nessun secondo book, scelta_fatta, closed', async () => {
    genera.mockResolvedValueOnce(prenota(AT9));
    vi.mocked(lancioBook).mockResolvedValueOnce({ ok: false, motivo: 'gia_prenotato', appointmentAt: '2026-10-07T10:00:00+02:00', kind: 'conferme' });
    const { supabase, calls } = makeSupabase();
    expect(await turnoPostPitch(supabase, risposto('alle 9'), ctx())).toBe('closed');
    expect(lancioBook).toHaveBeenCalledTimes(1);
    expect(bolle()).toEqual(['Risulta che hai già un appuntamento con noi mercoledì 7 ottobre alle 10:00: ti chiamiamo lì, non serve fissarne un altro.']);
    expect(eventi(calls, 'lancio_scelta')[0].payload).toMatchObject({ tipo: 'gia_prenotato', at: '2026-10-07T10:00:00+02:00', kind: 'conferme' });
  });

  it('422 fuori_regole: chiede un altra ora con le ore', async () => {
    genera.mockResolvedValueOnce(prenota(AT9));
    vi.mocked(lancioBook).mockResolvedValueOnce({ ok: false, motivo: 'fuori_regole' });
    const { supabase, calls } = makeSupabase();
    await turnoPostPitch(supabase, risposto('alle 9'), ctx());
    expect(bolle()).toEqual([`Quell'ora non riesco a fissarla. ${SLOT_TEXT_NOTTE}`]);
    expect(eventi(calls, 'lancio_at_non_valido')[0].payload).toMatchObject({ motivo: 'crm_fuori_regole' });
  });

  it('at fuori dalle regole dure (ora non tonda, domenica, giorno della live): niente book, si chiede un altra ora', async () => {
    const { supabase, calls } = makeSupabase();
    for (const at of ['2026-10-06T09:30:00+02:00', '2026-10-11T10:00:00+02:00', '2026-10-05T23:00:00+02:00']) {
      genera.mockResolvedValueOnce(prenota(at));
      await turnoPostPitch(supabase, scelta('boh'), ctx());
    }
    expect(lancioBook).not.toHaveBeenCalled();
    expect(bolle()).toHaveLength(3);
    for (const b of bolle()) expect(b).toBe(`Quell'ora non riesco a fissarla. ${SLOT_TEXT_NOTTE}`);
    expect(eventi(calls, 'lancio_at_non_valido').map((e) => e.payload.motivo)).toEqual(['ora_non_tonda', 'giorno_non_ammesso', 'giorno_non_ammesso']);
  });

  it('500 dal CRM: testo di errore, active', async () => {
    genera.mockResolvedValueOnce(prenota(AT9));
    vi.mocked(lancioBook).mockResolvedValueOnce({ ok: false, motivo: 'http', status: 500, detail: 'boom' });
    const { supabase } = makeSupabase();
    expect(await turnoPostPitch(supabase, risposto('alle 9'), ctx())).toBe('active');
    expect(bolle()).toEqual([TESTO_ERRORE_CRM]);
  });
});

// ── Le tre strade (PO 02/10, Task 8) ──────────────────────────────────────────────────
//
// La scelta viene prima, le domande dopo e per strada: due per la chiamata subito, tre
// per la mattina col venditore (prequalifica) e per le Conferme. Lo stato vive in
// `lancio_info` (percorso, oraScelta, domande) e al CRM va solo `{ risposte }`.
describe('turnoPostPitch — le tre strade', () => {
  const AT10 = '2026-10-06T10:00:00+02:00';
  const AT7_10 = '2026-10-07T10:00:00+02:00';

  it('1. notte, tap "Chiamami subito": nessuna chiamata, percorso chiamata, UNA bolla con la prima domanda', async () => {
    genera.mockResolvedValueOnce(modello({ visibleReply: 'Cosa ti spinge a voler fare un percorso come questo?' }));
    const { supabase, calls } = makeSupabase();
    expect(await turnoPostPitch(supabase, scelta('Chiamami subito'), ctx())).toBe('active');
    expect(lancioCallNow).not.toHaveBeenCalled();
    expect(genera).toHaveBeenCalledTimes(1);
    expect(genera.mock.calls[0][1]).toMatchObject({ percorso: 'chiamata', domandeFatte: 0 });
    expect(bolle()).toEqual(['Cosa ti spinge a voler fare un percorso come questo?']);
    expect(infoSalvata(calls)).toMatchObject({ percorso: 'chiamata', domande: 0 });
  });

  it('1b. notte, il modello mette CHIAMA_ORA senza percorso: si rigenera con il percorso chiamata', async () => {
    genera.mockResolvedValueOnce(modello({ visibleReply: 'Ok!', lancioTag: { tag: 'CHIAMA_ORA' } }));
    genera.mockResolvedValueOnce(modello({ visibleReply: 'Cosa ti spinge a voler fare un percorso come questo?' }));
    const { supabase, calls } = makeSupabase();
    expect(await turnoPostPitch(supabase, scelta('chiamami adesso'), ctx())).toBe('active');
    expect(lancioCallNow).not.toHaveBeenCalled();
    expect(genera.mock.calls[0][1]).toMatchObject({ percorso: null });
    expect(genera.mock.calls[1][1]).toMatchObject({ percorso: 'chiamata', domandeFatte: 0 });
    expect(bolle()).toEqual(['Cosa ti spinge a voler fare un percorso come questo?']);
    expect(infoSalvata(calls)).toMatchObject({ percorso: 'chiamata', domande: 0 });
  });

  it('2. percorso chiamata, domande 1, arriva la seconda risposta: call-now con tutte e due le risposte', async () => {
    genera.mockResolvedValueOnce(modello({ visibleReply: 'E perché proprio adesso?' }));
    vi.mocked(lancioCallNow).mockResolvedValueOnce({ ok: true, venditore: { id: 'u7', nome: 'Luca' } });
    const { supabase } = makeSupabase();
    const chat = base({
      rows: [LINK, PULSANTE, inb('Chiamami subito'), out('Cosa ti spinge?'), inb('voglio cambiare lavoro'), out('E perché proprio adesso?'), inb('ho appena perso il posto')],
      inboundBody: 'ho appena perso il posto',
      lancioInfo: { risposte: ['Chiamami subito', 'voglio cambiare lavoro'], percorso: 'chiamata', domande: 1 },
    });
    expect(await turnoPostPitch(supabase, chat, ctx())).toBe('closed');
    expect(genera.mock.calls[0][1]).toMatchObject({ percorso: 'chiamata', domandeFatte: 2 });
    expect(lancioCallNow).toHaveBeenCalledWith({ leadId: 'crm-L1', info: { risposte: ['Chiamami subito', 'voglio cambiare lavoro', 'ho appena perso il posto'] }, note: NOTA_SCELTA });
    expect(bolle()).toEqual([testoConfermaChiamata('Luca')]);
  });

  it('3. percorso chiamata, domande 0, obiezione: il modello mette CHIAMA_ORA e si chiama subito', async () => {
    genera.mockResolvedValueOnce(modello({ visibleReply: 'Ne parli direttamente col tutor!', lancioTag: { tag: 'CHIAMA_ORA' } }));
    vi.mocked(lancioCallNow).mockResolvedValueOnce({ ok: true, venditore: { id: 'u7', nome: 'Luca' } });
    const { supabase } = makeSupabase();
    expect(await turnoPostPitch(supabase, inPercorso('non mi va di rispondere, chiamami', { percorso: 'chiamata', domande: 0 }), ctx())).toBe('closed');
    expect(lancioCallNow).toHaveBeenCalledTimes(1);
    expect(bolle()).toEqual([testoConfermaChiamata('Luca')]);
  });

  it('4. PRENOTA sulla mattina del 6 senza percorso: niente book, percorso mattina, la bolla comincia con la prequalifica', async () => {
    genera.mockResolvedValueOnce(modello({ visibleReply: 'Perfetto', lancioTag: { tag: 'PRENOTA', at: AT10 } }));
    genera.mockResolvedValueOnce(modello({ visibleReply: 'Cosa non va oggi nel tuo lavoro?', lancioTag: { tag: 'CONFERMA' } }));
    const { supabase, calls } = makeSupabase();
    expect(await turnoPostPitch(supabase, scelta('domattina alle 10'), ctx())).toBe('active');
    expect(lancioBook).not.toHaveBeenCalled();
    expect(genera.mock.calls[1][1]).toMatchObject({ percorso: 'mattina', domandeFatte: 0 });
    expect(bolle()).toEqual([`${TESTO_INTRO_PREQUALIFICA} Cosa non va oggi nel tuo lavoro?`]);
    expect(infoSalvata(calls)).toMatchObject({ percorso: 'mattina', oraScelta: AT10, domande: 0 });
  });

  it('5. percorso mattina, domande 2, arriva la terza risposta: book con oraScelta, conferma col venditore', async () => {
    genera.mockResolvedValueOnce(modello({ visibleReply: 'Ottimo!', lancioTag: { tag: 'CONFERMA' } }));
    vi.mocked(lancioBook).mockResolvedValueOnce({ ok: true, kind: 'mattina', venditore: { id: 'u7', nome: 'Luca' } });
    const { supabase } = makeSupabase();
    expect(await turnoPostPitch(supabase, inPercorso('sì, mi va bene', { percorso: 'mattina', oraScelta: AT10, domande: 2 }), ctx())).toBe('closed');
    expect(lancioBook).toHaveBeenCalledWith({ leadId: 'crm-L1', at: AT10, info: { risposte: ['studio informatica', 'il progetto finale', 'sì, mi va bene'] }, note: NOTA_SCELTA });
    expect(bolle()).toEqual(['Perfetto, ci vediamo in videocall martedì 6 ottobre alle 10:00 con Luca: il link per collegarti ti arriva per email.']);
  });

  it('6. mattina esaurita dopo le domande: percorso azzerato, domande restano; al turno dopo il 7 si prenota SUBITO', async () => {
    genera.mockResolvedValueOnce(modello({ visibleReply: 'Ottimo!' }));
    const dopo: LancioProssimi = { mattina: null, conferme: oreGiorno('2026-10-07', [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]), saltati: ['2026-10-06'] };
    vi.mocked(lancioBook).mockResolvedValueOnce({ ok: false, motivo: 'ora_esaurita', slots: null, prossimi: dopo });
    const primo = makeSupabase();
    expect(await turnoPostPitch(primo.supabase, inPercorso('sì, mi va bene', { percorso: 'mattina', oraScelta: AT10, domande: 2 }), ctx())).toBe('active');
    expect(lancioBook).toHaveBeenCalledTimes(1);
    const salvata = infoSalvata(primo.calls);
    expect(salvata).toMatchObject({ percorso: null, oraScelta: null, domande: 3 });
    expect(bolle()[0]).toContain('si sono appena riempite');
    expect(bolle()[0]).toContain('mercoledì 7 ottobre');

    // Turno dopo: il lead sceglie le 10 del 7. Le domande le ha gia' fatte: book subito.
    vi.mocked(sendFreeText).mockClear();
    genera.mockResolvedValueOnce(modello({ lancioTag: { tag: 'PRENOTA', at: AT7_10 } }));
    vi.mocked(lancioBook).mockResolvedValueOnce({ ok: true, kind: 'conferme' });
    const secondo = makeSupabase();
    const chat = scelta('mercoledì alle 10', { lancioInfo: salvata });
    expect(await turnoPostPitch(secondo.supabase, chat, ctx())).toBe('closed');
    expect(genera).toHaveBeenCalledTimes(2);
    expect(lancioBook).toHaveBeenLastCalledWith(expect.objectContaining({ at: AT7_10 }));
    expect(bolle()).toEqual(['Fissato per mercoledì 7 ottobre alle 10:00. Ti chiamerà Noemi per confermare e mandarti il link della videocall: rispondile!']);
  });

  it('7. percorso conferme, domande 1, PRENOTA su un altra ora: oraScelta aggiornata, domande restano 1, niente book', async () => {
    genera.mockResolvedValueOnce(modello({ lancioTag: { tag: 'PRENOTA', at: AT7_10 } }));
    genera.mockResolvedValueOnce(modello({ visibleReply: 'Cosa vorresti cambiare?' }));
    const { supabase, calls } = makeSupabase();
    const chat = inPercorso('meglio alle 10 del 7', { percorso: 'conferme', oraScelta: '2026-10-06T17:00:00+02:00', domande: 1 });
    expect(await turnoPostPitch(supabase, chat, ctx())).toBe('active');
    expect(lancioBook).not.toHaveBeenCalled();
    expect(infoSalvata(calls)).toMatchObject({ percorso: 'conferme', oraScelta: AT7_10, domande: 1 });
    // Il percorso c'era gia': niente seconda introduzione.
    expect(bolle()).toEqual(['Cosa vorresti cambiare?']);
  });

  it('8. percorso conferme oltre il tetto di sicurezza, il modello non chiude: si prenota lo stesso', async () => {
    genera.mockResolvedValueOnce(modello({ visibleReply: 'E poi?' }));
    vi.mocked(lancioBook).mockResolvedValueOnce({ ok: true, kind: 'conferme' });
    const { supabase } = makeSupabase();
    expect(await turnoPostPitch(supabase, inPercorso('boh', { percorso: 'conferme', oraScelta: AT7_10, domande: 5 }), ctx())).toBe('closed');
    expect(lancioBook).toHaveBeenCalledWith(expect.objectContaining({ at: AT7_10 }));
  });

  it('9. book ok con kind conferme: il testo delle Conferme con Noemi e il giorno assoluto', async () => {
    genera.mockResolvedValueOnce(modello({ lancioTag: { tag: 'CONFERMA' } }));
    vi.mocked(lancioBook).mockResolvedValueOnce({ ok: true, kind: 'conferme' });
    const { supabase } = makeSupabase();
    expect(await turnoPostPitch(supabase, inPercorso('non saprei', { percorso: 'conferme', oraScelta: AT7_10, domande: 1 }), ctx())).toBe('closed');
    expect(bolle()).toEqual(['Fissato per mercoledì 7 ottobre alle 10:00. Ti chiamerà Noemi per confermare e mandarti il link della videocall: rispondile!']);
  });

  it('10. tap "Fissiamo domani" col pomeriggio del 6 pieno: la bolla dice "pieni" e propone il 7', async () => {
    vi.mocked(lancioProssimi).mockResolvedValue({ ok: true, prossimi: { mattina: oreGiorno('2026-10-06', [9, 11]), conferme: oreGiorno('2026-10-07', [9, 10, 11]), saltati: ['2026-10-06'] } });
    const { supabase } = makeSupabase();
    expect(await turnoPostPitch(supabase, scelta('Fissiamo domani'), ctx())).toBe('active');
    expect(genera).not.toHaveBeenCalled();
    expect(bolle()[0]).toContain('pieni');
    expect(bolle()[0]).toContain('mercoledì 7 ottobre');
  });

  it('nessuna ora in nessuna delle due corsie: TESTO_NESSUNA_ORA e la nota al CRM', async () => {
    vi.mocked(lancioProssimi).mockResolvedValue({ ok: true, prossimi: { mattina: null, conferme: null, saltati: [] } });
    const { supabase, calls } = makeSupabase();
    await turnoPostPitch(supabase, scelta('Fissiamo domani'), ctx());
    expect(bolle()).toEqual([TESTO_NESSUNA_ORA]);
    expect(vi.mocked(sendCrmNota).mock.calls[0][2]).toContain('30 giorni');
    expect(eventi(calls, 'lancio_slots_vuoti')).toHaveLength(1);
  });

  // Fix round 1: `domande` passa SOLO fra le due strade di prenotazione (spec §2.2 p.4).
  it('a. chiamata senza venditori, poi un ora della mattina: prequalifica da capo (domande 0), niente book', async () => {
    genera.mockResolvedValueOnce(modello({ visibleReply: 'Ok!' }));
    vi.mocked(lancioCallNow).mockResolvedValueOnce({ ok: false, motivo: 'nessun_venditore' });
    const primo = makeSupabase();
    expect(await turnoPostPitch(primo.supabase, inPercorso('perché ho perso il lavoro', { percorso: 'chiamata', domande: 1 }), ctx())).toBe('active');
    expect(lancioCallNow).toHaveBeenCalledTimes(1);
    const salvata = infoSalvata(primo.calls);
    expect(salvata).toMatchObject({ percorso: null, domande: 0 });

    vi.mocked(sendFreeText).mockClear();
    genera.mockResolvedValueOnce(modello({ lancioTag: { tag: 'PRENOTA', at: AT10 } }));
    genera.mockResolvedValueOnce(modello({ visibleReply: 'Cosa non va oggi nel tuo lavoro?' }));
    const secondo = makeSupabase();
    expect(await turnoPostPitch(secondo.supabase, scelta('domattina alle 10', { lancioInfo: salvata }), ctx())).toBe('active');
    expect(lancioBook).not.toHaveBeenCalled();
    expect(genera.mock.calls[2][1]).toMatchObject({ percorso: 'mattina', domandeFatte: 0 });
    expect(infoSalvata(secondo.calls)).toMatchObject({ percorso: 'mattina', oraScelta: AT10, domande: 0 });
    expect(bolle()).toEqual([`${TESTO_INTRO_PREQUALIFICA} Cosa non va oggi nel tuo lavoro?`]);
  });

  it('a2. PRENOTA direttamente dalla chiamata: il conteggio della chiamata non vale per la prenotazione', async () => {
    genera.mockResolvedValueOnce(modello({ lancioTag: { tag: 'PRENOTA', at: AT10 } }));
    genera.mockResolvedValueOnce(modello({ visibleReply: 'Cosa non va oggi nel tuo lavoro?' }));
    const { supabase, calls } = makeSupabase();
    expect(await turnoPostPitch(supabase, inPercorso('anzi, domattina alle 10', { percorso: 'chiamata', domande: 2 }), ctx())).toBe('active');
    expect(lancioBook).not.toHaveBeenCalled();
    expect(lancioCallNow).not.toHaveBeenCalled();
    expect(infoSalvata(calls)).toMatchObject({ percorso: 'mattina', oraScelta: AT10, domande: 0 });
    expect(bolle()[0].startsWith(TESTO_INTRO_PREQUALIFICA)).toBe(true);
  });

  it('b. mattina a meta delle domande, di notte chiede la chiamata: percorso chiamata da capo, ora scelta cancellata', async () => {
    genera.mockResolvedValueOnce(modello({ lancioTag: { tag: 'CHIAMA_ORA' } }));
    genera.mockResolvedValueOnce(modello({ visibleReply: 'Cosa ti spinge a voler fare un percorso come questo?' }));
    const { supabase, calls } = makeSupabase();
    expect(await turnoPostPitch(supabase, inPercorso('anzi chiamami adesso', { percorso: 'mattina', oraScelta: AT10, domande: 2 }), ctx())).toBe('active');
    expect(lancioCallNow).not.toHaveBeenCalled();
    expect(lancioBook).not.toHaveBeenCalled();
    expect(genera.mock.calls[1][1]).toMatchObject({ percorso: 'chiamata', domandeFatte: 0 });
    expect(infoSalvata(calls)).toMatchObject({ percorso: 'chiamata', domande: 0, oraScelta: null });
    expect(bolle()).toEqual(['Cosa ti spinge a voler fare un percorso come questo?']);
  });

  it('il testo "nessun venditore" non nomina ne stasera ne domani: esce anche alle 01:00 del 6', () => {
    expect(TESTO_NESSUN_VENDITORE).toBe('In questo momento i consulenti sono tutti al telefono: fissiamo una videocall.');
    expect(TESTO_NESSUN_VENDITORE).not.toMatch(/stasera|domani|oggi/i);
  });

  it('al CRM va solo { risposte }: percorso, oraScelta e domande restano nel bot', async () => {
    genera.mockResolvedValueOnce(modello({ lancioTag: { tag: 'CONFERMA' } }));
    vi.mocked(lancioBook).mockResolvedValueOnce({ ok: true, kind: 'conferme' });
    const { supabase } = makeSupabase();
    await turnoPostPitch(supabase, inPercorso('ok', { percorso: 'conferme', oraScelta: AT7_10, domande: 2, slotsMostratiAt: 'x' }), ctx());
    expect(Object.keys(vi.mocked(lancioBook).mock.calls[0][0].info!)).toEqual(['risposte']);
  });
});

describe('turnoPostPitch — [LANCIO:SLOTS], [LANCIO:NO], finestra', () => {
  it('SLOTS: le ore scritte dal codice, slotsMostratiAt salvato, evento', async () => {
    genera.mockResolvedValueOnce(modello({ visibleReply: 'Vediamo le ore', lancioTag: { tag: 'SLOTS' } }));
    const { supabase, calls } = makeSupabase();
    expect(await turnoPostPitch(supabase, scelta('domani'), ctx())).toBe('active');
    expect(bolle()).toEqual([SLOT_TEXT_NOTTE]);
    expect(infoSalvata(calls)).toEqual({ risposte: ['studio informatica', 'il progetto finale', 'domani'], slotsMostratiAt: NOTTE.toISOString() });
    expect(eventi(calls, 'lancio_slots_mostrati')[0].payload).toMatchObject({
      mattina: { date: '2026-10-06', ore: [9, 11, 14] }, conferme: { date: '2026-10-06', ore: [15, 16, 17, 18, 19, 20] }, saltati: [],
    });
  });

  // Cambio di comportamento (Task 8): prima, col CRM giu', si proponevano pomeriggio e
  // dopodomani a scatola chiusa. Ora le Conferme hanno un tetto per ora e senza CRM non si
  // sa quali ore sono libere: si chiede di riscrivere, senza inventare niente.
  it('SLOTS con il CRM giù: nessuna ora inventata, testo di errore, evento warn letto una volta sola', async () => {
    vi.mocked(lancioProssimi).mockResolvedValue({ ok: false, motivo: 'rete', detail: 'timeout' });
    genera.mockResolvedValueOnce(modello({ lancioTag: { tag: 'SLOTS' } }));
    const { supabase, calls } = makeSupabase();
    expect(await turnoPostPitch(supabase, scelta('domani'), ctx())).toBe('active');
    expect(bolle()).toEqual([TESTO_ERRORE_CRM]);
    expect(lancioProssimi).toHaveBeenCalledTimes(1);
    expect(genera.mock.calls[0][1].bloccoSlot).toBeNull();
    expect(eventi(calls, 'lancio_slots_non_letti')[0].level).toBe('warn');
    expect(eventi(calls, 'lancio_slots_mostrati')).toHaveLength(0);
  });

  it('NO: congedo post-pitch, fase chiuso, risposte salvate, DA_SCARTARE "non interessato", closed', async () => {
    genera.mockResolvedValueOnce(modello({ classe: 'no', visibleReply: 'Capisco.', lancioTag: { tag: 'NO' } }));
    const { supabase, calls } = makeSupabase();
    expect(await turnoPostPitch(supabase, scelta('no, non mi interessa'), ctx())).toBe('closed');
    // Il congedo del post-pitch ha il SUO testo: quello del B1 parla della sera del 5.
    expect(bolle()).toEqual([TESTO_CONGEDO_POST_PITCH]);
    expect(bolle()[0]).not.toBe(TESTO_CONGEDO);
    expect(infoSalvata(calls)).toEqual({ risposte: ['studio informatica', 'il progetto finale', 'no, non mi interessa'] });
    expect(marcaCongedo).toHaveBeenCalled();
    expect(impostaFaseLancio).toHaveBeenCalledWith(expect.anything(), 42, 'chiuso');
    expect(vi.mocked(sendOutcome).mock.calls[0][2]).toMatchObject({ outcome: 'DA_SCARTARE', discardReason: 'non interessato', leadWords: 'no, non mi interessa' });
    expect(eventi(calls, 'lancio_congedo')).toHaveLength(1);
  });

  it('lotto: "ok" e poi "no, toglimi dalla lista" ⇒ congedo con le parole VERE, e tutte e due nelle risposte', async () => {
    genera.mockResolvedValueOnce(modello({ classe: 'no', lancioTag: { tag: 'NO' } }));
    const { supabase, calls } = makeSupabase();
    const conLotto = base({
      rows: [LINK, PULSANTE, out('Cosa fai oggi?'), inb('ok'), inb('no, toglimi dalla lista')],
      inboundBody: 'ok', lancioInfo: { risposte: [] },
    });
    expect(await turnoPostPitch(supabase, conLotto, ctx())).toBe('closed');
    expect(vi.mocked(sendOutcome).mock.calls[0][2]).toMatchObject({ outcome: 'DA_SCARTARE', leadWords: 'no, toglimi dalla lista' });
    expect(infoSalvata(calls)).toEqual({ risposte: ['ok', 'no, toglimi dalla lista'] });
  });

  it('lotto: due messaggi nel percorso contano due risposte e vanno al CRM interi', async () => {
    genera.mockResolvedValueOnce(modello({ visibleReply: 'E perché proprio adesso?' }));
    vi.mocked(lancioCallNow).mockResolvedValueOnce({ ok: true, venditore: { id: 'u7', nome: 'Luca' } });
    const { supabase } = makeSupabase();
    const conLotto = base({
      rows: [LINK, PULSANTE, out('Cosa ti spinge?'), inb('studio informatica'), inb('e mi chiami adesso?')],
      inboundBody: 'studio informatica', lancioInfo: { risposte: [], percorso: 'chiamata', domande: 0 },
    });
    await turnoPostPitch(supabase, conLotto, ctx());
    expect(lancioCallNow).toHaveBeenCalledWith(expect.objectContaining({ info: { risposte: ['studio informatica', 'e mi chiami adesso?'] } }));
  });

  it('congedo gia uscito (il CRM aveva rifiutato lo scarto): si ritenta solo l esito, niente modello e niente seconda bolla', async () => {
    const { supabase, calls } = makeSupabase();
    const congedato = scelta('ok va bene', { lancioInfo: { risposte: ['studio informatica'], congedo_at: '2026-10-05T22:45:00+02:00' } });
    expect(await turnoPostPitch(supabase, congedato, ctx())).toBe('closed');
    expect(genera).not.toHaveBeenCalled();
    expect(sendFreeText).not.toHaveBeenCalled();
    expect(vi.mocked(sendOutcome).mock.calls[0][2]).toMatchObject({ outcome: 'DA_SCARTARE', discardReason: 'non interessato' });
    expect(impostaFaseLancio).toHaveBeenCalledWith(expect.anything(), 42, 'chiuso');
    expect(eventi(calls, 'lancio_congedo')[0].payload).toMatchObject({ ritentato: true });
  });

  it('congedo gia uscito e CRM ancora giu: active, fase non chiusa, si ritenta al turno dopo', async () => {
    vi.mocked(sendOutcome).mockResolvedValueOnce({ sent: false, status: 500 });
    const { supabase } = makeSupabase();
    const congedato = scelta('ci sei?', { lancioInfo: { risposte: [], congedo_at: '2026-10-05T22:45:00+02:00' } });
    expect(await turnoPostPitch(supabase, congedato, ctx())).toBe('active');
    expect(impostaFaseLancio).not.toHaveBeenCalled();
    expect(sendFreeText).not.toHaveBeenCalled();
  });

  // Come nell'assistenza: senza niente da leggere il turno tace, ma lascia la traccia o
  // il re-drive di bot-followups ci ritorna sopra ogni ora.
  it('solo media nel lotto: silenzio tracciato, niente modello, niente bolla, niente CRM', async () => {
    const { supabase, calls } = makeSupabase();
    const stato = await turnoPostPitch(supabase, base({ rows: [LINK, PULSANTE, out('Ciao Anna! Cosa fai oggi?'), inb('')], inboundBody: '' }), ctx());
    expect(stato).toBe('active');
    expect(genera).not.toHaveBeenCalled();
    expect(sendFreeText).not.toHaveBeenCalled();
    expect(pushLeadEntrante).not.toHaveBeenCalled();
    expect(lancioProssimi).not.toHaveBeenCalled();
    expect(infoSalvata(calls)).toBeUndefined();
    expect(eventi(calls, 'lancio_silenzio')[0].payload).toMatchObject({ motivo: 'inbound_senza_testo', definitivo: true });
    expect(eventi(calls, 'fenice_ai_reply')).toHaveLength(1);
  });

  // Il lotto vuoto e' il caso del taglio: se dopo l'ultima nostra bolla non c'e' nessun
  // inbound, il turno non ha una cronologia da mandare al modello ne' un primo messaggio
  // da spingere al CRM. Prima spendeva comunque una bolla.
  it('lotto vuoto: stessa strada, il turno non parte', async () => {
    const { supabase, calls } = makeSupabase();
    const stato = await turnoPostPitch(supabase, base({ rows: [LINK, PULSANTE, out('Ciao Anna! Cosa fai oggi?')], inboundBody: '' }), ctx());
    expect(stato).toBe('active');
    expect(sendFreeText).not.toHaveBeenCalled();
    expect(eventi(calls, 'lancio_silenzio')[0].payload).toMatchObject({ motivo: 'inbound_senza_testo', definitivo: true });
  });

  // Il pulsante premuto alle 20:40 del 5, prima che la live cominci. Fuori dalla notte
  // del webinar: niente chiamata immediata e niente proposta spontanea della mattina del
  // 6 (la regola di `modoPostPitch`, invariata). Le PAROLE pero' sono quelle di chi
  // scrive il 5: il 7 e' "mercoledi 7 ottobre", non "domani mattina". Prima la bolla
  // diceva "oggi pomeriggio" parlando del pomeriggio del 6 e "domani mattina" del 7.
  it('alle 20:40 del 5 i giorni si chiamano col nome del 5, e CHIAMA_ORA diventa la videocall', async () => {
    const ora = new Date('2026-10-05T20:40:00+02:00');
    genera.mockResolvedValueOnce(modello({ lancioTag: { tag: 'CHIAMA_ORA' } }));
    const { supabase, calls } = makeSupabase();
    await turnoPostPitch(supabase, scelta('chiamami ora'), ctx(ora));
    expect(genera.mock.calls[0][1].modo).toBe('giorno');
    expect(lancioCallNow).not.toHaveBeenCalled();
    expect(bolle()[0]).toBe(`${TESTO_CHIAMATA_FUORI_ORARIO} ${oreTesto(PROSSIMI, ora)}`);
    expect(bolle()[0]).toContain('domani pomeriggio dalle 15 alle 20');
    expect(infoSalvata(calls).percorso ?? null).toBeNull();
  });

  // Alle 02:00 del 6 le due decisioni divergono: la chiamata immediata c'e' ancora
  // (`modo` notte) e con lei la proposta della mattina, ma i giorni si chiamano come li
  // chiama chi scrive il 6 — "stamattina", non "domattina".
  it('alle 02:00 del 6 la mattina si propone ancora, con le parole di oggi', async () => {
    genera.mockResolvedValueOnce(modello({ lancioTag: { tag: 'SLOTS' } }));
    const { supabase } = makeSupabase();
    await turnoPostPitch(supabase, scelta('una call'), ctx(new Date('2026-10-06T02:00:00+02:00')));
    expect(genera.mock.calls[0][1].modo).toBe('notte');
    expect(bolle()[0]).toBe('Per la videocall ho stamattina alle 9, alle 11 o alle 14, oppure oggi pomeriggio dalle 15 alle 20: a che ora ci saresti?');
  });

  it('modello vuoto senza tag: silenzio definitivo', async () => {
    genera.mockResolvedValueOnce(modello({ visibleReply: '' }));
    const { supabase, calls } = makeSupabase();
    await turnoPostPitch(supabase, base(), ctx());
    expect(sendFreeText).not.toHaveBeenCalled();
    expect(eventi(calls, 'lancio_silenzio')[0].payload).toMatchObject({ motivo: 'risposta_vuota', definitivo: true });
  });
});

describe('turnoPostPitch — numero sconosciuto senza crm_lead_id', () => {
  it('prima della scelta rilegge crm_lead_id, lo chiede al CRM con pushLeadEntrante e poi sceglie con quel leadId', async () => {
    genera.mockResolvedValueOnce(modello({ lancioTag: { tag: 'CHIAMA_ORA' } }));
    vi.mocked(lancioCallNow).mockResolvedValueOnce({ ok: true, venditore: { id: 'u1', nome: 'Sara' } });
    const { supabase } = makeSupabase(null);
    expect(await turnoPostPitch(supabase, { ...inPercorso('adesso', { percorso: 'chiamata', domande: 1 }), crmLeadId: null }, ctx())).toBe('closed');
    expect(pushLeadEntrante).toHaveBeenCalledWith(expect.anything(), {
      conversationId: 42, telefono: '+393331234567', nome: 'Anna', provenienza: PROVENIENZA_LANCIO,
      primoMessaggio: MARKER, scrittoIl: '2026-10-05T22:38:00+02:00',
    });
    expect(PROVENIENZA_LANCIO).toBe('Lancio Web Dev AI');
    expect(lancioCallNow).toHaveBeenCalledWith(expect.objectContaining({ leadId: 'crm-NEW' }));
    expect(bolle()).toEqual(["Perfetto, ti faccio chiamare subito da Sara. È una chiamata breve per valutare insieme le ultime cose e fare l'iscrizione, così blocchi il tuo posto: sono limitati."]);
  });

  it('chat riusata: il primo messaggio spinto al CRM e quello del PULSANTE, non il vecchio giro di Mario', async () => {
    genera.mockResolvedValueOnce(modello({ lancioTag: { tag: 'CHIAMA_ORA' } }));
    vi.mocked(lancioCallNow).mockResolvedValueOnce({ ok: true, venditore: { id: 'u1', nome: 'Sara' } });
    const { supabase } = makeSupabase(null);
    const riusata = base({
      crmLeadId: null,
      rows: [
        out('Ciao, sono Mario di Fenice'),
        inb('vorrei informazioni sul corso', '2026-09-01T10:00:00+02:00'),
        LINK, PULSANTE, out('Preferisci adesso o domani?'), inb('adesso'),
      ],
      inboundBody: 'adesso', lancioInfo: { risposte: ['studio informatica', 'il progetto finale'], percorso: 'chiamata', domande: 1 },
    });
    await turnoPostPitch(supabase, riusata, ctx());
    expect(vi.mocked(pushLeadEntrante).mock.calls[0][1]).toMatchObject({
      primoMessaggio: MARKER, scrittoIl: '2026-10-05T22:38:00+02:00',
    });
  });

  it('se il push del webhook e arrivato nel frattempo (crm_lead_id a DB) non si rispinge', async () => {
    genera.mockResolvedValueOnce(modello({ lancioTag: { tag: 'CHIAMA_ORA' } }));
    vi.mocked(lancioCallNow).mockResolvedValueOnce({ ok: true, venditore: { id: 'u1', nome: 'Sara' } });
    const { supabase } = makeSupabase('crm-DB');
    await turnoPostPitch(supabase, { ...inPercorso('adesso', { percorso: 'chiamata', domande: 1 }), crmLeadId: null }, ctx());
    expect(pushLeadEntrante).not.toHaveBeenCalled();
    expect(lancioCallNow).toHaveBeenCalledWith(expect.objectContaining({ leadId: 'crm-DB' }));
  });

  it('push fallito: testo di errore, evento lancio_lead_senza_crm, nessuna scelta', async () => {
    genera.mockResolvedValueOnce(modello({ lancioTag: { tag: 'PRENOTA', at: '2026-10-06T09:00:00+02:00' } }));
    vi.mocked(pushLeadEntrante).mockResolvedValueOnce({ ok: false, motivo: 'http_500' });
    const { supabase, calls } = makeSupabase(null);
    expect(await turnoPostPitch(supabase, { ...inPercorso('alle 9', { domande: 3 }), crmLeadId: null }, ctx())).toBe('active');
    expect(lancioBook).not.toHaveBeenCalled();
    expect(bolle()).toEqual([TESTO_ERRORE_CRM]);
    expect(eventi(calls, 'lancio_lead_senza_crm')[0].level).toBe('error');
  });
});

describe('turnoDopoScelta — fase scelta_fatta', () => {
  it('primo messaggio dopo la scelta: "Ricevuto" una volta, le parole al CRM come nota, closed', async () => {
    const { supabase, calls } = makeSupabase();
    const stato = await turnoDopoScelta(supabase, base({ fase: 'scelta_fatta', rows: [LINK, PULSANTE, out("Perfetto, ti faccio chiamare subito da Luca. È una chiamata breve per valutare insieme le ultime cose e fare l'iscrizione, così blocchi il tuo posto: sono limitati."), inb('grazie, aspetto')], inboundBody: 'grazie, aspetto' }), ctx());
    expect(stato).toBe('closed');
    expect(bolle()).toEqual([TESTO_DOPO_SCELTA]);
    expect(vi.mocked(sendCrmNota).mock.calls[0].slice(1)).toEqual([42, expect.stringContaining('"grazie, aspetto"')]);
    expect(eventi(calls, 'lancio_dopo_scelta')).toHaveLength(1);
    expect(eventi(calls, 'fenice_ai_reply')).toHaveLength(1);
  });

  it('dal secondo in poi: silenzio definitivo, ma la nota al CRM parte comunque', async () => {
    const { supabase, calls } = makeSupabase();
    await turnoDopoScelta(supabase, base({ fase: 'scelta_fatta', rows: [LINK, PULSANTE, out('Perfetto...'), inb('grazie'), out(TESTO_DOPO_SCELTA), inb('alle 9 non posso più')], inboundBody: 'alle 9 non posso più' }), ctx());
    expect(sendFreeText).not.toHaveBeenCalled();
    expect(sendCrmNota).toHaveBeenCalledTimes(1);
    expect(eventi(calls, 'lancio_silenzio')[0].payload).toMatchObject({ motivo: 'dopo_scelta', definitivo: true });
  });

  it('senza crm_lead_id la nota si tenta lo stesso (la rilettura la fa sendCrmNota): warn se non parte, "Ricevuto" comunque', async () => {
    vi.mocked(sendCrmNota).mockResolvedValueOnce({ sent: false, error: 'not_crm_lead' });
    const { supabase, calls } = makeSupabase(null);
    await turnoDopoScelta(supabase, base({ fase: 'scelta_fatta', crmLeadId: null, rows: [LINK, PULSANTE, out('Perfetto...'), inb('ok')], inboundBody: 'ok' }), ctx());
    expect(sendCrmNota).toHaveBeenCalledTimes(1);
    expect(eventi(calls, 'lancio_nota_dopo_scelta_non_inviata')[0].level).toBe('warn');
    expect(bolle()).toEqual([TESTO_DOPO_SCELTA]);
  });

  it('il lotto intero nella nota: "ok" + "alle 9 non posso più" arrivano tutti e due al CRM', async () => {
    const { supabase } = makeSupabase();
    await turnoDopoScelta(supabase, base({ fase: 'scelta_fatta', rows: [LINK, PULSANTE, out('Perfetto...'), inb('ok'), inb('alle 9 non posso più')], inboundBody: 'ok' }), ctx());
    const nota = vi.mocked(sendCrmNota).mock.calls[0][2];
    expect(nota).toContain('alle 9 non posso più');
    expect(nota).toContain('ok');
  });

  it('alle 04:00 non si risponde e non si annota: silenzio temporaneo, la nota parte al re-drive', async () => {
    const { supabase, calls } = makeSupabase();
    const stato = await turnoDopoScelta(supabase, base({ fase: 'scelta_fatta', rows: [LINK, PULSANTE, out('Perfetto...'), inb('ci sei?')], inboundBody: 'ci sei?' }), ctx(new Date('2026-10-06T04:00:00+02:00')));
    expect(stato).toBe('active');
    expect(sendCrmNota).not.toHaveBeenCalled();
    expect(sendFreeText).not.toHaveBeenCalled();
    expect(eventi(calls, 'lancio_silenzio')[0].payload).toMatchObject({ motivo: 'fuori_orario', definitivo: false });
    expect(eventi(calls, 'fenice_ai_reply')).toHaveLength(0);
  });
});

// ── La scelta a pulsanti (delibera PO 17/09) ──────────────────────────────────────────
//
// Il 14/09, in prova, il lead ha risposto "Adessi" alla domanda scritta. Da qui la domanda
// esce come template a due quick reply, e il titolo che torna si classifica PRIMA del
// modello. Se i pulsanti non possono partire (env assente, template bloccato da
// UTILITY_ONLY, Twilio in errore) il turno non fallisce: esce la stessa domanda scritta.
describe('turnoPostPitch — la scelta esce con i pulsanti', () => {
  const templates = () => vi.mocked(sendTemplate).mock.calls.map((c) => c[0]);
  /** Il modello ha appena scritto la domanda della scelta del modo. */
  const chiedeLaScelta = (modo: 'notte' | 'giorno') =>
    genera.mockResolvedValueOnce(modello({ visibleReply: testoScelta(modo) }));

  afterEach(() => { vi.unstubAllEnvs(); });

  it('di notte: parte il template della notte, nessuna bolla di testo, evento inviato', async () => {
    vi.stubEnv('LANCIO_SCELTA_NOTTE_TEMPLATE_SID', 'HX_SCELTA_NOTTE');
    chiedeLaScelta('notte');
    const { supabase, calls } = makeSupabase();
    const stato = await turnoPostPitch(supabase, scelta('il progetto finale'), ctx());
    expect(stato).toBe('active');
    expect(templates()).toHaveLength(1);
    expect(templates()[0]).toMatchObject({ to: '+393331234567', contentSid: 'HX_SCELTA_NOTTE', variables: {} });
    expect(bolle()).toEqual([]);
    // In `messages` finisce il corpo del template, non una parafrasi del modello.
    const riga = calls.messages.at(-1);
    expect(riga).toMatchObject({ direction: 'out', body: testoScelta('notte'), template_sid: 'HX_SCELTA_NOTTE', is_template: true });
    expect(eventi(calls, 'lancio_scelta_pulsanti')[0].payload).toMatchObject({ conversationId: 42, modo: 'notte', inviato: true });
  });

  it('env mancante: si ripiega sul testo fisso (con la spinta), niente template, evento warn', async () => {
    vi.stubEnv('LANCIO_SCELTA_NOTTE_TEMPLATE_SID', '');
    chiedeLaScelta('notte');
    const { supabase, calls } = makeSupabase();
    expect(await turnoPostPitch(supabase, scelta('il progetto finale'), ctx())).toBe('active');
    expect(sendTemplate).not.toHaveBeenCalled();
    expect(bolle()).toEqual([testoScelta('notte')]);
    const ev = eventi(calls, 'lancio_scelta_pulsanti')[0];
    expect(ev.payload).toMatchObject({ modo: 'notte', inviato: false, motivo: 'env_mancante' });
    expect(ev.level).toBe('warn');
  });

  it('template bloccato da UTILITY_ONLY: il turno NON fallisce, esce il testo fisso', async () => {
    vi.stubEnv('LANCIO_SCELTA_NOTTE_TEMPLATE_SID', 'HX_SCELTA_NOTTE');
    vi.mocked(sendTemplate).mockRejectedValueOnce(new Error('template HX_SCELTA_NOTTE bloccato: categoria MARKETING'));
    chiedeLaScelta('notte');
    const { supabase, calls } = makeSupabase();
    expect(await turnoPostPitch(supabase, scelta('il progetto finale'), ctx())).toBe('active');
    expect(bolle()).toEqual([testoScelta('notte')]);
    expect(eventi(calls, 'lancio_scelta_pulsanti')[0].payload.motivo).toContain('bloccato');
  });

  it('una risposta qualunque del modello resta una bolla di testo: i pulsanti sono solo per la scelta', async () => {
    vi.stubEnv('LANCIO_SCELTA_NOTTE_TEMPLATE_SID', 'HX_SCELTA_NOTTE');
    genera.mockResolvedValueOnce(modello({ visibleReply: 'Bella domanda, te lo spiega il consulente!' }));
    const { supabase, calls } = makeSupabase();
    await turnoPostPitch(supabase, scelta('ma quanto dura?'), ctx());
    expect(sendTemplate).not.toHaveBeenCalled();
    expect(bolle()).toEqual(['Bella domanda, te lo spiega il consulente!']);
    expect(eventi(calls, 'lancio_scelta_pulsanti')).toHaveLength(0);
  });
});

describe('turnoPostPitch — il tocco di un pulsante si classifica prima del modello', () => {
  // PO 02/10: il tocco classifica la scelta senza modello; la prima domanda della
  // chiamata invece la scrive il modello, gia' col percorso giusto (una chiamata sola).
  it('di notte "Chiamami subito" = CHIAMA_ORA: si apre il percorso chiamata, il modello scrive solo la prima domanda', async () => {
    genera.mockResolvedValueOnce(modello({ visibleReply: 'Cosa ti spinge a voler fare un percorso come questo?' }));
    const { supabase, calls } = makeSupabase();
    expect(await turnoPostPitch(supabase, scelta('Chiamami subito'), ctx())).toBe('active');
    expect(genera).toHaveBeenCalledTimes(1);
    expect(genera.mock.calls[0][1]).toMatchObject({ percorso: 'chiamata', domandeFatte: 0 });
    expect(lancioCallNow).not.toHaveBeenCalled();
    expect(eventi(calls, 'lancio_scelta_pulsante_tap')[0].payload).toMatchObject({ titolo: 'Chiamami subito', tag: 'CHIAMA_ORA', modo: 'notte' });
  });

  it.each(['Fissiamo domani', 'Domani mattina', 'Oggi pomeriggio'])(
    'di notte "%s" = SLOTS, senza passare dal modello',
    async (titolo) => {
      const { supabase, calls } = makeSupabase();
      expect(await turnoPostPitch(supabase, scelta(titolo), ctx())).toBe('active');
      expect(genera).not.toHaveBeenCalled();
      expect(bolle()).toEqual([SLOT_TEXT_NOTTE]);
      expect(eventi(calls, 'lancio_scelta_pulsante_tap')[0].payload).toMatchObject({ tag: 'SLOTS', modo: 'notte' });
    },
  );

  it('PO 02/10: senza riscaldamento il testo del pulsante e subito un tocco, senza modello', async () => {
    const { supabase, calls } = makeSupabase();
    await turnoPostPitch(supabase, base({ rows: [LINK, PULSANTE, inb('Domani mattina')], inboundBody: 'Domani mattina' }), ctx());
    expect(genera).not.toHaveBeenCalled();
    expect(eventi(calls, 'lancio_scelta_pulsante_tap')).toHaveLength(1);
  });
});

// Decisione PO del 25/09: i pulsanti di scelta esistono SOLO la sera della live. Dalle 03:00
// del 6 una chat rimasta in `post_pitch` che riscrive passa a Mario standard: fase
// `chiuso`, marcatore `mario_dopo_notte` con le risposte della sera, 'handed_to_mario'.
describe('turnoPostPitch — dopo la notte del webinar passa a Mario standard (PO 25/09)', () => {
  const faseScritta = () => vi.mocked(impostaFaseLancio).mock.calls[0];

  it('alle 02:59 del 6 e ancora notte: il dopo-pitch risponde come prima', async () => {
    genera.mockResolvedValueOnce(modello({ visibleReply: 'Ok' }));
    const { supabase } = makeSupabase();
    expect(await turnoPostPitch(supabase, base(), ctx(new Date('2026-10-06T02:59:00+02:00')))).toBe('active');
    expect(genera.mock.calls[0][1].modo).toBe('notte');
    expect(impostaFaseLancio).not.toHaveBeenCalled();
  });

  it.each([
    ['03:00', '2026-10-06T03:00:00+02:00'],
    ['05:00 (prima era silenzio fino alle 08:30)', '2026-10-06T05:00:00+02:00'],
    ['10:00', '2026-10-06T10:00:00+02:00'],
    ['19:30 del 7', '2026-10-07T19:30:00+02:00'],
  ])('alle %s: chiuso con il marcatore e le risposte, nessuna bolla, nessun modello, nessun CRM', async (_etichetta, iso) => {
    const { supabase, calls } = makeSupabase();
    expect(await turnoPostPitch(supabase, scelta('ci sei?'), ctx(new Date(iso)))).toBe('handed_to_mario');
    const [, conv, fase, campi] = faseScritta() as unknown as [unknown, number, string, { lancio_info: unknown }];
    expect(conv).toBe(42);
    expect(fase).toBe('chiuso');
    expect(campi.lancio_info).toEqual({
      risposte: ['studio informatica', 'il progetto finale'],
      mario_dopo_notte: { da: 'post_pitch', at: new Date(iso).toISOString() },
    });
    expect(genera).not.toHaveBeenCalled();
    expect(sendFreeText).not.toHaveBeenCalled();
    expect(sendTemplate).not.toHaveBeenCalled();
    expect(lancioProssimi).not.toHaveBeenCalled();
    expect(lancioBook).not.toHaveBeenCalled();
    expect(lancioCallNow).not.toHaveBeenCalled();
    expect(eventi(calls, 'lancio_post_pitch_a_mario')).toHaveLength(1);
    // Niente traccia qui: a questo inbound risponde Mario nello stesso drain, e la scrive lui.
    expect(eventi(calls, 'fenice_ai_reply')).toHaveLength(0);
  });

  it.each(['Chiamami subito', 'Fissiamo domani', 'Oggi pomeriggio', 'Domani mattina'])(
    'il tocco "%s" di un pulsante della sera, il 6: nessuna chiamata ne ore, la chat va a Mario',
    async (titolo) => {
      const { supabase } = makeSupabase();
      expect(await turnoPostPitch(supabase, scelta(titolo), ctx(GIORNO6))).toBe('handed_to_mario');
      expect(lancioCallNow).not.toHaveBeenCalled();
      expect(sendFreeText).not.toHaveBeenCalled();
      expect(faseScritta()[2]).toBe('chiuso');
    },
  );

  it('chi si era congedato resta un no anche dopo le 03:00: nessun passaggio a Mario', async () => {
    const { supabase } = makeSupabase();
    const congedato = scelta('ci sei?', { lancioInfo: { risposte: [], congedo_at: '2026-10-05T22:45:00+02:00' } });
    expect(await turnoPostPitch(supabase, congedato, ctx(GIORNO6))).not.toBe('handed_to_mario');
    expect(impostaFaseLancio).not.toHaveBeenCalledWith(expect.anything(), 42, 'chiuso', expect.anything());
    expect(sendFreeText).not.toHaveBeenCalled();
  });

  it('senza lancio_evento_at non scatta (resta il comportamento di prima)', async () => {
    genera.mockResolvedValueOnce(modello({ visibleReply: 'Ok' }));
    const { supabase } = makeSupabase();
    const stato = await turnoPostPitch(supabase, base(), { settings: { ...SETTINGS, eventoAt: null }, now: GIORNO6 });
    expect(stato).not.toBe('handed_to_mario');
  });
});

// Fix della review finale (lancio 5/10): rulings del PO, uno per blocco.
describe('turnoPostPitch — fix review finale', () => {
  const AT10 = '2026-10-06T10:00:00+02:00';
  const AT7_10 = '2026-10-07T10:00:00+02:00';
  const AT8_11 = '2026-10-08T11:00:00+02:00';
  const faseScritta = () => vi.mocked(impostaFaseLancio).mock.calls[0];

  // Ruling 1: il secondo giorno Conferme sta nel prompt (non nel testo) e si prenota.
  it('1a. il blocco del prompt ha anche il giorno Conferme successivo, con la sua etichetta', async () => {
    genera.mockResolvedValueOnce(modello({ visibleReply: 'A che ora?' }));
    const { supabase } = makeSupabase();
    await turnoPostPitch(supabase, scelta('una call'), ctx());
    const blocco: string = genera.mock.calls[0][1].bloccoSlot;
    expect(blocco).toContain('2026-10-06T15:00:00+02:00');
    expect(blocco).toContain('2026-10-07T09:00:00+02:00');
    expect(blocco).toMatch(/2026-10-07T09:00:00\+02:00[^\n]*solo se il lead non può il giorno prima/);
  });

  it('1b. il testo con le ore al lead propone SOLO il primo giorno Conferme', async () => {
    genera.mockResolvedValueOnce(modello({ lancioTag: { tag: 'SLOTS' } }));
    const { supabase } = makeSupabase();
    await turnoPostPitch(supabase, scelta('quali ore?'), ctx());
    expect(lancioProssimi).toHaveBeenCalledWith('2026-10-07');
    expect(bolle()).toEqual([SLOT_TEXT_NOTTE]);
    expect(bolle()[0]).not.toContain('mercoledì');
  });

  it('1c. PRENOTA sul secondo giorno Conferme: valido, book col percorso normale, conferma di Noemi', async () => {
    vi.mocked(lancioProssimi).mockImplementation(crmPerGiorno({
      '2026-10-06': { mattina: oreGiorno('2026-10-06', [9]), conferme: oreGiorno('2026-10-07', [9, 10]), saltati: ['2026-10-06'] },
      '2026-10-08': { mattina: null, conferme: oreGiorno('2026-10-08', [10, 11]), saltati: [] },
    }));
    genera.mockResolvedValueOnce(modello({ lancioTag: { tag: 'PRENOTA', at: AT8_11 } }));
    vi.mocked(lancioBook).mockResolvedValueOnce({ ok: true, kind: 'conferme' });
    const { supabase } = makeSupabase();
    expect(await turnoPostPitch(supabase, inPercorso('mercoledì non posso, giovedì alle 11', { domande: 3 }), ctx())).toBe('closed');
    expect(lancioProssimi).toHaveBeenNthCalledWith(2, '2026-10-08');
    expect(genera.mock.calls[0][1].bloccoSlot).toContain(AT8_11);
    expect(lancioBook).toHaveBeenCalledWith(expect.objectContaining({ at: AT8_11 }));
    expect(bolle()).toEqual(['Fissato per giovedì 8 ottobre alle 11:00. Ti chiamerà Noemi per confermare e mandarti il link della videocall: rispondile!']);
  });

  it('1d. senza un primo giorno Conferme la seconda lettura non parte', async () => {
    vi.mocked(lancioProssimi).mockImplementation(crmPerGiorno({
      '2026-10-06': { mattina: oreGiorno('2026-10-06', [9, 11]), conferme: null, saltati: [] },
    }));
    genera.mockResolvedValueOnce(modello({ visibleReply: 'A che ora?' }));
    const { supabase } = makeSupabase();
    await turnoPostPitch(supabase, scelta('una call'), ctx());
    expect(lancioProssimi).toHaveBeenCalledTimes(1);
  });

  // Ruling 2: alle 03:00 del 6 l'ora gia' scelta non si perde.
  it('2a. 08:40 del 6, percorso mattina con le 10 scelte: si prenota subito, conferma, scelta_fatta, niente Mario', async () => {
    vi.mocked(lancioBook).mockResolvedValueOnce({ ok: true, kind: 'mattina', venditore: { id: 'u7', nome: 'Luca' } });
    const { supabase, calls } = makeSupabase();
    const stato = await turnoPostPitch(supabase, inPercorso('lavoro in un negozio', { percorso: 'mattina', oraScelta: AT10, domande: 1 }), ctx(new Date('2026-10-06T08:40:00+02:00')));
    expect(stato).toBe('closed');
    expect(genera).not.toHaveBeenCalled();
    expect(lancioBook).toHaveBeenCalledWith({ leadId: 'crm-L1', at: AT10, info: { risposte: ['studio informatica', 'il progetto finale', 'lavoro in un negozio'] }, note: NOTA_SCELTA });
    expect(bolle()).toEqual(['Perfetto, ci vediamo in videocall martedì 6 ottobre alle 10:00 con Luca: il link per collegarti ti arriva per email.']);
    expect(faseScritta()[2]).toBe('scelta_fatta');
    expect(eventi(calls, 'lancio_post_pitch_a_mario')).toHaveLength(0);
    expect(eventi(calls, 'lancio_scelta')[0].payload).toMatchObject({ tipo: 'prenota', at: AT10, kind: 'mattina' });
  });

  it('2a-bis. stessa chat alle 08:10: fuori fascia, silenzio temporaneo (il re-drive la riprende), niente book, niente Mario', async () => {
    const { supabase, calls } = makeSupabase();
    const stato = await turnoPostPitch(supabase, inPercorso('lavoro in un negozio', { percorso: 'mattina', oraScelta: AT10, domande: 1 }), ctx(new Date('2026-10-06T08:10:00+02:00')));
    expect(stato).toBe('active');
    expect(lancioBook).not.toHaveBeenCalled();
    expect(impostaFaseLancio).not.toHaveBeenCalled();
    expect(sendFreeText).not.toHaveBeenCalled();
    expect(eventi(calls, 'lancio_silenzio')[0].payload).toMatchObject({ motivo: 'fuori_orario', definitivo: false });
    expect(eventi(calls, 'fenice_ai_reply')).toHaveLength(0);
  });

  it('2a-ter. percorso conferme con il 7 alle 10 scelto, il 6 alle 10: si prenota', async () => {
    vi.mocked(lancioBook).mockResolvedValueOnce({ ok: true, kind: 'conferme' });
    const { supabase } = makeSupabase();
    expect(await turnoPostPitch(supabase, inPercorso('ok', { percorso: 'conferme', oraScelta: AT7_10, domande: 2 }), ctx(GIORNO6))).toBe('closed');
    expect(lancioBook).toHaveBeenCalledWith(expect.objectContaining({ at: AT7_10 }));
  });

  it('2b. ora scelta gia passata o troppo vicina: Mario come prima, nessun book', async () => {
    const { supabase, calls } = makeSupabase();
    const stato = await turnoPostPitch(supabase, inPercorso('ci sei?', { percorso: 'mattina', oraScelta: '2026-10-06T09:00:00+02:00', domande: 1 }), ctx(new Date('2026-10-06T08:40:00+02:00')));
    expect(stato).toBe('handed_to_mario');
    expect(lancioBook).not.toHaveBeenCalled();
    expect(faseScritta()[2]).toBe('chiuso');
    expect(eventi(calls, 'lancio_post_pitch_a_mario')).toHaveLength(1);
  });

  it.each([
    ['ora_esaurita', { ok: false, motivo: 'ora_esaurita', slots: null, prossimi: null }],
    ['rete', { ok: false, motivo: 'rete', detail: 'ECONNRESET' }],
    ['fuori_regole', { ok: false, motivo: 'fuori_regole' }],
  ])('2b-bis. book fallito (%s): Mario come prima, nessuna bolla del bot', async (_m, esito) => {
    vi.mocked(lancioBook).mockResolvedValueOnce(esito as any);
    const { supabase, calls } = makeSupabase();
    const stato = await turnoPostPitch(supabase, inPercorso('ok', { percorso: 'mattina', oraScelta: AT10, domande: 1 }), ctx(new Date('2026-10-06T08:40:00+02:00')));
    expect(stato).toBe('handed_to_mario');
    expect(sendFreeText).not.toHaveBeenCalled();
    expect(lancioProssimi).not.toHaveBeenCalled();
    expect(faseScritta()[2]).toBe('chiuso');
    expect(eventi(calls, 'lancio_post_pitch_a_mario')).toHaveLength(1);
  });

  it('2c. percorso chiamata dopo le 03:00: Mario come prima', async () => {
    const { supabase } = makeSupabase();
    expect(await turnoPostPitch(supabase, inPercorso('ci sei?', { percorso: 'chiamata', domande: 1 }), ctx(GIORNO6))).toBe('handed_to_mario');
    expect(lancioBook).not.toHaveBeenCalled();
    expect(lancioCallNow).not.toHaveBeenCalled();
  });

  // Ruling 3: domanda rigenerata vuota.
  it('3. entrando in un percorso la domanda torna vuota: niente introduzione da sola, silenzio tracciato, stato del percorso invariato', async () => {
    genera.mockResolvedValueOnce(modello({ visibleReply: 'Perfetto', lancioTag: { tag: 'PRENOTA', at: AT10 } }));
    genera.mockResolvedValueOnce(modello({ visibleReply: '   ' }));
    const { supabase, calls } = makeSupabase();
    expect(await turnoPostPitch(supabase, scelta('domattina alle 10'), ctx())).toBe('active');
    expect(sendFreeText).not.toHaveBeenCalled();
    expect(eventi(calls, 'lancio_silenzio')[0].payload).toMatchObject({ motivo: 'risposta_vuota', definitivo: true });
    expect(eventi(calls, 'lancio_percorso')).toHaveLength(0);
    const salvata = infoSalvata(calls);
    expect(salvata.percorso ?? null).toBeNull();
    expect(salvata.oraScelta ?? null).toBeNull();
    expect(salvata.domande ?? 0).toBe(0);
  });

  // Ruling 4: sulle Conferme l'introduzione spinge meno.
  it('4. PRENOTA su un ora delle Conferme senza percorso: introduzione leggera', async () => {
    genera.mockResolvedValueOnce(modello({ lancioTag: { tag: 'PRENOTA', at: AT7_10 } }));
    genera.mockResolvedValueOnce(modello({ visibleReply: 'Cosa vorresti cambiare?' }));
    const { supabase } = makeSupabase();
    expect(await turnoPostPitch(supabase, scelta('mercoledì alle 10'), ctx())).toBe('active');
    expect(bolle()).toEqual([`${TESTO_INTRO_CONFERME} Cosa vorresti cambiare?`]);
    expect(bolle()[0]).not.toContain(TESTO_INTRO_PREQUALIFICA);
  });

  // Ruling 5: sulla chiamata le ore non si leggono (latenza la sera del lancio).
  it('5a. percorso chiamata: nessuna lettura delle ore, prompt senza blocco', async () => {
    genera.mockResolvedValueOnce(modello({ visibleReply: 'E cosa ti ha colpito della live?' }));
    const { supabase } = makeSupabase();
    expect(await turnoPostPitch(supabase, inPercorso('perché mi piace', { percorso: 'chiamata', domande: 0 }), ctx())).toBe('active');
    expect(lancioProssimi).not.toHaveBeenCalled();
    expect(genera.mock.calls[0][1].bloccoSlot).toBeNull();
  });

  it('5b. PRENOTA dalla chiamata: le ore si leggono allora, e la prima domanda della mattina ha il blocco', async () => {
    genera.mockResolvedValueOnce(modello({ lancioTag: { tag: 'PRENOTA', at: AT10 } }));
    genera.mockResolvedValueOnce(modello({ visibleReply: 'Cosa non va oggi nel tuo lavoro?' }));
    const { supabase, calls } = makeSupabase();
    expect(await turnoPostPitch(supabase, inPercorso('anzi, domattina alle 10', { percorso: 'chiamata', domande: 1 }), ctx())).toBe('active');
    expect(genera.mock.calls[0][1].bloccoSlot).toBeNull();
    expect(lancioProssimi).toHaveBeenCalledWith('2026-10-06');
    expect(genera.mock.calls[1][1].bloccoSlot).toContain('2026-10-06T09:00:00+02:00');
    expect(infoSalvata(calls)).toMatchObject({ percorso: 'mattina', oraScelta: AT10, domande: 0 });
    expect(bolle()).toEqual([`${TESTO_INTRO_PREQUALIFICA} Cosa non va oggi nel tuo lavoro?`]);
  });
});
