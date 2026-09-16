import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./twilio', () => ({ sendFreeText: vi.fn(async () => ({ sid: 'SM_P', status: 'queued' })) }));
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
vi.mock('./lancio-crm', () => ({ lancioSlots: vi.fn(), lancioBook: vi.fn(), lancioCallNow: vi.fn() }));
vi.mock('./lead-entrante', () => ({ pushLeadEntrante: vi.fn(async () => ({ ok: true, leadId: 'crm-NEW' })) }));

import { turnoPostPitch, turnoDopoScelta, NOTA_SCELTA, PROVENIENZA_LANCIO } from './lancio-post-pitch';
import { sendFreeText } from './twilio';
import { sendOutcome, sendCrmNota } from './bot-outcome';
import { impostaFaseLancio, marcaCongedo } from './lancio-db';
import { lancioSlots, lancioBook, lancioCallNow, type LancioSlots } from './lancio-crm';
import { pushLeadEntrante } from './lead-entrante';
import {
  TESTO_NESSUN_VENDITORE, TESTO_CHIAMATA_FUORI_ORARIO, TESTO_ERRORE_CRM, TESTO_DOPO_SCELTA, TESTO_CONGEDO_POST_PITCH,
} from './lancio-scelta';
import { TESTO_CONGEDO } from './lancio-fase';
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
};
const NOTTE = new Date('2026-10-05T22:40:00+02:00');
const GIORNO6 = new Date('2026-10-06T10:00:00+02:00');
const SLOTS: LancioSlots = { date: '2026-10-06', mattina: [{ hour: 9, liberi: 1 }, { hour: 11, liberi: 2 }, { hour: 14, liberi: 1 }], pomeriggio: { aperto: true, ore: [15, 16, 17, 18, 19, 20] }, mattinaEsaurita: false };
const SLOT_TEXT_NOTTE = 'Per la call ho libero domattina alle 9, alle 11 o alle 14, oppure domani pomeriggio dalle 15 alle 20: che ora preferisci?';

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
const bolle = () => vi.mocked(sendFreeText).mock.calls.map((c) => c[0].body);
const eventi = (calls: { events: any[] }, type: string) => calls.events.filter((e) => e.type === type);
const infoSalvata = (calls: { convUpdates: any[] }) => calls.convUpdates.find((u) => 'lancio_info' in u)?.lancio_info;
const ctx = (now: Date = NOTTE) => ({ settings: SETTINGS, now });

beforeEach(() => {
  vi.clearAllMocks();
  genera.mockReset();
  vi.mocked(lancioSlots).mockResolvedValue({ ok: true, slots: SLOTS });
  vi.mocked(lancioBook).mockReset();
  vi.mocked(lancioCallNow).mockReset();
  vi.mocked(pushLeadEntrante).mockResolvedValue({ ok: true, leadId: 'crm-NEW' });
  vi.mocked(sendOutcome).mockResolvedValue({ sent: true });
  vi.mocked(sendCrmNota).mockResolvedValue({ sent: true });
});

describe('turnoPostPitch — riscaldamento', () => {
  it('primo turno (il pulsante): niente slot, modello con 0 risposte in modo notte, UNA bolla, lancio_info senza il marker', async () => {
    genera.mockResolvedValueOnce(modello({ visibleReply: 'Ciao Anna! Cosa fai oggi nella vita?' }));
    const { supabase, calls } = makeSupabase();
    const stato = await turnoPostPitch(supabase, base(), ctx());
    expect(stato).toBe('active');
    expect(lancioSlots).not.toHaveBeenCalled();
    expect(genera.mock.calls[0][1]).toMatchObject({ fase: 'post_pitch', nome: 'Anna', modo: 'notte', risposteRaccolte: 0, bloccoSlot: null, now: NOTTE });
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
    expect(lancioSlots).toHaveBeenCalledWith('2026-10-06');
    expect(lancioSlots).toHaveBeenCalledTimes(1);
    const opts = genera.mock.calls[0][1];
    expect(opts.risposteRaccolte).toBe(2);
    expect(opts.bloccoSlot).toContain('2026-10-06T09:00:00+02:00');
    expect(opts.bloccoSlot).toContain('2026-10-07T14:00:00+02:00');
    expect(infoSalvata(calls)).toEqual({ risposte: ['studio informatica', 'il progetto finale'] });
  });

  it('[PASSAGGIO_UMANO] → handed_off, con le risposte salvate', async () => {
    genera.mockResolvedValueOnce(modello({ passToHuman: true, visibleReply: 'Certo, ti faccio contattare.' }));
    const { supabase, calls } = makeSupabase();
    expect(await turnoPostPitch(supabase, base({ inboundBody: 'voglio parlare con una persona', rows: [LINK, PULSANTE, inb('voglio parlare con una persona')] }), ctx())).toBe('handed_off');
    expect(vi.mocked(sendOutcome).mock.calls[0][2]).toMatchObject({ outcome: 'CONTATTO_UMANO' });
    expect(infoSalvata(calls)).toEqual({ risposte: ['voglio parlare con una persona'] });
  });
});

