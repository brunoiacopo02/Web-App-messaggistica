import { describe, it, expect, vi, beforeEach } from 'vitest';

const create = vi.fn();
vi.mock('./mario', () => ({
  MARIO_MODEL: 'claude-sonnet-5',
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
    expect(r).toEqual({ classe: 'domanda', passToHuman: false, visibleReply: 'È gratuita.', lancioTag: null });
    const params = create.mock.calls[0][0];
    expect(params.model).toBe('claude-sonnet-5');
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

describe('generateLancioReply — i tag della scelta (B4)', () => {
  const opts = {
    fase: 'post_pitch', nome: 'Anna', eventoAt: '2026-10-05T21:00:00+02:00',
    modo: 'notte' as const, risposteRaccolte: 2, bloccoSlot: 'ORE PRENOTABILI (prova)',
  };

  it('[LANCIO:PRENOTA|iso] → lancioTag con l at, tag tolto dal testo, classe domanda', async () => {
    create.mockResolvedValueOnce({ content: [{ type: 'text', text: 'Perfetto, alle 9! [LANCIO:PRENOTA|2026-10-06T09:00:00+02:00]' }] });
    const r = await generateLancioReply([{ role: 'user', content: 'alle 9' }], opts);
    expect(r.lancioTag).toEqual({ tag: 'PRENOTA', at: '2026-10-06T09:00:00+02:00' });
    expect(r.visibleReply).toBe('Perfetto, alle 9!');
    expect(r.classe).toBe('domanda');
  });

  it('[LANCIO:CHIAMA_ORA] e [lancio:slots] (anche minuscolo, e sparisce dal testo)', async () => {
    create.mockResolvedValueOnce({ content: [{ type: 'text', text: 'Ok [LANCIO:CHIAMA_ORA]' }] });
    expect((await generateLancioReply([{ role: 'user', content: 'adesso' }], opts)).lancioTag).toEqual({ tag: 'CHIAMA_ORA' });
    create.mockResolvedValueOnce({ content: [{ type: 'text', text: 'Vediamo le ore [lancio:slots]' }] });
    const r = await generateLancioReply([{ role: 'user', content: 'domani' }], opts);
    expect(r.lancioTag).toEqual({ tag: 'SLOTS' });
    expect(r.visibleReply).toBe('Vediamo le ore');
  });

  it('[LANCIO:NO] vale sia come classe no (B1) sia come tag NO (B4)', async () => {
    create.mockResolvedValueOnce({ content: [{ type: 'text', text: 'Capisco. [LANCIO:NO]' }] });
    const r = await generateLancioReply([{ role: 'user', content: 'no grazie' }], opts);
    expect(r.classe).toBe('no');
    expect(r.lancioTag).toEqual({ tag: 'NO' });
    expect(r.visibleReply).toBe('Capisco.');
  });

  it('il system della fase post_pitch porta il blocco slot e non i tag di attesa', async () => {
    create.mockResolvedValueOnce({ content: [{ type: 'text', text: 'ok [LANCIO:DOMANDA]' }] });
    await generateLancioReply([{ role: 'user', content: 'ciao' }], opts);
    const system = create.mock.calls[0][0].system as string;
    expect(system).toContain('ORE PRENOTABILI (prova)');
    expect(system).not.toContain('[LANCIO:SI]');
    expect(system).toMatch(/Adesso in Italia è/);
  });
});
