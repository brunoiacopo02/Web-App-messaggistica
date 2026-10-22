import { describe, it, expect } from 'vitest';
import {
  reminderTargets, dueReminder, slotLabel, pickReminder24Template,
  decideGdoReminder24, gdoReminderVars, gdoReminderText, type GdoReminder24Input,
  gdoReminder24Raggiungibile,
} from './precall-reminders';

const at = (iso: string) => new Date(iso).getTime();

describe('reminderTargets', () => {
  it('mette R24 a 24h prima e R3 a 3h prima quando cadono in fascia', () => {
    const appt = at('2026-08-03T15:00:00+02:00');
    const t = reminderTargets(appt);
    expect(t.r24At).toBe(at('2026-08-02T15:00:00+02:00'));
    expect(t.r3At).toBe(at('2026-08-03T12:00:00+02:00'));
  });

  it('clampa R3 alle 08:30 quando 3h prima sarebbe notte', () => {
    const appt = at('2026-08-03T09:00:00+02:00');
    const t = reminderTargets(appt);
    expect(t.r3At).toBe(at('2026-08-03T08:30:00+02:00'));
  });

  it('clampa anche R24 dentro la fascia', () => {
    const appt = at('2026-08-03T21:00:00+02:00');
    const t = reminderTargets(appt);
    expect(t.r24At).toBe(at('2026-08-02T20:30:00+02:00'));
  });
});

describe('dueReminder', () => {
  const appt = at('2026-08-03T15:00:00+02:00');

  it('prima dell istante di R24 non manda niente', () => {
    expect(dueReminder(appt, at('2026-08-02T14:00:00+02:00'), [])).toBeNull();
  });

  it('dopo l istante di R24 manda R24', () => {
    expect(dueReminder(appt, at('2026-08-02T15:30:00+02:00'), [])).toBe('r24');
  });

  it('non rimanda R24 se già inviato', () => {
    expect(dueReminder(appt, at('2026-08-02T16:00:00+02:00'), ['r24'])).toBeNull();
  });

  it('dopo l istante di R3 manda R3', () => {
    expect(dueReminder(appt, at('2026-08-03T12:30:00+02:00'), ['r24'])).toBe('r3');
  });

  it('se si arriva tardi salta R24 e manda solo R3', () => {
    expect(dueReminder(appt, at('2026-08-03T12:30:00+02:00'), [])).toBe('r3');
  });

  it('non manda niente negli ultimi 15 minuti né dopo l appuntamento', () => {
    expect(dueReminder(appt, at('2026-08-03T14:50:00+02:00'), ['r24'])).toBeNull();
    expect(dueReminder(appt, at('2026-08-03T16:00:00+02:00'), [])).toBeNull();
  });

  it('non manda niente se entrambi già inviati', () => {
    expect(dueReminder(appt, at('2026-08-03T13:00:00+02:00'), ['r24', 'r3'])).toBeNull();
  });
});

describe('slotLabel', () => {
  it('usa "oggi" quando l appuntamento è nello stesso giorno Rome', () => {
    expect(slotLabel(at('2026-08-03T15:00:00+02:00'), at('2026-08-03T09:00:00+02:00')))
      .toBe('oggi alle 15:00');
  });

  it('usa "domani" quando è il giorno dopo', () => {
    expect(slotLabel(at('2026-08-03T15:00:00+02:00'), at('2026-08-02T15:00:00+02:00')))
      .toBe('domani alle 15:00');
  });

  it('altrimenti usa il giorno della settimana', () => {
    expect(slotLabel(at('2026-08-03T15:00:00+02:00'), at('2026-08-01T09:00:00+02:00')))
      .toBe('lunedì alle 15:00');
  });
});

