import { describe, it, expect } from 'vitest';
import { numeroSenzaWhatsapp, convIdonea, regolaSubitoPerFunnel } from './senza-whatsapp';

const out = (twilio_status: string | null, twilio_error_code: number | null = null) => ({ direction: 'out', twilio_status, twilio_error_code });
const inb = { direction: 'in', twilio_status: null, twilio_error_code: null };

describe('numeroSenzaWhatsapp', () => {
  it('apertura undelivered 63024, niente altro → vero (i 6 BF del 10/11)', () => {
    expect(numeroSenzaWhatsapp([out('undelivered', 63024)])).toBe(true);
  });

  it('anche gli altri errori definitivi (63003, 21211, 21614)', () => {
    expect(numeroSenzaWhatsapp([out('failed', 21211)])).toBe(true);
    expect(numeroSenzaWhatsapp([out('failed', 21614)])).toBe(true);
    expect(numeroSenzaWhatsapp([out('undelivered', 63003)])).toBe(true);
  });

  it('errore non definitivo (63016 finestra chiusa, 63049 Meta) → falso', () => {
    expect(numeroSenzaWhatsapp([out('undelivered', 63016)])).toBe(false);
    expect(numeroSenzaWhatsapp([out('undelivered', 63049)])).toBe(false);
    expect(numeroSenzaWhatsapp([out('undelivered', null)])).toBe(false);
  });

  it('un messaggio consegnato o ancora in viaggio blocca', () => {
    expect(numeroSenzaWhatsapp([out('undelivered', 63024), out('delivered')])).toBe(false);
    expect(numeroSenzaWhatsapp([out('undelivered', 63024), out('sent')])).toBe(false);
    expect(numeroSenzaWhatsapp([out('undelivered', 63024), out('queued')])).toBe(false);
  });

  it('il lead ha scritto → falso', () => {
    expect(numeroSenzaWhatsapp([inb, out('undelivered', 63024)])).toBe(false);
  });

  it('nessun messaggio in uscita → falso', () => {
    expect(numeroSenzaWhatsapp([])).toBe(false);
  });
});

describe('convIdonea', () => {
  const base = { crm_lead_id: 'x', crm_funnel: 'BLACK FRIDAY', ai_status: 'active', bot_outcome: null, ai_paused_at: null };

  it('BF attiva senza esito → idonea', () => {
    expect(convIdonea(base)).toBe(true);
    expect(convIdonea({ ...base, ai_status: 'replying' })).toBe(true);
  });

  it('esito gia dato, chiusa, passata a persona, in pausa, senza lead → no', () => {
    expect(convIdonea({ ...base, bot_outcome: 'NON_RISPOSTO' })).toBe(false);
    expect(convIdonea({ ...base, ai_status: 'closed' })).toBe(false);
    expect(convIdonea({ ...base, ai_status: 'handed_off' })).toBe(false);
    expect(convIdonea({ ...base, ai_paused_at: '2026-11-10T10:00:00Z' })).toBe(false);
    expect(convIdonea({ ...base, crm_lead_id: null })).toBe(false);
  });

  it('per ora solo BLACK FRIDAY', () => {
    expect(regolaSubitoPerFunnel('black friday ')).toBe(true);
    expect(convIdonea({ ...base, crm_funnel: 'CORSO 10 ORE' })).toBe(false);
    expect(convIdonea({ ...base, crm_funnel: null })).toBe(false);
  });
});
