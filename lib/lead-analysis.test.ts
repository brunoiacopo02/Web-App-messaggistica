import { describe, it, expect, vi, beforeEach } from 'vitest';

const messagesCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: messagesCreate };
  },
}));

import { normalizeCategory, extractLeadInsight, aggregateInsights, ANALYSIS_MODEL } from './lead-analysis';

beforeEach(() => {
  messagesCreate.mockReset();
  process.env.ANTHROPIC_API_KEY = 'sk-test';
});

describe('normalizeCategory', () => {
  it('riconosce le categorie valide', () => {
    expect(normalizeCategory('prezzo')).toBe('prezzo');
    expect(normalizeCategory('GARANZIA_LAVORO')).toBe('garanzia_lavoro');
  });
  it('valori fuori set → altro', () => {
    expect(normalizeCategory('boh qualcosa')).toBe('altro');
    expect(normalizeCategory('')).toBe('altro');
  });
});

describe('extractLeadInsight', () => {
  it('parsa il JSON di Claude e normalizza la categoria', async () => {
    messagesCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: '{"dropoffStage":"dopo il prezzo","objectionCategory":"prezzo","objectionNote":"costa troppo"}' }],
    });
    const out = await extractLeadInsight([{ role: 'user', content: 'quanto costa?' }]);
    expect(out).toEqual({ dropoffStage: 'dopo il prezzo', objectionCategory: 'prezzo', objectionNote: 'costa troppo' });
    expect(messagesCreate.mock.calls[0][0].model).toBe(ANALYSIS_MODEL);
  });
  it('categoria sconosciuta → altro', async () => {
    messagesCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: '{"dropoffStage":"x","objectionCategory":"strana","objectionNote":"y"}' }],
    });
    const out = await extractLeadInsight([{ role: 'user', content: 'ciao' }]);
    expect(out.objectionCategory).toBe('altro');
  });
});

describe('aggregateInsights', () => {
  it('conta obiezioni e stadi, e include la narrativa di Claude', async () => {
    messagesCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: 'Il prezzo è il blocco principale. Suggerimento: anticipare il valore.' }] });
    const out = await aggregateInsights({
      insights: [
        { dropoffStage: 'dopo il prezzo', objectionCategory: 'prezzo', objectionNote: 'a' },
        { dropoffStage: 'dopo il prezzo', objectionCategory: 'prezzo', objectionNote: 'b' },
        { dropoffStage: 'apertura', objectionCategory: 'sfiducia', objectionNote: 'c' },
      ],
      maiRisposto: 10,
      respondedNotTaken: 3,
    });
    expect(out.topObjections[0]).toEqual({ category: 'prezzo', count: 2 });
    expect(out.dropoffStages.find(s => s.stage === 'dopo il prezzo')?.count).toBe(2);
    expect(out.maiRisposto).toBe(10);
    expect(out.narrative).toContain('prezzo');
  });
  it('senza insight non chiama Claude e dà narrativa di fallback', async () => {
    const out = await aggregateInsights({ insights: [], maiRisposto: 5, respondedNotTaken: 0 });
    expect(messagesCreate).not.toHaveBeenCalled();
    expect(out.topObjections).toEqual([]);
    expect(out.narrative).toMatch(/dati insufficienti/i);
  });
});
