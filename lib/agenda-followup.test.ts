import { describe, it, expect } from 'vitest';
import {
  decideAgendaFollowup,
  agendaFollowupText,
  AGENDA_FOLLOWUP_DELAY_MS,
  datiDecisioneDaMessaggi,
  type DecisionMsgRow,
} from './agenda-followup';

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
  confermaForm: false,      // non ha (ancora) confermato il form
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

describe('decideAgendaFollowup — conferma del form', () => {
  // Il testo dice "non ho ancora visto la conferma": a chi ha già prenotato sul form
  // è il messaggio peggiore possibile, gli dice che non risulta dopo che ha fatto tutto.
  it('non sollecita chi ha già confermato il form', () => {
    const base = {
      agendaSentAtMs: Date.parse('2026-09-15T15:58:00+02:00'),
      nowMs: Date.parse('2026-09-16T12:00:00+02:00'),
      terminal: false,
      followupAlreadySent: false,
      lastInboundAtMs: Date.parse('2026-09-15T16:07:00+02:00'),
      lastMessageIsInbound: false,
      romeHour: 12,
      gdoPostino: false,
    };
    // senza la conferma il sollecito parte (comportamento di sempre)
    expect(decideAgendaFollowup({ ...base, confermaForm: false })).not.toBe('none');
    // con la conferma no: gli direbbe che non risulta, dopo che ha prenotato
    expect(decideAgendaFollowup({ ...base, confermaForm: true })).toBe('none');
  });
});

describe('datiDecisioneDaMessaggi', () => {
  // L'input è in ordine DECRESCENTE (più recente per primo), come torna la query a
  // Supabase con `.order('created_at', { ascending: false })`.
  it('lista vuota: nessun segnale', () => {
    expect(datiDecisioneDaMessaggi([])).toEqual({
      lastInboundAtMs: null,
      lastMessageIsInbound: false,
      confermaForm: false,
    });
  });

  it('ultimo messaggio inbound', () => {
    const msgsDesc: DecisionMsgRow[] = [
      { direction: 'in', body: 'ciao, ci sono', created_at: '2026-09-16T10:00:00.000Z' },
      { direction: 'out', body: 'link agenda', created_at: '2026-09-16T09:00:00.000Z' },
    ];
    const r = datiDecisioneDaMessaggi(msgsDesc);
    expect(r.lastMessageIsInbound).toBe(true);
    expect(r.lastInboundAtMs).toBe(Date.parse('2026-09-16T10:00:00.000Z'));
    expect(r.confermaForm).toBe(false);
  });

  it('ultimo messaggio outbound, ma con un inbound più indietro nella lista', () => {
    const msgsDesc: DecisionMsgRow[] = [
      { direction: 'out', body: 'ok grazie a presto', created_at: '2026-09-16T11:00:00.000Z' },
      { direction: 'in', body: 'perfetto', created_at: '2026-09-16T10:00:00.000Z' },
      { direction: 'out', body: 'link agenda', created_at: '2026-09-16T09:00:00.000Z' },
    ];
    const r = datiDecisioneDaMessaggi(msgsDesc);
    expect(r.lastMessageIsInbound).toBe(false);
    expect(r.lastInboundAtMs).toBe(Date.parse('2026-09-16T10:00:00.000Z'));
  });

  it('conferma del form con la domanda di verifica in mezzo alla lista', () => {
    // Cronologia vera (crescente): ..., domanda di verifica, "Noemi", messaggio finale.
    // Qui sotto è già capovolta in ordine decrescente, come la riceve la funzione.
    const msgsDesc: DecisionMsgRow[] = [
      { direction: 'out', body: 'Perfetto, ci vediamo lì!', created_at: '2026-09-16T10:02:00.000Z' },
      { direction: 'in', body: 'Noemi', created_at: '2026-09-16T10:01:00.000Z' },
      { direction: 'out', body: 'Dimmi, quando hai cliccato su invia, che nome ti è comparso?', created_at: '2026-09-16T10:00:30.000Z' },
      { direction: 'out', body: 'Ecco il link per prenotare', created_at: '2026-09-16T10:00:00.000Z' },
    ];
    expect(datiDecisioneDaMessaggi(msgsDesc).confermaForm).toBe(true);
  });

  it('nessuna conferma del form: falso', () => {
    const msgsDesc: DecisionMsgRow[] = [
      { direction: 'in', body: 'ok grazie', created_at: '2026-09-16T10:01:00.000Z' },
      { direction: 'out', body: 'Ecco il link per prenotare', created_at: '2026-09-16T10:00:00.000Z' },
    ];
    expect(datiDecisioneDaMessaggi(msgsDesc).confermaForm).toBe(false);
  });

  it('caso limite: l\'unico inbound sta in fondo alla lista (il più vecchio dei letti)', () => {
    // È esattamente il caso che il tetto MAX_MESSAGES_FOR_DECISION rende raro: qui la
    // lista letta (dopo il troncamento a monte) contiene comunque l'inbound, in ultima
    // posizione perché è il più vecchio fra quelli letti.
    const msgsDesc: DecisionMsgRow[] = [
      { direction: 'out', body: 'msg 5', created_at: '2026-09-16T14:00:00.000Z' },
      { direction: 'out', body: 'msg 4', created_at: '2026-09-16T13:00:00.000Z' },
      { direction: 'out', body: 'msg 3', created_at: '2026-09-16T12:00:00.000Z' },
      { direction: 'out', body: 'msg 2', created_at: '2026-09-16T11:00:00.000Z' },
      { direction: 'in', body: 'msg 1, l\'unico inbound', created_at: '2026-09-16T10:00:00.000Z' },
    ];
    const r = datiDecisioneDaMessaggi(msgsDesc);
    expect(r.lastMessageIsInbound).toBe(false);
    expect(r.lastInboundAtMs).toBe(Date.parse('2026-09-16T10:00:00.000Z'));
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