describe('turnoPostPitch — [LANCIO:CHIAMA_ORA]', () => {
  it('di notte: call-now con leadId, info e nota; conferma fissa col nome; scelta_fatta con lancio_info; closed', async () => {
    genera.mockResolvedValueOnce(modello({ visibleReply: 'Perfetto!', lancioTag: { tag: 'CHIAMA_ORA' } }));
    vi.mocked(lancioCallNow).mockResolvedValueOnce({ ok: true, venditore: { id: 'u7', nome: 'Luca' } });
    const { supabase, calls } = makeSupabase();
    const stato = await turnoPostPitch(supabase, scelta('adesso'), ctx());
    expect(stato).toBe('closed');
    expect(lancioCallNow).toHaveBeenCalledWith({ leadId: 'crm-L1', info: { risposte: ['studio informatica', 'il progetto finale', 'adesso'] }, note: NOTA_SCELTA });
    expect(bolle()).toEqual(['Perfetto, ti chiama Luca tra pochissimo.']);
    expect(impostaFaseLancio).toHaveBeenCalledWith(expect.anything(), 42, 'scelta_fatta', { lancio_info: { risposte: ['studio informatica', 'il progetto finale', 'adesso'] } });
    expect(eventi(calls, 'lancio_scelta')[0].payload).toMatchObject({ tipo: 'chiama_ora', venditore: { id: 'u7', nome: 'Luca' } });
    expect(eventi(calls, 'fenice_ai_reply')).toHaveLength(1);
  });

  it('di giorno (dopo le 03:00) non si chiama: testo fisso + le ore, slot segnati come mostrati, active', async () => {
    genera.mockResolvedValueOnce(modello({ lancioTag: { tag: 'CHIAMA_ORA' } }));
    const { supabase, calls } = makeSupabase();
    const stato = await turnoPostPitch(supabase, scelta('chiamami adesso'), ctx(GIORNO6));
    expect(stato).toBe('active');
    expect(lancioCallNow).not.toHaveBeenCalled();
    expect(bolle()[0]).toMatch(new RegExp(`^${TESTO_CHIAMATA_FUORI_ORARIO} Per la call ho oggi pomeriggio dalle 15 alle 20`));
    expect(bolle()[0]).not.toMatch(/alle 11/);
    expect(infoSalvata(calls).slotsMostratiAt).toBe(GIORNO6.toISOString());
    expect(eventi(calls, 'lancio_slots_mostrati')).toHaveLength(1);
  });

  it('409 nessun_venditore: "tutti occupati, fissiamo domani?" + le ore, active', async () => {
    genera.mockResolvedValueOnce(modello({ lancioTag: { tag: 'CHIAMA_ORA' } }));
    vi.mocked(lancioCallNow).mockResolvedValueOnce({ ok: false, motivo: 'nessun_venditore' });
    const { supabase } = makeSupabase();
    expect(await turnoPostPitch(supabase, scelta('adesso'), ctx())).toBe('active');
    expect(bolle()).toEqual([`${TESTO_NESSUN_VENDITORE} ${SLOT_TEXT_NOTTE}`]);
    expect(impostaFaseLancio).not.toHaveBeenCalled();
  });

  it('409 gia_prenotato: gli si ricorda l ora che ha gia, niente seconda chiamata, scelta_fatta, closed', async () => {
    genera.mockResolvedValueOnce(modello({ lancioTag: { tag: 'CHIAMA_ORA' } }));
    vi.mocked(lancioCallNow).mockResolvedValueOnce({ ok: false, motivo: 'gia_prenotato', appointmentAt: '2026-10-06T11:00:00+02:00', kind: 'mattina' });
    const { supabase, calls } = makeSupabase();
    expect(await turnoPostPitch(supabase, scelta('adesso'), ctx())).toBe('closed');
    expect(lancioCallNow).toHaveBeenCalledTimes(1);
    expect(bolle()).toEqual(['Risulta che hai già un appuntamento con noi martedì 6 ottobre alle 11:00: ti chiamiamo lì, non serve fissarne un altro.']);
    expect(impostaFaseLancio).toHaveBeenCalledWith(expect.anything(), 42, 'scelta_fatta', { lancio_info: { risposte: ['studio informatica', 'il progetto finale', 'adesso'] } });
    expect(eventi(calls, 'lancio_scelta')[0].payload).toMatchObject({ tipo: 'gia_prenotato', at: '2026-10-06T11:00:00+02:00', kind: 'mattina' });
    expect(eventi(calls, 'lancio_crm_errore')).toHaveLength(0);
  });

  it('409 gia_prenotato senza appointmentAt: testo generico, stessa strada', async () => {
    genera.mockResolvedValueOnce(modello({ lancioTag: { tag: 'CHIAMA_ORA' } }));
    vi.mocked(lancioCallNow).mockResolvedValueOnce({ ok: false, motivo: 'gia_prenotato', appointmentAt: null, kind: null });
    const { supabase } = makeSupabase();
    expect(await turnoPostPitch(supabase, scelta('adesso'), ctx())).toBe('closed');
    expect(bolle()).toEqual(['Risulta che hai già un appuntamento fissato con noi: ti richiamiamo noi, non serve fissarne un altro.']);
  });

  it('CRM in errore (rete/http): testo di errore, evento error, active, niente fase', async () => {
    genera.mockResolvedValueOnce(modello({ lancioTag: { tag: 'CHIAMA_ORA' } }));
    vi.mocked(lancioCallNow).mockResolvedValueOnce({ ok: false, motivo: 'rete', detail: 'ECONNRESET' });
    const { supabase, calls } = makeSupabase();
    expect(await turnoPostPitch(supabase, scelta('adesso'), ctx())).toBe('active');
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
      expect(await turnoPostPitch(supabase, scelta('adesso'), ctx())).toBe('active');
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
    expect(await turnoPostPitch(supabase, scelta('adesso'), ctx())).toBe('active');
    expect(lancioCallNow).toHaveBeenCalledTimes(1);
    expect(bolle()).toEqual([TESTO_ERRORE_CRM]);
    expect(eventi(calls, 'lancio_crm_errore')[0].payload).toMatchObject({ motivo: 'conflitto' });
  });
});