describe('pickReminder24Template: a chi ha gia visto il video non si richiede del video', () => {
  const base: Parameters<typeof pickReminder24Template>[0] = { hasVideoWatchedEvent: false, inboundAfterVideoMs: null, novideoSid: 'HXnovideo', defaultSid: 'HXdefault' };
  const pick = (over: Partial<typeof base> = {}) => pickReminder24Template({ ...base, ...over });

  it('usa il template standard quando non sappiamo nulla', () => {
    expect(pick()).toBe('HXdefault');
  });

  it('usa il template senza domanda quando il tag VIDEO_VISTO e stato registrato', () => {
    expect(pick({ hasVideoWatchedEvent: true })).toBe('HXnovideo');
  });

  it('usa il template senza domanda quando il lead ha scritto dopo il link del video', () => {
    expect(pick({ inboundAfterVideoMs: Date.UTC(2026, 6, 26, 8, 39) })).toBe('HXnovideo');
  });

  it('torna al template standard se il SID senza domanda non e configurato', () => {
    expect(pick({ hasVideoWatchedEvent: true, novideoSid: null })).toBe('HXdefault');
  });

  it('il template standard resta quello di default anche con entrambi i segnali assenti', () => {
    expect(pick({ hasVideoWatchedEvent: false, inboundAfterVideoMs: null })).toBe('HXdefault');
  });
});

describe('decideGdoReminder24: il promemoria del giorno prima ai lead GDO', () => {
  const H = 3600_000;
  // Giovedì 22 ottobre 2026, 14:00 a Roma (CEST): la call è venerdì 23 alle 10:00, fra 20h.
  const NOW = at('2026-10-22T12:00:00Z');
  const base = (over: Partial<GdoReminder24Input> = {}): GdoReminder24Input => ({
    enabled: true,
    gdoAgendaAt: new Date(NOW - 30 * H).toISOString(),
    botOutcome: null,
    appuntamentoAt: new Date(NOW + 20 * H).toISOString(),
    videoSentAt: new Date(NOW - 29 * H).toISOString(),
    recapSentAt: null,
    lastInboundAtMs: NOW - 3 * 24 * H,
    aiPausedAt: null,
    cancelRequestedAt: null,
    giaInviato: false,
    nowMs: NOW,
    ...over,
  });

  it('finestra chiusa: parte il template', () => {
    expect(decideGdoReminder24(base())).toBe('template');
  });

  it('finestra aperta da 10 ore: parte in testo libero', () => {
    expect(decideGdoReminder24(base({ lastInboundAtMs: NOW - 10 * H }))).toBe('testo');
  });

  it('conversazione viva (ultimo messaggio 2 ore fa): niente', () => {
    expect(decideGdoReminder24(base({ lastInboundAtMs: NOW - 2 * H }))).toBeNull();
  });

  it('interruttore spento: niente', () => {
    expect(decideGdoReminder24(base({ enabled: false }))).toBeNull();
  });

  it('appuntamento fissato dal bot: ha già i suoi promemoria', () => {
    expect(decideGdoReminder24(base({ botOutcome: 'APPUNTAMENTO' }))).toBeNull();
  });

  it('video non ancora mandato: niente', () => {
    expect(decideGdoReminder24(base({ videoSentAt: null }))).toBeNull();
  });

  it('agenda arrivata 8 ore fa: la copre il recap', () => {
    expect(decideGdoReminder24(base({ gdoAgendaAt: new Date(NOW - 8 * H).toISOString() }))).toBeNull();
  });

  it('recap uscito 5 ore fa: niente', () => {
    expect(decideGdoReminder24(base({ recapSentAt: new Date(NOW - 5 * H).toISOString() }))).toBeNull();
  });

  it('già inviato per questa call: niente', () => {
    expect(decideGdoReminder24(base({ giaInviato: true }))).toBeNull();
  });

  it('chat in pausa o disdetta chiesta: niente', () => {
    expect(decideGdoReminder24(base({ aiPausedAt: new Date(NOW - H).toISOString() }))).toBeNull();
    expect(decideGdoReminder24(base({ cancelRequestedAt: new Date(NOW - H).toISOString() }))).toBeNull();
  });

  it('call fra 10 minuti: niente', () => {
    expect(decideGdoReminder24(base({ appuntamentoAt: new Date(NOW + 10 * 60_000).toISOString() }))).toBeNull();
  });

  it('prima di r24At (call fra 40 ore): niente', () => {
    expect(decideGdoReminder24(base({ appuntamentoAt: new Date(NOW + 40 * H).toISOString() }))).toBeNull();
  });

  it('call alle 10 e adesso le 08:40 dello stesso giorno: il pomeriggio di Noemi è già passato', () => {
    const now = at('2026-10-23T06:40:00Z'); // venerdì 23, 08:40 a Roma
    expect(decideGdoReminder24(base({
      nowMs: now,
      appuntamentoAt: '2026-10-23T08:00:00Z',
      gdoAgendaAt: new Date(now - 40 * H).toISOString(),
    }))).toBeNull();
  });
});

