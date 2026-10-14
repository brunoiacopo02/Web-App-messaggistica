import { describe, it, expect, vi } from 'vitest';
import { segnaProfessione } from './professione-chat';

function fakeSupa() {
  const update = vi.fn(() => ({ eq: vi.fn(async () => ({ error: null })) }));
  const insert = vi.fn(async () => ({ error: null }));
  return { from: vi.fn((t: string) => (t === 'conversations' ? { update } : { insert })), update, insert };
}

describe('segnaProfessione', () => {
  it('scrive lo slug quando c\'e\' la frase e il corso', async () => {
    const s = fakeSupa();
    const r = await segnaProfessione(s as never, 7, 'Ciao, sono interessato alla professione di Copywriter e vorrei ricevere la scheda del corso');
    expect(r).toBe('copywriter');
    expect(s.update).toHaveBeenCalledWith({ professione: 'copywriter' });
  });
  it('non tocca niente senza la frase', async () => {
    const s = fakeSupa();
    expect(await segnaProfessione(s as never, 7, 'mi interessa il copywriter')).toBeNull();
    expect(s.update).not.toHaveBeenCalled();
  });
  it('frase senza corso: niente update', async () => {
    const s = fakeSupa();
    expect(await segnaProfessione(s as never, 7, 'la scheda del corso?')).toBeNull();
    expect(s.update).not.toHaveBeenCalled();
  });
});