describe('turnoPostPitch — [LANCIO:PRENOTA|iso]', () => {
  const AT9 = '2026-10-06T09:00:00+02:00';
  const prenota = (at: string) => modello({ lancioTag: { tag: 'PRENOTA', at } });

  it('ora valida: book con leadId, at, info e nota; conferma fissa con giorno, ora e venditore; scelta_fatta; closed', async () => {
    genera.mockResolvedValueOnce(prenota(AT9));
    vi.mocked(lancioBook).mockResolvedValueOnce({ ok: true, kind: 'mattina', venditore: { id: 'u7', nome: 'Luca' } });
    const { supabase, calls } = makeSupabase();
    expect(await turnoPostPitch(supabase, scelta('domattina alle 9'), ctx())).toBe('closed');
    expect(lancioBook).toHaveBeenCalledWith({ leadId: 'crm-L1', at: AT9, info: { risposte: ['studio informatica', 'il progetto finale', 'domattina alle 9'] }, note: NOTA_SCELTA });
    expect(bolle()).toEqual(['Perfetto, ci sentiamo martedì 6 ottobre alle 9:00: ti chiama Luca. Tieni il telefono a portata di mano.']);
    expect(impostaFaseLancio).toHaveBeenCalledWith(expect.anything(), 42, 'scelta_fatta', expect.objectContaining({ lancio_info: expect.anything() }));
    expect(eventi(calls, 'lancio_scelta')[0].payload).toMatchObject({ tipo: 'prenota', at: AT9, kind: 'mattina' });
  });

  it('pomeriggio senza venditore: "un nostro consulente"', async () => {
    genera.mockResolvedValueOnce(prenota('2026-10-06T17:00:00+02:00'));
    vi.mocked(lancioBook).mockResolvedValueOnce({ ok: true, kind: 'pomeriggio' });
    const { supabase } = makeSupabase();
    await turnoPostPitch(supabase, scelta('alle 17'), ctx());
    expect(bolle()).toEqual(['Perfetto, ci sentiamo martedì 6 ottobre alle 17:00: ti chiama un nostro consulente. Tieni il telefono a portata di mano.']);
  });

  it('409 ora_esaurita: ripropone dagli slot AGGIORNATI del CRM, non da quelli letti prima', async () => {
    genera.mockResolvedValueOnce(prenota(AT9));
    vi.mocked(lancioBook).mockResolvedValueOnce({ ok: false, motivo: 'ora_esaurita', slots: { date: '2026-10-06', mattina: [{ hour: 11, liberi: 1 }], pomeriggio: { aperto: true, ore: [15, 16, 17, 18, 19, 20] }, mattinaEsaurita: false } });
    const { supabase, calls } = makeSupabase();
    expect(await turnoPostPitch(supabase, scelta('alle 9'), ctx())).toBe('active');
    expect(bolle()).toEqual(['Le 9 si sono appena riempite. Per la call ho libero domattina alle 11, oppure domani pomeriggio dalle 15 alle 20: che ora preferisci?']);
    expect(lancioSlots).toHaveBeenCalledTimes(1);
    expect(infoSalvata(calls).slotsMostratiAt).toBe(NOTTE.toISOString());
    expect(impostaFaseLancio).not.toHaveBeenCalled();
  });

  it('409 nessun_venditore su book: propone domani con le ore', async () => {
    genera.mockResolvedValueOnce(prenota(AT9));
    vi.mocked(lancioBook).mockResolvedValueOnce({ ok: false, motivo: 'nessun_venditore' });
    const { supabase } = makeSupabase();
    await turnoPostPitch(supabase, scelta('alle 9'), ctx());
    expect(bolle()).toEqual([`${TESTO_NESSUN_VENDITORE} ${SLOT_TEXT_NOTTE}`]);
  });

  it('409 gia_prenotato su book: l ora che ha gia, nessun secondo book, scelta_fatta, closed', async () => {
    genera.mockResolvedValueOnce(prenota(AT9));
    vi.mocked(lancioBook).mockResolvedValueOnce({ ok: false, motivo: 'gia_prenotato', appointmentAt: '2026-10-07T10:00:00+02:00', kind: 'dopodomani' });
    const { supabase, calls } = makeSupabase();
    expect(await turnoPostPitch(supabase, scelta('alle 9'), ctx())).toBe('closed');
    expect(lancioBook).toHaveBeenCalledTimes(1);
    expect(bolle()).toEqual(['Risulta che hai già un appuntamento con noi mercoledì 7 ottobre alle 10:00: ti chiamiamo lì, non serve fissarne un altro.']);
    expect(impostaFaseLancio).toHaveBeenCalledWith(expect.anything(), 42, 'scelta_fatta', expect.objectContaining({ lancio_info: expect.anything() }));
    expect(eventi(calls, 'lancio_scelta')[0].payload).toMatchObject({ tipo: 'gia_prenotato', at: '2026-10-07T10:00:00+02:00', kind: 'dopodomani' });
  });

  it('422 fuori_regole: chiede un altra ora con le ore', async () => {
    genera.mockResolvedValueOnce(prenota(AT9));
    vi.mocked(lancioBook).mockResolvedValueOnce({ ok: false, motivo: 'fuori_regole' });
    const { supabase, calls } = makeSupabase();
    await turnoPostPitch(supabase, scelta('alle 9'), ctx());
    expect(bolle()).toEqual([`Quell'ora non riesco a fissarla. ${SLOT_TEXT_NOTTE}`]);
    expect(eventi(calls, 'lancio_at_non_valido')[0].payload).toMatchObject({ motivo: 'crm_fuori_regole' });
  });

  it('at fuori dalle regole dure (ora non tonda, giorno sbagliato, troppo vicino): niente book, si chiede un altra ora', async () => {
    const { supabase, calls } = makeSupabase();
    for (const at of ['2026-10-06T09:30:00+02:00', '2026-10-08T10:00:00+02:00', '2026-10-05T23:00:00+02:00']) {
      genera.mockResolvedValueOnce(prenota(at));
      await turnoPostPitch(supabase, scelta('boh'), ctx());
    }
    expect(lancioBook).not.toHaveBeenCalled();
    expect(bolle()).toHaveLength(3);
    for (const b of bolle()) expect(b).toMatch(/^Quell'ora non riesco a fissarla\. Per la call ho libero domattina/);
    expect(eventi(calls, 'lancio_at_non_valido').map((e) => e.payload.motivo)).toEqual(['ora_non_tonda', 'giorno_non_ammesso', 'giorno_non_ammesso']);
  });

  it('di giorno alle 10:00 le 9 sono andate (troppo vicino) e il testo non nomina la mattina', async () => {
    genera.mockResolvedValueOnce(prenota(AT9));
    const { supabase, calls } = makeSupabase();
    await turnoPostPitch(supabase, scelta('alle 9'), ctx(GIORNO6));
    expect(lancioBook).not.toHaveBeenCalled();
    expect(eventi(calls, 'lancio_at_non_valido')[0].payload.motivo).toBe('troppo_vicino');
    expect(bolle()[0]).toContain('oggi pomeriggio dalle 15 alle 20');
    expect(bolle()[0]).not.toMatch(/alle 11/);
  });

  it('500 dal CRM: testo di errore, active', async () => {
    genera.mockResolvedValueOnce(prenota(AT9));
    vi.mocked(lancioBook).mockResolvedValueOnce({ ok: false, motivo: 'http', status: 500, detail: 'boom' });
    const { supabase } = makeSupabase();
    expect(await turnoPostPitch(supabase, scelta('alle 9'), ctx())).toBe('active');
    expect(bolle()).toEqual([TESTO_ERRORE_CRM]);
  });
});

describe('turnoPostPitch — [LANCIO:SLOTS], [LANCIO:NO], finestra', () => {
  it('SLOTS: le ore scritte dal codice, slotsMostratiAt salvato, evento', async () => {
    genera.mockResolvedValueOnce(modello({ visibleReply: 'Vediamo le ore', lancioTag: { tag: 'SLOTS' } }));
    const { supabase, calls } = makeSupabase();
    expect(await turnoPostPitch(supabase, scelta('domani'), ctx())).toBe('active');
    expect(bolle()).toEqual([SLOT_TEXT_NOTTE]);
    expect(infoSalvata(calls)).toEqual({ risposte: ['studio informatica', 'il progetto finale', 'domani'], slotsMostratiAt: NOTTE.toISOString() });
    expect(eventi(calls, 'lancio_slots_mostrati')[0].payload).toMatchObject({ mattina: [9, 11, 14], pomeriggio: [15, 16, 17, 18, 19, 20] });
  });

  it('SLOTS con il CRM giù: pomeriggio e dopodomani restano, mattina no, evento warn', async () => {
    vi.mocked(lancioSlots).mockResolvedValue({ ok: false, motivo: 'rete', detail: 'timeout' });
    genera.mockResolvedValueOnce(modello({ lancioTag: { tag: 'SLOTS' } }));
    const { supabase, calls } = makeSupabase();
    await turnoPostPitch(supabase, scelta('domani'), ctx());
    expect(bolle()[0]).toContain('Domattina è tutto pieno');
    expect(bolle()[0]).toContain('domani pomeriggio dalle 15 alle 20');
    expect(eventi(calls, 'lancio_slots_non_letti')[0].level).toBe('warn');
  });

  it('SLOTS alle 19:30 del 6 senza ore per oggi: propone solo il 7; nessuna ora in assoluto ⇒ nota al CRM', async () => {
    genera.mockResolvedValue(modello({ lancioTag: { tag: 'SLOTS' } }));
    const { supabase, calls } = makeSupabase();
    await turnoPostPitch(supabase, scelta('domani'), ctx(new Date('2026-10-06T19:30:00+02:00')));
    expect(bolle()[0]).toContain('Per oggi non ho più ore libere. Ho domani mattina dalle 9 alle 14');
    expect(sendCrmNota).not.toHaveBeenCalled();
    await turnoPostPitch(supabase, scelta('domani'), ctx(new Date('2026-10-07T13:30:00+02:00')));
    expect(bolle()[1]).toMatch(/^Per questi due giorni non ho più ore libere/);
    expect(sendCrmNota).toHaveBeenCalledTimes(1);
    expect(eventi(calls, 'lancio_slots_vuoti')).toHaveLength(1);
    // Nessuna ora proposta non e' "ore mostrate": l'evento resta quello del primo turno.
    expect(eventi(calls, 'lancio_slots_mostrati')).toHaveLength(1);
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

  it('lotto: due messaggi di riscaldamento in fila contano due risposte e vanno al CRM interi', async () => {
    genera.mockResolvedValueOnce(modello({ lancioTag: { tag: 'CHIAMA_ORA' } }));
    vi.mocked(lancioCallNow).mockResolvedValueOnce({ ok: true, venditore: { id: 'u7', nome: 'Luca' } });
    const { supabase } = makeSupabase();
    const conLotto = base({
      rows: [LINK, PULSANTE, out('Cosa fai oggi?'), inb('studio informatica'), inb('e mi chiami adesso?')],
      inboundBody: 'studio informatica', lancioInfo: { risposte: [] },
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

  it('fra le 03:00 e le 08:30 del 6: silenzio TEMPORANEO senza fenice_ai_reply (il re-drive delle 08:30 risponde)', async () => {
    const { supabase, calls } = makeSupabase();
    expect(await turnoPostPitch(supabase, scelta('ci sei?'), ctx(new Date('2026-10-06T05:00:00+02:00')))).toBe('active');
    expect(genera).not.toHaveBeenCalled();
    expect(sendFreeText).not.toHaveBeenCalled();
    expect(eventi(calls, 'lancio_silenzio')[0].payload).toMatchObject({ motivo: 'fuori_orario', definitivo: false });
    expect(eventi(calls, 'fenice_ai_reply')).toHaveLength(0);
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
    expect(lancioSlots).not.toHaveBeenCalled();
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

  it('alle 02:59 del 6 si risponde ancora (notte); alle 09:00 anche (giorno)', async () => {
    genera.mockResolvedValue(modello({ visibleReply: 'Ok' }));
    const { supabase } = makeSupabase();
    await turnoPostPitch(supabase, base(), ctx(new Date('2026-10-06T02:59:00+02:00')));
    expect(genera.mock.calls[0][1].modo).toBe('notte');
    await turnoPostPitch(supabase, base(), ctx(new Date('2026-10-06T09:00:00+02:00')));
    expect(genera.mock.calls[1][1].modo).toBe('giorno');
    expect(sendFreeText).toHaveBeenCalledTimes(2);
  });

  // Il pulsante premuto alle 20:40 del 5, prima che la live cominci. Fuori dalla notte
  // del webinar: niente chiamata immediata e niente proposta spontanea della mattina del
  // 6 (la regola di `modoPostPitch`, invariata). Le PAROLE pero' sono quelle di chi
  // scrive il 5: il 7 e' "mercoledi 7 ottobre", non "domani mattina". Prima la bolla
  // diceva "oggi pomeriggio" parlando del pomeriggio del 6 e "domani mattina" del 7.
  it('alle 20:40 del 5 i giorni si chiamano col nome del 5, e la mattina non si propone', async () => {
    genera.mockResolvedValueOnce(modello({ lancioTag: { tag: 'SLOTS' } }));
    const { supabase } = makeSupabase();
    await turnoPostPitch(supabase, scelta('una call'), ctx(new Date('2026-10-05T20:40:00+02:00')));
    expect(genera.mock.calls[0][1].modo).toBe('giorno');
    expect(bolle()[0]).toBe('Per la call ho domani pomeriggio dalle 15 alle 20: che ora preferisci? Se puoi solo la mattina, ho mercoledì 7 ottobre dalle 9 alle 14.');
  });

  // Alle 02:00 del 6 le due decisioni divergono: la chiamata immediata c'e' ancora
  // (`modo` notte) e con lei la proposta della mattina, ma i giorni si chiamano come li
  // chiama chi scrive il 6 — "stamattina", non "domattina".
  it('alle 02:00 del 6 la mattina si propone ancora, con le parole di oggi', async () => {
    genera.mockResolvedValueOnce(modello({ lancioTag: { tag: 'SLOTS' } }));
    const { supabase } = makeSupabase();
    await turnoPostPitch(supabase, scelta('una call'), ctx(new Date('2026-10-06T02:00:00+02:00')));
    expect(genera.mock.calls[0][1].modo).toBe('notte');
    expect(bolle()[0]).toBe('Per la call ho libero stamattina alle 9, alle 11 o alle 14, oppure oggi pomeriggio dalle 15 alle 20: che ora preferisci?');
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
    expect(await turnoPostPitch(supabase, scelta('adesso', { crmLeadId: null }), ctx())).toBe('closed');
    expect(pushLeadEntrante).toHaveBeenCalledWith(expect.anything(), {
      conversationId: 42, telefono: '+393331234567', nome: 'Anna', provenienza: PROVENIENZA_LANCIO,
      primoMessaggio: MARKER, scrittoIl: '2026-10-05T22:38:00+02:00',
    });
    expect(PROVENIENZA_LANCIO).toBe('Lancio Web Dev AI');
    expect(lancioCallNow).toHaveBeenCalledWith(expect.objectContaining({ leadId: 'crm-NEW' }));
    expect(bolle()).toEqual(['Perfetto, ti chiama Sara tra pochissimo.']);
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
      inboundBody: 'adesso', lancioInfo: { risposte: ['studio informatica', 'il progetto finale'] },
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
    await turnoPostPitch(supabase, scelta('adesso', { crmLeadId: null }), ctx());
    expect(pushLeadEntrante).not.toHaveBeenCalled();
    expect(lancioCallNow).toHaveBeenCalledWith(expect.objectContaining({ leadId: 'crm-DB' }));
  });

  it('push fallito: testo di errore, evento lancio_lead_senza_crm, nessuna scelta', async () => {
    genera.mockResolvedValueOnce(modello({ lancioTag: { tag: 'PRENOTA', at: '2026-10-06T09:00:00+02:00' } }));
    vi.mocked(pushLeadEntrante).mockResolvedValueOnce({ ok: false, motivo: 'http_500' });
    const { supabase, calls } = makeSupabase(null);
    expect(await turnoPostPitch(supabase, scelta('alle 9', { crmLeadId: null }), ctx())).toBe('active');
    expect(lancioBook).not.toHaveBeenCalled();
    expect(bolle()).toEqual([TESTO_ERRORE_CRM]);
    expect(eventi(calls, 'lancio_lead_senza_crm')[0].level).toBe('error');
  });
});

describe('turnoDopoScelta — fase scelta_fatta', () => {
  it('primo messaggio dopo la scelta: "Ricevuto" una volta, le parole al CRM come nota, closed', async () => {
    const { supabase, calls } = makeSupabase();
    const stato = await turnoDopoScelta(supabase, base({ fase: 'scelta_fatta', rows: [LINK, PULSANTE, out('Perfetto, ti chiama Luca tra pochissimo.'), inb('grazie, aspetto')], inboundBody: 'grazie, aspetto' }), ctx());
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
