import { describe, it, expect } from 'vitest';
import { reminderTargets, dueReminder, slotLabel } from './precall-reminders';

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
