import { describe, it, expect, vi, beforeEach } from 'vitest';

const create = vi.fn();
vi.mock('./mario', () => ({
  MARIO_MODEL: 'claude-sonnet-4-6',
  MEDIA_SENZA_TESTO: '[il lead ha inviato un contenuto senza testo]',
  getAnthropicClient: () => ({ messages: { create } }),
}));

import { generateLancioReply } from './lancio-reply';

beforeEach(() => { create.mockReset(); });

describe('generateLancioReply', () => {
  it('manda il system del lancio (non quello di Mario) e parsa i tag', async () => {
    create.mockResolvedValueOnce({ content: [{ type: 'text', text: 'È gratuita. [LANCIO:DOMANDA]' }] });
    const r = await generateLancioReply(
      [{ role: 'assistant', content: 'benvenuto' }, { role: 'user', content: 'costa?' }],
      { fase: 'attesa', nome: 'Anna', eventoAt: null, now: new Date('2026-09-20T10:00:00Z') },
    );
    expect(r).toEqual({ classe: 'domanda', passToHuman: false, visibleReply: 'È gratuita.' });
    const params = create.mock.calls[0][0];
    expect(params.model).toBe('claude-sonnet-4-6');
    expect(params.system).toMatch(/assistente virtuale di Fenice Academy/);
    expect(params.system).not.toMatch(/jotform/i);
    expect(params.system).toMatch(/Adesso in Italia è/);
    expect(params.messages).toEqual([
      { role: 'assistant', content: 'benvenuto' }, { role: 'user', content: 'costa?' },
    ]);
  });

  it('un turno del lead senza testo diventa il segnaposto, mai una richiesta vuota', async () => {
    create.mockResolvedValueOnce({ content: [{ type: 'text', text: 'Ciao! [LANCIO:DOMANDA]' }] });
    await generateLancioReply([{ role: 'user', content: '' }], { fase: 'attesa', nome: null, eventoAt: null });
    expect(create.mock.calls[0][0].messages).toEqual([{ role: 'user', content: '[il lead ha inviato un contenuto senza testo]' }]);
  });

  it('risposta senza blocco testo → domanda con testo vuoto (chi chiama decide di tacere)', async () => {
    create.mockResolvedValueOnce({ content: [] });
    const r = await generateLancioReply([{ role: 'user', content: 'ok?' }], { fase: 'attesa', nome: null, eventoAt: null });
    expect(r.visibleReply).toBe('');
  });
});
