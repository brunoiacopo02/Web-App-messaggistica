import { describe, it, expect, vi, beforeEach } from 'vitest';

const messagesCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: messagesCreate };
  },
}));

import { parseMarioReply, generateMarioReply } from './mario';

beforeEach(() => {
  messagesCreate.mockReset();
  process.env.ANTHROPIC_API_KEY = 'sk-test';
});

describe('parseMarioReply', () => {
  it('rimuove i tag e ritorna i flag', () => {
    const r = parseMarioReply('Perfetto! [APPUNTAMENTO_FISSATO] a presto');
    expect(r.appointmentFixed).toBe(true);
    expect(r.passToHuman).toBe(false);
    expect(r.visibleReply).toBe('Perfetto!  a presto');
  });

  it('rileva il passaggio umano', () => {
    const r = parseMarioReply('Ti passo un collega [PASSAGGIO_UMANO]');
    expect(r.passToHuman).toBe(true);
    expect(r.visibleReply).toBe('Ti passo un collega');
  });

  it('testo normale: nessun flag', () => {
    const r = parseMarioReply('Ciao, come stai?');
    expect(r).toEqual({ visibleReply: 'Ciao, come stai?', appointmentFixed: false, passToHuman: false, videoWatched: false });
  });

  it('ripara il link video spezzato prima di consegnare il testo visibile', () => {
    const r = parseMarioReply('Eccolo https://corso.feniceacademy.it/conferenza-ax msbn9r50 [APPUNTAMENTO_FISSATO]');
    expect(r.visibleReply).toContain('https://corso.feniceacademy.it/conferenza-axmsbn9r50');
    expect(r.visibleReply).not.toContain('conferenza-ax msbn9r50');
    expect(r.appointmentFixed).toBe(true);
  });
});

describe('generateMarioReply', () => {
  it('chiama Claude con system prompt + history e ritorna il testo pulito', async () => {
    messagesCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: 'Ciao! Sono Mario 😊' }] });
    const out = await generateMarioReply([{ role: 'user', content: 'ciao' }]);
    expect(out.visibleReply).toBe('Ciao! Sono Mario 😊');
    const arg = messagesCreate.mock.calls[0][0];
    expect(arg.model).toBe('claude-sonnet-4-6');
    expect(arg.messages).toEqual([{ role: 'user', content: 'ciao' }]);
    expect(typeof arg.system).toBe('string');
  });

  it('history vuota: usa il seed di apertura', async () => {
    messagesCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: 'Ciao!' }] });
    await generateMarioReply([]);
    expect(messagesCreate.mock.calls[0][0].messages).toEqual([
      { role: 'user', content: 'Inizia la conversazione presentandoti.' },
    ]);
  });
});

describe('tag [VIDEO_VISTO]', () => {
  it('lo rileva e lo rimuove dal testo visibile', () => {
    const r = parseMarioReply('perfetto, allora ci vediamo in call [VIDEO_VISTO]');
    expect(r.videoWatched).toBe(true);
    expect(r.visibleReply).toBe('perfetto, allora ci vediamo in call');
  });

  it('senza tag resta false e non tocca il testo', () => {
    const r = parseMarioReply('ciao come va');
    expect(r.videoWatched).toBe(false);
    expect(r.visibleReply).toBe('ciao come va');
  });

  it('non declassa né confonde gli altri tag', () => {
    const r = parseMarioReply('ok [VIDEO_VISTO] [PASSAGGIO_UMANO]');
    expect(r.videoWatched).toBe(true);
    expect(r.passToHuman).toBe(true);
    expect(r.visibleReply).toBe('ok');
  });
});