describe('gdoReminder24Raggiungibile: il promemoria GDO potrà ancora partire?', () => {
  it('agenda la sera prima, call fra due giorni al mattino: sì (ancora prima di r24At)', () => {
    expect(gdoReminder24Raggiungibile({
      gdoAgendaAt: '2026-08-01T19:00:00Z', appuntamentoAt: '2026-08-03T08:00:00Z',
      nowMs: at('2026-08-02T06:00:00Z'),
    })).toBe(true);
  });

  it('agenda alle 14 del giorno prima di una call alle 11:30: il pomeriggio di Noemi passa prima delle 12 ore, no', () => {
    expect(gdoReminder24Raggiungibile({
      gdoAgendaAt: '2026-08-02T12:00:00Z', appuntamentoAt: '2026-08-03T09:30:00Z',
      nowMs: at('2026-08-03T06:00:00Z'),
    })).toBe(false);
  });

  it("call fra mezz'ora, o data assente o illeggibile: no", () => {
    const now = at('2026-08-03T09:00:00Z');
    expect(gdoReminder24Raggiungibile({ gdoAgendaAt: '2026-08-01T19:00:00Z', appuntamentoAt: '2026-08-03T09:30:00Z', nowMs: now })).toBe(false);
    expect(gdoReminder24Raggiungibile({ gdoAgendaAt: '2026-08-01T19:00:00Z', appuntamentoAt: null, nowMs: now })).toBe(false);
    expect(gdoReminder24Raggiungibile({ gdoAgendaAt: null, appuntamentoAt: '2026-08-04T09:30:00Z', nowMs: now })).toBe(false);
    expect(gdoReminder24Raggiungibile({ gdoAgendaAt: '2026-08-01T19:00:00Z', appuntamentoAt: 'boh', nowMs: now })).toBe(false);
  });

  it('agenda arrivata da poco ma 12 ore dopo il pomeriggio di Noemi non è passato: sì', () => {
    // Call alle 17 (Noemi lo stesso giorno, qualche ora prima): agenda alle 23 della sera prima.
    expect(gdoReminder24Raggiungibile({
      gdoAgendaAt: '2026-08-02T21:00:00Z', appuntamentoAt: '2026-08-03T15:00:00Z',
      nowMs: at('2026-08-02T21:30:00Z'),
    })).toBe(true);
  });
});

describe('gdoReminderVars e gdoReminderText', () => {
  it('call venerdì alle 10, adesso giovedì alle 10: Noemi chiama oggi pomeriggio', () => {
    const v = gdoReminderVars({ nome: 'mario rossi', call: new Date('2026-10-23T08:00:00Z'), nowMs: at('2026-10-22T08:00:00Z') });
    expect(v['1']).toBe('Mario');
    expect(v['2']).toBe('venerdì 23 ottobre alle 10:00');
    expect(v['3']).toBe('oggi pomeriggio');
  });

  it('call venerdì alle 18, adesso giovedì alle 18: domani, qualche ora prima', () => {
    const v = gdoReminderVars({ nome: null, call: new Date('2026-10-23T16:00:00Z'), nowMs: at('2026-10-22T16:00:00Z') });
    expect(v['3']).toBe('domani, qualche ora prima');
  });

  it('il testo libero è il template con le variabili al loro posto', () => {
    expect(gdoReminderText({ '1': 'Mario', '2': 'venerdì 23 ottobre alle 10:00', '3': 'oggi pomeriggio' })).toBe(
      "Ciao Mario, ti ricordo la tua videochiamata con Fenice Academy: venerdì 23 ottobre alle 10:00. Prima ti chiama Noemi, una collega, oggi pomeriggio da un numero di cellulare: rispondi, serve a confermare la videochiamata. Se non l'hai ancora fatto, guarda il video che ti ho mandato qui.",
    );
  });
});
