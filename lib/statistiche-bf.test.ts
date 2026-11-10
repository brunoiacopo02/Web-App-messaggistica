import { describe, expect, it } from 'vitest';
import { convPrincipale, schedaDellaPersona, leggiRichiesta, riepilogoPerFunnel, statoLead, type ConvRiga, type MsgRiga } from './statistiche-bf';

const conv = (p: Partial<ConvRiga> = {}): ConvRiga => ({
  id: 1, crm_lead_id: 'L1', lead_id: 10, created_at: '2026-11-08T10:00:00Z', last_message_at: '2026-11-08T11:00:00Z',
  wa_number: 'whatsapp:+393520158061', mario_braccio: 'sonnet', bot_outcome: null, bot_outcome_at: null, ai_status: 'active',
  scheda_inviata_at: null, professione: null, ...p,
});
const msg = (direction: string, created_at: string, twilio_status: string | null = 'delivered', conversation_id = 1): MsgRiga =>
  ({ conversation_id, direction, twilio_status, created_at });
const ADESSO = new Date('2026-11-09T10:00:00Z');
const LEAD = { id: 'L1', ingresso: '2026-11-08T10:00:00Z' };

describe('statoLead', () => {
  it('senza chat: tutto falso, eta dall ingresso', () => {
    const s = statoLead(LEAD, null, null, [], ADESSO);
    expect(s).toMatchObject({ conversation_id: null, con_chat: false, consegnato: false, risposto: false, chat_nuova: null, eta_ore: 24 });
  });

  it('chat nuova, apertura consegnata e risposta dopo l ingresso', () => {
    const s = statoLead(LEAD, conv({ created_at: '2026-11-08T10:00:05Z' }), 'crm_lead_id', [
      msg('out', '2026-11-08T10:00:10Z', 'read'), msg('in', '2026-11-08T10:30:00Z', null),
    ], ADESSO);
    expect(s).toMatchObject({ chat_nuova: true, con_chat: true, consegnato: true, risposto: true, trovata_per: 'crm_lead_id' });
  });

  it('chat gia nota se nata piu di 10 minuti prima; messaggi vecchi non contano', () => {
    const s = statoLead(LEAD, conv({ created_at: '2026-10-01T10:00:00Z' }), 'crm_lead_id', [
      msg('out', '2026-10-01T10:00:00Z', 'read'), msg('in', '2026-10-01T11:00:00Z', null),
    ], ADESSO);
    expect(s).toMatchObject({ chat_nuova: false, con_chat: false, consegnato: false, risposto: false });
  });

  it('con chat da 2 minuti prima; consegnato solo con delivered/read dopo l ingresso', () => {
    const s = statoLead(LEAD, conv(), 'crm_lead_id', [msg('out', '2026-11-08T09:58:30Z', 'delivered'), msg('out', '2026-11-08T10:01:00Z', 'failed')], ADESSO);
    expect(s).toMatchObject({ con_chat: true, consegnato: false, chat_nuova: true });
  });

  it('esito solo se scritto dopo l ingresso', () => {
    const vecchio = statoLead(LEAD, conv({ bot_outcome: 'APPUNTAMENTO', bot_outcome_at: '2026-11-01T10:00:00Z' }), 'crm_lead_id', [], ADESSO);
    const nuovo = statoLead(LEAD, conv({ bot_outcome: 'APPUNTAMENTO', bot_outcome_at: '2026-11-08T12:00:00Z' }), 'crm_lead_id', [], ADESSO);
    expect(vecchio.bot_outcome).toBeNull();
    expect(nuovo.bot_outcome).toBe('APPUNTAMENTO');
  });

  it('scheda inviata e professione dalla chat; null senza chat', () => {
    const s = statoLead(LEAD, conv({ scheda_inviata_at: '2026-11-08T10:00:20Z', professione: 'Video Editor' }), 'crm_lead_id', [], ADESSO);
    expect(s).toMatchObject({ scheda_inviata_at: '2026-11-08T10:00:20Z', professione: 'Video Editor' });
    expect(statoLead(LEAD, conv(), 'crm_lead_id', [], ADESSO)).toMatchObject({ scheda_inviata_at: null, professione: null });
    expect(statoLead(LEAD, null, null, [], ADESSO)).toMatchObject({ scheda_inviata_at: null, professione: null });
  });

  it('ignora i messaggi di altre chat', () => {
    const s = statoLead(LEAD, conv(), 'telefono', [msg('in', '2026-11-08T11:00:00Z', null, 2)], ADESSO);
    expect(s.risposto).toBe(false);
    expect(s.trovata_per).toBe('telefono');
  });
});

describe('convPrincipale', () => {
  it('sceglie la chat con l ultimo messaggio piu recente', () => {
    expect(convPrincipale([conv({ id: 1, last_message_at: '2026-11-01T00:00:00Z' }), conv({ id: 2, last_message_at: '2026-11-05T00:00:00Z' })])?.id).toBe(2);
    expect(convPrincipale([])).toBeNull();
  });
});

