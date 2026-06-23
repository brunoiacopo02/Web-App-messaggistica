import { describe, it, expect } from 'vitest';
import { parseMarioReply } from './mario';

describe('parseMarioReply — esiti CRM', () => {
  it('APPUNTAMENTO con data → outcome+scheduledAt, testo pulito, flag legacy', () => {
    const r = parseMarioReply('Perfetto ci vediamo [ESITO:APPUNTAMENTO|2026-06-20T15:00:00+02:00]');
    expect(r.outcome).toBe('APPUNTAMENTO');
    expect(r.scheduledAt).toBe('2026-06-20T15:00:00+02:00');
    expect(r.appointmentFixed).toBe(true);
    expect(r.visibleReply).toBe('Perfetto ci vediamo');
  });
  it('RICHIAMO con data', () => {
    const r = parseMarioReply('Ti richiamo io [ESITO:RICHIAMO|2026-06-21T10:00:00+02:00]');
    expect(r.outcome).toBe('RICHIAMO');
    expect(r.scheduledAt).toBe('2026-06-21T10:00:00+02:00');
    expect(r.visibleReply).toBe('Ti richiamo io');
  });
  it('SCARTO con motivo', () => {
    const r = parseMarioReply('Va bene, buona giornata [ESITO:SCARTO|gia ha un consulente]');
    expect(r.outcome).toBe('DA_SCARTARE');
    expect(r.discardReason).toBe('gia ha un consulente');
    expect(r.visibleReply).toBe('Va bene, buona giornata');
  });
  it('legacy [APPUNTAMENTO_FISSATO] resta valido', () => {
    const r = parseMarioReply('ok [APPUNTAMENTO_FISSATO]');
    expect(r.appointmentFixed).toBe(true);
    expect(r.visibleReply).toBe('ok');
  });
  it('INTERROTTO con motivo → outcome+note, testo pulito', () => {
    const r = parseMarioReply('va bene, fammi sapere [ESITO:INTERROTTO|tentenna, dice ti faccio sapere]');
    expect(r.outcome).toBe('INTERROTTO');
    expect(r.note).toBe('tentenna, dice ti faccio sapere');
    expect(r.discardReason).toBeUndefined();
    expect(r.visibleReply).toBe('va bene, fammi sapere');
  });
  it('nessun tag → outcome undefined', () => {
    const r = parseMarioReply('ciao come va');
    expect(r.outcome).toBeUndefined();
    expect(r.appointmentFixed).toBe(false);
  });
});
