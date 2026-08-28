import { describe, it, expect } from 'vitest';
import { puoScrivere, type StatoConversazione } from './recupero-nr';
import type { CallAttempt } from './call-attempt';

const NOW = Date.parse('2026-08-28T12:00:00+02:00');

const EVENTO: CallAttempt = {
  leadId: 'u1',
  esito: 'no_answer',
  tentativo: 1,
  at: '2026-08-28T10:00:00+02:00',
  appointmentAt: '2026-08-29T15:00:00+02:00', // nel futuro rispetto a NOW
};

/** Lo stato "pulito": nessuna delle sei condizioni scatta, l'invio deve passare. */
function statoPulito(overrides: Partial<StatoConversazione> = {}): StatoConversazione {
  return {
    ai_owner: 'mario',
    ai_status: 'active',
    bot_outcome: null,
    bot_scheduled_at: '2026-08-29T15:00:00+02:00',
    cancel_requested_at: null,
    ultimoInboundAt: null,
    giaInviatoTentativo: false,
    ...overrides,
  };
}

describe('puoScrivere', () => {
  it('caso pulito: passa', () => {
    expect(puoScrivere(statoPulito(), EVENTO, NOW)).toEqual({ ok: true });
  });

  it('ultimoInboundAt precedente all\'evento: caso limite, deve passare', () => {
    // Il lead ha scritto PRIMA della chiamata a vuoto: non ha risposto a valle, quindi
    // non c'è niente che rende il recupero superfluo.
    const stato = statoPulito({ ultimoInboundAt: '2026-08-28T09:00:00+02:00' });
    expect(puoScrivere(stato, EVENTO, NOW)).toEqual({ ok: true });
  });

  it('1) ai_owner diverso da mario → non_nostro', () => {
    const stato = statoPulito({ ai_owner: 'altro' });
    expect(puoScrivere(stato, EVENTO, NOW)).toEqual({ ok: false, motivo: 'non_nostro' });
  });

  it('1) ai_owner assente → non_nostro', () => {
    const stato = statoPulito({ ai_owner: null });
    expect(puoScrivere(stato, EVENTO, NOW)).toEqual({ ok: false, motivo: 'non_nostro' });
  });

  it('2) cancel_requested_at valorizzato → disdetta_chiesta', () => {
    const stato = statoPulito({ cancel_requested_at: '2026-08-27T18:00:00+02:00' });
    expect(puoScrivere(stato, EVENTO, NOW)).toEqual({ ok: false, motivo: 'disdetta_chiesta' });
  });

  it('3) ai_status handed_off → passato_a_persona', () => {
    const stato = statoPulito({ ai_status: 'handed_off' });
    expect(puoScrivere(stato, EVENTO, NOW)).toEqual({ ok: false, motivo: 'passato_a_persona' });
  });

  it('4) ultimoInboundAt posteriore all\'evento → gia_risposto', () => {
    const stato = statoPulito({ ultimoInboundAt: '2026-08-28T11:00:00+02:00' });
    expect(puoScrivere(stato, EVENTO, NOW)).toEqual({ ok: false, motivo: 'gia_risposto' });
  });

  it('5) bot_scheduled_at assente → appuntamento_non_valido', () => {
    const stato = statoPulito({ bot_scheduled_at: null });
    expect(puoScrivere(stato, EVENTO, NOW)).toEqual({ ok: false, motivo: 'appuntamento_non_valido' });
  });

  it('5) bot_scheduled_at nel passato rispetto a now → appuntamento_non_valido', () => {
    const stato = statoPulito({ bot_scheduled_at: '2026-08-27T10:00:00+02:00' });
    expect(puoScrivere(stato, EVENTO, NOW)).toEqual({ ok: false, motivo: 'appuntamento_non_valido' });
  });

  it('6) giaInviatoTentativo → gia_inviato', () => {
    const stato = statoPulito({ giaInviatoTentativo: true });
    expect(puoScrivere(stato, EVENTO, NOW)).toEqual({ ok: false, motivo: 'gia_inviato' });
  });

  it('ordine di valutazione: non_nostro batte le altre condizioni contemporaneamente vere', () => {
    const stato = statoPulito({
      ai_owner: 'altro',
      cancel_requested_at: '2026-08-27T18:00:00+02:00',
      ai_status: 'handed_off',
    });
    expect(puoScrivere(stato, EVENTO, NOW)).toEqual({ ok: false, motivo: 'non_nostro' });
  });

  it('ordine di valutazione: disdetta_chiesta batte handed_off quando entrambe vere', () => {
    const stato = statoPulito({
      cancel_requested_at: '2026-08-27T18:00:00+02:00',
      ai_status: 'handed_off',
    });
    expect(puoScrivere(stato, EVENTO, NOW)).toEqual({ ok: false, motivo: 'disdetta_chiesta' });
  });
});