describe('riepilogoPerFunnel', () => {
  it('conta chat, risposte, appuntamenti, eta media ed esiti per funnel', () => {
    const r = riepilogoPerFunnel([
      { crm_funnel: 'BLACK FRIDAY', created_at: '2026-11-09T08:00:00Z', bot_outcome: 'APPUNTAMENTO', last_inbound_at: '2026-11-09T08:10:00Z' },
      { crm_funnel: 'BLACK FRIDAY', created_at: '2026-11-09T06:00:00Z', bot_outcome: null, last_inbound_at: null },
      { crm_funnel: null, created_at: '2026-11-09T09:00:00Z', bot_outcome: 'NON_RISPOSTO', last_inbound_at: null },
    ], ADESSO);
    expect(r[0]).toEqual({ funnel: 'BLACK FRIDAY', chat: 2, risposto: 1, appuntamenti: 1, eta_media_ore: 3, esiti: { APPUNTAMENTO: 1, ATTIVA: 1 } });
    expect(r[1]).toMatchObject({ funnel: 'SCONOSCIUTO', chat: 1, risposto: 0 });
  });
});

describe('leggiRichiesta', () => {
  it('accetta il corpo del CRM e rifiuta quello malformato', () => {
    const ok = leggiRichiesta({ ts: '2026-11-09T10:00:00Z', dal: '2026-11-06T23:00:00Z', leads: [{ id: 'a', ingresso: '2026-11-08T10:00:00Z', telefono: '333' }] });
    expect(ok?.leads[0]).toEqual({ id: 'a', ingresso: '2026-11-08T10:00:00Z', telefono: '333' });
    expect(leggiRichiesta({ ts: 'x', dal: '2026-11-06', leads: [] })).toBeNull();
    expect(leggiRichiesta({ ts: '2026-11-09T10:00:00Z', dal: '2026-11-06', leads: [{ id: 'a' }] })).toBeNull();
  });
});

describe('scheda della persona per telefono (PO 10/11/2026, caso Ana Padilla)', () => {
  it('nessuna chat col suo id: la chat del telefono, agganciata al lead BF, ha la scheda e conta', () => {
    const chatBf = conv({ id: 31185, crm_lead_id: '6b7c3c2d', scheda_inviata_at: '2026-11-05T05:51:31Z', professione: 'graphic_designer' });
    const s = statoLead(LEAD, chatBf, 'telefono', [], ADESSO, [chatBf]);
    expect(s).toMatchObject({ trovata_per: 'telefono', scheda_inviata_at: '2026-11-05T05:51:31Z', professione: 'graphic_designer', scheda_trovata_per: 'chat' });
  });
  it('chat col suo id senza scheda, scheda su un altra chat dello stesso telefono: conta, per telefono', () => {
    const sua = conv({ id: 1, scheda_inviata_at: null });
    const altra = conv({ id: 2, crm_lead_id: 'altro', scheda_inviata_at: '2026-11-05T05:51:31Z', professione: 'copywriter' });
    const s = statoLead(LEAD, sua, 'crm_lead_id', [], ADESSO, [sua, altra]);
    expect(s).toMatchObject({ conversation_id: 1, scheda_inviata_at: '2026-11-05T05:51:31Z', professione: 'copywriter', scheda_trovata_per: 'telefono' });
  });
  it('la scheda della sua chat vince; nessuna scheda da nessuna parte = null', () => {
    const sua = conv({ id: 1, scheda_inviata_at: '2026-11-08T10:00:20Z', professione: 'video_editor' });
    const altra = conv({ id: 2, scheda_inviata_at: '2026-11-01T10:00:00Z', professione: 'copywriter' });
    expect(statoLead(LEAD, sua, 'crm_lead_id', [], ADESSO, [sua, altra])).toMatchObject({ scheda_inviata_at: '2026-11-08T10:00:20Z', scheda_trovata_per: 'chat' });
    expect(statoLead(LEAD, conv(), 'crm_lead_id', [], ADESSO, [conv({ id: 9 })])).toMatchObject({ scheda_inviata_at: null, scheda_trovata_per: null });
  });
  it('schedaDellaPersona: il primo invio fra le chat del telefono', () => {
    expect(schedaDellaPersona([])).toBeNull();
    expect(schedaDellaPersona([
      conv({ id: 1, scheda_inviata_at: '2026-11-06T10:00:00Z', professione: 'a' }),
      conv({ id: 2, scheda_inviata_at: '2026-11-05T10:00:00Z', professione: 'b' }),
    ])).toEqual({ scheda_inviata_at: '2026-11-05T10:00:00Z', professione: 'b' });
  });
});
