import { describe, it, expect, vi, beforeEach } from 'vitest';

const sendTemplate = vi.fn();
const getTemplateBody = vi.fn();
vi.mock('./twilio', () => ({
  sendTemplate: (...a: unknown[]) => sendTemplate(...a),
  getTemplateBody: (...a: unknown[]) => getTemplateBody(...a),
}));
vi.mock('./mittente', () => ({ mittentePerNuovaConversazione: () => null }));

import { compilaCorpoTemplate, sendTemplateAndLog } from './messaging';

const T24 = 'Ciao {{1}}, ti ricordo la videocall di {{2}}. Hai già visto il video?';

function fakeSupabase() {
  const inserts: Array<{ table: string; row: Record<string, unknown> }> = [];
  const supa = {
    from(table: string) {
      return {
        insert(row: Record<string, unknown>) {
          inserts.push({ table, row });
          return Promise.resolve({ error: null });
        },
        update() {
          return { eq: () => Promise.resolve({ error: null }) };
        },
      };
    },
  };
  return { supa: supa as never, inserts };
}

describe('compilaCorpoTemplate', () => {
  it('sostituisce i segnaposto con le variabili inviate', () => {
    expect(compilaCorpoTemplate(T24, { '1': 'Mario', '2': 'domani alle 15:00' })).toBe(
      'Ciao Mario, ti ricordo la videocall di domani alle 15:00. Hai già visto il video?',
    );
  });

  it('accetta gli spazi dentro le graffe e le chiavi numeriche', () => {
    expect(compilaCorpoTemplate('Ciao {{ 1 }}!', { 1: 'Anna' } as never)).toBe('Ciao Anna!');
  });

  it('variabile mancante: niente segnaposto residuo, via anche lo spazio', () => {
    const out = compilaCorpoTemplate(T24, { '2': 'oggi alle 18:00' });
    expect(out).toBe('Ciao, ti ricordo la videocall di oggi alle 18:00. Hai già visto il video?');
    expect(out).not.toMatch(/\{\{/);
    expect(compilaCorpoTemplate(T24, { '1': '', '2': 'x' })).not.toMatch(/\{\{/);
  });

  it('senza segnaposto il testo resta identico', () => {
    expect(compilaCorpoTemplate('Testo  fisso , con spazi.', {})).toBe('Testo  fisso , con spazi.');
  });
});

describe('sendTemplateAndLog', () => {
  beforeEach(() => {
    sendTemplate.mockReset();
    getTemplateBody.mockReset();
  });

  it('senza bodyOverride salva il corpo compilato e le variabili', async () => {
    getTemplateBody.mockResolvedValue(T24);
    sendTemplate.mockResolvedValue({ sid: 'SM1', status: 'queued' });
    const { supa, inserts } = fakeSupabase();
    const vars = { '1': 'Mario', '2': 'domani alle 15:00' };

    const res = await sendTemplateAndLog(supa, 7, '+39333', 'HX1', 'Promemoria T-24h', '+39352', vars);

    expect(res).toEqual({ ok: true, sid: 'SM1' });
    // A Twilio partono le stesse variabili di prima.
    expect(sendTemplate).toHaveBeenCalledWith({ to: '+39333', contentSid: 'HX1', variables: vars, from: '+39352' });
    const msg = inserts.find((i) => i.table === 'messages')!.row;
    expect(msg.body).toBe('Ciao Mario, ti ricordo la videocall di domani alle 15:00. Hai già visto il video?');
    expect(msg.body).not.toMatch(/\{\{/);
    expect(msg.template_vars).toEqual(vars);
  });

  it('con bodyOverride salva quello, e le variabili comunque', async () => {
    sendTemplate.mockResolvedValue({ sid: 'SM2', status: 'queued' });
    const { supa, inserts } = fakeSupabase();
    await sendTemplateAndLog(supa, 7, '+39333', 'HX1', 'x', undefined, { '1': 'Mario' }, 'Testo vero');
    expect(getTemplateBody).not.toHaveBeenCalled();
    const msg = inserts.find((i) => i.table === 'messages')!.row;
    expect(msg.body).toBe('Testo vero');
    expect(msg.template_vars).toEqual({ '1': 'Mario' });
  });

  it('invio fallito: anche la riga failed ha il corpo compilato', async () => {
    getTemplateBody.mockResolvedValue(T24);
    sendTemplate.mockRejectedValue(Object.assign(new Error('boom'), { code: 63016 }));
    const { supa, inserts } = fakeSupabase();
    const res = await sendTemplateAndLog(supa, 7, '+39333', 'HX1', 'NR', undefined, { '1': 'Mario', '2': 'oggi' });
    expect(res.ok).toBe(false);
    const msg = inserts.find((i) => i.table === 'messages')!.row;
    expect(msg.twilio_status).toBe('failed');
    expect(msg.body).toBe('Ciao Mario, ti ricordo la videocall di oggi. Hai già visto il video?');
    expect(msg.template_vars).toEqual({ '1': 'Mario', '2': 'oggi' });
  });

  it('corpo del template illeggibile: etichetta di ripiego, template_vars null senza variabili', async () => {
    getTemplateBody.mockResolvedValue(null);
    sendTemplate.mockResolvedValue({ sid: 'SM3', status: 'queued' });
    const { supa, inserts } = fakeSupabase();
    await sendTemplateAndLog(supa, 7, '+39333', 'HX9', 'Video');
    const msg = inserts.find((i) => i.table === 'messages')!.row;
    expect(msg.body).toBe('[template] Video');
    expect(msg.template_vars).toBeNull();
  });
});
