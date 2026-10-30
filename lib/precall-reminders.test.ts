import { describe, it, expect } from 'vitest';
import {
  reminderTargets, dueReminder, slotLabel, pickReminder24Template,
  decideGdoReminder24, gdoReminderVars, gdoReminderText, type GdoReminder24Input,
  gdoReminder24Raggiungibile, promemoriaGiaInviati,
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

  // PO 24/10/2026: dalle 9 Noemi chiama la mattina stessa, quindi alle 08:40 il promemoria
  // di una call delle 10 ha ancora senso. Alle 9 invece Noemi chiama solo il giorno prima.
  it('call alle 10 e adesso le 08:40 dello stesso giorno: Noemi lo chiama ancora stamattina, parte', () => {
    const now = at('2026-10-23T06:40:00Z'); // venerdì 23, 08:40 a Roma
    expect(decideGdoReminder24(base({
      nowMs: now,
      appuntamentoAt: '2026-10-23T08:00:00Z',
      gdoAgendaAt: new Date(now - 40 * H).toISOString(),
    }))).not.toBeNull();
  });

  it('call alle 9 e adesso le 07:00 dello stesso giorno: il giorno di Noemi è passato, niente', () => {
    const now = at('2026-10-23T05:00:00Z'); // venerdì 23, 07:00 a Roma
    expect(decideGdoReminder24(base({
      nowMs: now,
      appuntamentoAt: '2026-10-23T07:00:00Z',
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

  it('agenda alle 14 del giorno prima di una call alle 11:30: Noemi chiama la mattina stessa, sì', () => {
    expect(gdoReminder24Raggiungibile({
      gdoAgendaAt: '2026-08-02T12:00:00Z', appuntamentoAt: '2026-08-03T09:30:00Z',
      nowMs: at('2026-08-03T06:00:00Z'),
    })).toBe(true);
  });

  it('agenda alle 14 del giorno prima di una call alle 9: il giorno di Noemi passa prima delle 12 ore, no', () => {
    expect(gdoReminder24Raggiungibile({
      gdoAgendaAt: '2026-08-02T12:00:00Z', appuntamentoAt: '2026-08-03T07:00:00Z',
      nowMs: at('2026-08-03T04:00:00Z'),
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
  // PO 24/10/2026: conta quando è arrivata l'agenda, non adesso (lib/noemi-quando.ts).
  it('call venerdì alle 10 fissata mercoledì, adesso giovedì alle 10: oggi, e se non ti trova domani mattina', () => {
    const v = gdoReminderVars({
      nome: 'mario rossi', call: new Date('2026-10-23T08:00:00Z'), nowMs: at('2026-10-22T08:00:00Z'),
      fissatoIl: new Date('2026-10-21T14:00:00Z'),
    });
    expect(v['1']).toBe('Mario');
    expect(v['2']).toBe('venerdì 23 ottobre alle 10:00');
    expect(v['3']).toBe('oggi, e se non ti trova domani in mattinata dalle 9');
  });

  it('call venerdì alle 10 fissata giovedì, adesso venerdì alle 06: oggi in mattinata dalle 9', () => {
    const v = gdoReminderVars({
      nome: null, call: new Date('2026-10-23T08:00:00Z'), nowMs: at('2026-10-23T04:00:00Z'),
      fissatoIl: new Date('2026-10-22T14:00:00Z'),
    });
    expect(v['3']).toBe('oggi in mattinata dalle 9');
  });

  it('call venerdì alle 10 fissata mercoledì, adesso venerdì alle 07: oggi in mattinata', () => {
    const v = gdoReminderVars({
      nome: null, call: new Date('2026-10-23T08:00:00Z'), nowMs: at('2026-10-23T05:00:00Z'),
      fissatoIl: new Date('2026-10-21T14:00:00Z'),
    });
    expect(v['3']).toBe('oggi in mattinata dalle 9');
  });

  it('call venerdì alle 9, adesso giovedì alle 9: oggi', () => {
    const v = gdoReminderVars({
      nome: null, call: new Date('2026-10-23T07:00:00Z'), nowMs: at('2026-10-22T07:00:00Z'),
      fissatoIl: new Date('2026-10-21T14:00:00Z'),
    });
    expect(v['3']).toBe('oggi');
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

describe('call alle 9 fissata dopo le 19 del giorno prima (PO 24/10/2026)', () => {
  const call = '2026-10-30T09:00:00+01:00';
  const fissata = '2026-10-29T20:30:00+01:00';

  it('il promemoria del giorno prima non è raggiungibile: Noemi non chiama prima', () => {
    expect(gdoReminder24Raggiungibile({
      gdoAgendaAt: fissata, appuntamentoAt: call, nowMs: at('2026-10-29T21:00:00+01:00'),
    })).toBe(false);
  });

  it('Noemi chiama alle 9 in punto', () => {
    const v = gdoReminderVars({
      nome: null, call: new Date(call), nowMs: at('2026-10-29T21:00:00+01:00'), fissatoIl: new Date(fissata),
    });
    expect(v['3']).toBe('domani alle 9 in punto');
  });
});

describe('gdoReminder24Raggiungibile: call alle 9 fissata alle 19 del giorno lavorativo prima', () => {
  it('no: nove-in-punto, il giorno prima è già passato', () => {
    expect(gdoReminder24Raggiungibile({
      gdoAgendaAt: '2026-10-29T19:00:00+01:00', appuntamentoAt: '2026-10-30T09:00:00+01:00',
      nowMs: at('2026-10-29T19:30:00+01:00'),
    })).toBe(false);
  });
});

describe('fissatoIl: la call spostata conta dallo spostamento, non dall agenda', () => {
  const H = 3600_000;
  // Giovedì 22/10/2026 14:00 a Roma: la call è venerdì 23 alle 11, agenda di 3 giorni fa.
  const NOW = at('2026-10-22T12:00:00Z');
  const agenda = new Date(NOW - 72 * H).toISOString();
  const spostata = new Date(NOW - 3 * H).toISOString(); // giovedì mattina: la call di venerdì è «domani»

  it('gdoReminderVars: senza fissatoIl dello spostamento "giorno prima e poi mattina", con lui "mattina"', () => {
    const call = new Date(NOW + 21 * H);
    const vecchio = gdoReminderVars({ nome: 'Anna', call, nowMs: NOW, fissatoIl: new Date(agenda) });
    const nuovo = gdoReminderVars({ nome: 'Anna', call, nowMs: NOW, fissatoIl: new Date(spostata) });
    expect(vecchio['3']).toContain('e se non ti trova');
    expect(nuovo['3']).not.toContain('e se non ti trova');
    expect(nuovo['3']).toContain('in mattinata dalle 9');
  });

  it('gdoReminder24Raggiungibile accetta fissatoIl; la regola delle 12 ore resta sull agenda', () => {
    const i = { appuntamentoAt: new Date(NOW + 21 * H).toISOString(), gdoAgendaAt: agenda, nowMs: NOW };
    expect(gdoReminder24Raggiungibile({ ...i, fissatoIl: spostata })).toBe(true);
    // Spostata un ora fa: conta l agenda (3 giorni), quindi niente attesa di 12 ore.
    expect(gdoReminder24Raggiungibile({ ...i, fissatoIl: new Date(NOW - H).toISOString() })).toBe(true);
    // Agenda di 2 ore fa: attende comunque, anche se la data è più vecchia.
    expect(gdoReminder24Raggiungibile({ ...i, gdoAgendaAt: new Date(NOW - 2 * H).toISOString(), fissatoIl: spostata })).toBe(true);
  });

  it('decideGdoReminder24 accetta fissatoIl e non salta la regola delle 12 ore', () => {
    const b: GdoReminder24Input = {
      enabled: true, gdoAgendaAt: agenda, botOutcome: null,
      appuntamentoAt: new Date(NOW + 21 * H).toISOString(), videoSentAt: new Date(NOW - 70 * H).toISOString(),
      recapSentAt: null, lastInboundAtMs: null, aiPausedAt: null, cancelRequestedAt: null,
      giaInviato: false, nowMs: NOW, fissatoIl: new Date(NOW - 1 * H).toISOString(),
    };
    expect(decideGdoReminder24(b)).toBe('template');
    expect(decideGdoReminder24({ ...b, gdoAgendaAt: new Date(NOW - 8 * H).toISOString() })).toBeNull();
  });
});

describe('promemoriaGiaInviati: dopo uno spostamento del bot ripartono T-24h e T-3h (chat 29775)', () => {
  const sids = { r24: ['HX24', 'HX24NOVIDEO'], r3: 'HX3' };
  const msgs = [
    { conversation_id: 29775, template_sid: 'HX24', created_at: '2026-10-29T09:30:34Z' },
    { conversation_id: 29775, template_sid: 'HX3', created_at: '2026-10-30T07:30:35Z' },
    { conversation_id: 1, template_sid: 'HX24NOVIDEO', created_at: '2026-10-29T09:00:00Z' },
    { conversation_id: 1, template_sid: 'HXALTRO', created_at: '2026-10-29T09:00:00Z' },
  ];

  it('senza spostamenti: come prima, un promemoria vale per la chat', () => {
    const m = promemoriaGiaInviati(msgs, sids, new Map());
    expect(m.get(29775)).toEqual(['r24', 'r3']);
    expect(m.get(1)).toEqual(['r24']);
  });

  it('spostata dopo i due promemoria: per la data nuova non ne risulta nessuno', () => {
    const m = promemoriaGiaInviati(msgs, sids, new Map([[29775, Date.parse('2026-10-30T08:04:55Z')]]));
    expect(m.get(29775)).toBeUndefined();
    expect(m.get(1)).toEqual(['r24']);
    expect(dueReminder(Date.parse('2026-11-03T10:00:00Z'), Date.parse('2026-11-02T10:00:00Z'), m.get(29775) ?? [])).toBe('r24');
  });

  it('un promemoria partito dopo lo spostamento conta', () => {
    const conDopo = [...msgs, { conversation_id: 29775, template_sid: 'HX24', created_at: '2026-11-02T10:00:00Z' }];
    const m = promemoriaGiaInviati(conDopo, sids, new Map([[29775, Date.parse('2026-10-30T08:04:55Z')]]));
    expect(m.get(29775)).toEqual(['r24']);
  });
});
