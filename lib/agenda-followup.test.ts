import { describe, it, expect } from 'vitest';
import { decideAgendaFollowup, agendaFollowupText, AGENDA_FOLLOWUP_DELAY_MS } from './agenda-followup';

const H = 3600_000;
const base = {
  agendaSentAtMs: 0,
  nowMs: 3 * H,            // 3h dopo l'agenda
  terminal: false,
  followupAlreadySent: false,
  lastInboundAtMs: 2.5 * H, // inbound recente → finestra 24h aperta
  lastMessageIsInbound: false,
  romeHour: 15,             // orario buono
  gdoPostino: false,        // conversazione normale, non un lead del GDO
};

describe('decideAgendaFollowup', () => {
  it('manda quando: ≥2h, non preso, mai inviato, finestra aperta, orario ok', () => {
    expect(decideAgendaFollowup(base)).toBe('send');
  });
  it('niente se agenda inviata da meno di 2h', () => {
    expect(decideAgendaFollowup({ ...base, nowMs: 1 * H })).toBe('none');
  });
  it('niente se la conversazione ha un esito terminale (preso/scartato/interrotto)', () => {
    expect(decideAgendaFollowup({ ...base, terminal: true })).toBe('none');
  });
  it('niente se il follow-up è già stato inviato', () => {
    expect(decideAgendaFollowup({ ...base, followupAlreadySent: true })).toBe('none');
  });
  it('niente se non c\'è alcun inbound (finestra non apribile)', () => {
    expect(decideAgendaFollowup({ ...base, lastInboundAtMs: null })).toBe('none');
  });
  it('niente se l\'ultimo inbound è oltre 24h fa (finestra chiusa)', () => {
    expect(decideAgendaFollowup({ ...base, nowMs: 30 * H, lastInboundAtMs: 2.5 * H })).toBe('none');
  });
  it('niente di notte (prima delle 9)', () => {
    expect(decideAgendaFollowup({ ...base, romeHour: 7 })).toBe('none');
  });
  it('niente a tarda sera (dalle 21 in poi)', () => {
    expect(decideAgendaFollowup({ ...base, romeHour: 21 })).toBe('none');
  });
  it('niente se l\'ultimo messaggio è un inbound non ancora risposto (lo gestisce il backstop)', () => {
    expect(decideAgendaFollowup({ ...base, lastMessageIsInbound: true })).toBe('none');
  });
  it('la costante di ritardo è 2h', () => {
    expect(AGENDA_FOLLOWUP_DELAY_MS).toBe(2 * H);
  });
});

describe('decideAgendaFollowup — lead dei GDO', () => {
  // Il link di prenotazione è LO STESSO del bot: senza questa guardia il follow-up
  // "non ho ancora visto la conferma" arriverebbe a chi ha appena preso l'appuntamento
  // al telefono col commerciale. È esattamente ciò che il CRM ci ha chiesto di evitare.
  it('mai il follow-up "prenota" a un lead che ha già l’appuntamento col GDO', () => {
    expect(decideAgendaFollowup({ ...base, gdoPostino: true })).toBe('none');
  });
});

describe('agendaFollowupText', () => {
  it('interpola il nome del lead', () => {
    expect(agendaFollowupText('Luca')).toContain('Luca');
    expect(agendaFollowupText('Luca')).toContain('slot');
  });
  it('funziona anche senza nome', () => {
    const t = agendaFollowupText(null);
    expect(t.length).toBeGreaterThan(0);
    expect(t).not.toContain('null');
  });
  it('usa solo il nome quando dal CRM arriva anche il cognome', () => {
    const t = agendaFollowupText('LUCA VERDI');
    expect(t).toContain('Ciao Luca');
    expect(t).not.toContain('VERDI');
  });
});
