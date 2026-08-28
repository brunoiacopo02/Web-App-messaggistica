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

/** Lo stato "pulito": nessuna delle sette condizioni scatta, l'invio deve passare. */
function statoPulito(overrides: Partial<StatoConversazione> = {}): StatoConversazione {
  return {
    ai_owner: 'mario',
    ai_status: 'active',
    ai_paused_at: null,
    bot_outcome: null,
    bot_scheduled_at: '2026-08-29T15:00:00+02:00',
    gdo_appuntamento_at: null,
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

  it('2) ai_paused_at valorizzato → bot_fermato', () => {
    // Il pulsante "Ferma il bot" del pannello: la chat è di una persona, e scrivere
    // qui vorrebbe dire parlarle sopra e riaprirle la conversazione sotto le mani.
    const stato = statoPulito({ ai_paused_at: '2026-08-28T09:30:00+02:00' });
    expect(puoScrivere(stato, EVENTO, NOW)).toEqual({ ok: false, motivo: 'bot_fermato' });
  });

  it('3) cancel_requested_at valorizzato → disdetta_chiesta', () => {
    const stato = statoPulito({ cancel_requested_at: '2026-08-27T18:00:00+02:00' });
    expect(puoScrivere(stato, EVENTO, NOW)).toEqual({ ok: false, motivo: 'disdetta_chiesta' });
  });

  it('4) ai_status handed_off → passato_a_persona', () => {
    const stato = statoPulito({ ai_status: 'handed_off' });
    expect(puoScrivere(stato, EVENTO, NOW)).toEqual({ ok: false, motivo: 'passato_a_persona' });
  });

  it('5) ultimoInboundAt posteriore all\'evento → gia_risposto', () => {
    const stato = statoPulito({ ultimoInboundAt: '2026-08-28T11:00:00+02:00' });
    expect(puoScrivere(stato, EVENTO, NOW)).toEqual({ ok: false, motivo: 'gia_risposto' });
  });

  it('6) nessuno dei due appuntamenti → appuntamento_non_valido', () => {
    const stato = statoPulito({ bot_scheduled_at: null, gdo_appuntamento_at: null });
    expect(puoScrivere(stato, EVENTO, NOW)).toEqual({ ok: false, motivo: 'appuntamento_non_valido' });
  });

  it('6) solo bot_scheduled_at, nel futuro: passa', () => {
    const stato = statoPulito({ bot_scheduled_at: '2026-08-29T15:00:00+02:00', gdo_appuntamento_at: null });
    expect(puoScrivere(stato, EVENTO, NOW)).toEqual({ ok: true });
  });

  it('6) solo gdo_appuntamento_at, nel futuro: passa — è il lead postino', () => {
    // Call fissata da un GDO: il bot ha solo consegnato l'agenda, quindi
    // `bot_scheduled_at` è vuoto. Sono metà dei lead che questa funzione deve coprire.
    const stato = statoPulito({ bot_scheduled_at: null, gdo_appuntamento_at: '2026-08-29T15:00:00+02:00' });
    expect(puoScrivere(stato, EVENTO, NOW)).toEqual({ ok: true });
  });

  it('6) entrambi valorizzati: vale il più recente, non il primo che si trova', () => {
    // Il bot gliene aveva fissato uno, poi un GDO l'ha richiamato e ne ha messo un
    // altro: quello vero è il secondo, e il vecchio ormai passato non deve bocciarlo.
    const stato = statoPulito({
      bot_scheduled_at: '2026-08-27T10:00:00+02:00', // passato
      gdo_appuntamento_at: '2026-08-29T15:00:00+02:00', // futuro
    });
    expect(puoScrivere(stato, EVENTO, NOW)).toEqual({ ok: true });
  });

  it('6) entrambi nel passato → appuntamento_non_valido', () => {
    const stato = statoPulito({
      bot_scheduled_at: '2026-08-26T10:00:00+02:00',
      gdo_appuntamento_at: '2026-08-27T10:00:00+02:00',
    });
    expect(puoScrivere(stato, EVENTO, NOW)).toEqual({ ok: false, motivo: 'appuntamento_non_valido' });
  });

  it('6) data illeggibile: conta come assente, non si scrive a caso', () => {
    const stato = statoPulito({ bot_scheduled_at: 'domani mattina', gdo_appuntamento_at: null });
    expect(puoScrivere(stato, EVENTO, NOW)).toEqual({ ok: false, motivo: 'appuntamento_non_valido' });
  });

  it('6) bot_scheduled_at nel passato rispetto a now → appuntamento_non_valido', () => {
    const stato = statoPulito({ bot_scheduled_at: '2026-08-27T10:00:00+02:00' });
    expect(puoScrivere(stato, EVENTO, NOW)).toEqual({ ok: false, motivo: 'appuntamento_non_valido' });
  });

  it('7) giaInviatoTentativo → gia_inviato', () => {
    const stato = statoPulito({ giaInviatoTentativo: true });
    expect(puoScrivere(stato, EVENTO, NOW)).toEqual({ ok: false, motivo: 'gia_inviato' });
  });

  it('ordine di valutazione: non_nostro batte le altre condizioni contemporaneamente vere', () => {
    const stato = statoPulito({
      ai_owner: 'altro',
      ai_paused_at: '2026-08-28T09:30:00+02:00',
      cancel_requested_at: '2026-08-27T18:00:00+02:00',
      ai_status: 'handed_off',
    });
    expect(puoScrivere(stato, EVENTO, NOW)).toEqual({ ok: false, motivo: 'non_nostro' });
  });

  it('ordine di valutazione: bot_fermato batte disdetta_chiesta quando entrambe vere', () => {
    const stato = statoPulito({
      ai_paused_at: '2026-08-28T09:30:00+02:00',
      cancel_requested_at: '2026-08-27T18:00:00+02:00',
    });
    expect(puoScrivere(stato, EVENTO, NOW)).toEqual({ ok: false, motivo: 'bot_fermato' });
  });

  it('ordine di valutazione: disdetta_chiesta batte handed_off quando entrambe vere', () => {
    const stato = statoPulito({
      cancel_requested_at: '2026-08-27T18:00:00+02:00',
      ai_status: 'handed_off',
    });
    expect(puoScrivere(stato, EVENTO, NOW)).toEqual({ ok: false, motivo: 'disdetta_chiesta' });
  });
});
