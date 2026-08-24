import { describe, it, expect, vi, beforeEach } from 'vitest';

const messagesCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: messagesCreate };
  },
}));

import { normalizeCategory, extractLeadInsight, aggregateInsights, ANALYSIS_MODEL, normalizeStage, DROPOFF_STAGES } from './lead-analysis';

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

describe('normalizeStage', () => {
  it('riconosce gli stadi del funnel', () => {
    expect(normalizeStage('prezzo')).toBe('prezzo');
    expect(normalizeStage('PROPOSTA_CALL')).toBe('proposta_call');
  });
  it('fuori set → non_chiaro, cosi l’aggregato non si riempie di sinonimi', () => {
    // Il vecchio campo era testo libero: 24 estrazioni riuscite avevano prodotto 18
    // stadi diversi ("dopo la proposta di videocall", "dopo la proposta della call"...),
    // quindi il conteggio per stadio non contava niente.
    expect(normalizeStage('dopo la proposta di fissare la videocall')).toBe('non_chiaro');
    expect(normalizeStage('')).toBe('non_chiaro');
  });
  it('gli stadi sono un insieme chiuso e ordinato come il funnel', () => {
    expect(DROPOFF_STAGES).toContain('prezzo');
    expect(DROPOFF_STAGES).toContain('proposta_call');
    expect(DROPOFF_STAGES.indexOf('prezzo')).toBeLessThan(DROPOFF_STAGES.indexOf('proposta_call'));
  });
});

describe('extractLeadInsight', () => {
  it('parsa il JSON di Claude e normalizza categoria e stadio', async () => {
    messagesCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: '{"dropoffStage":"prezzo","objectionCategory":"prezzo","objectionNote":"costa troppo"}' }],
    });
    const out = await extractLeadInsight([{ role: 'user', content: 'quanto costa?' }]);
    expect(out).toEqual({ ok: true, insight: { dropoffStage: 'prezzo', objectionCategory: 'prezzo', objectionNote: 'costa troppo' } });
    expect(messagesCreate.mock.calls[0][0].model).toBe(ANALYSIS_MODEL);
  });

  it('categoria sconosciuta → altro', async () => {
    messagesCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: '{"dropoffStage":"prezzo","objectionCategory":"strana","objectionNote":"y"}' }],
    });
    const out = await extractLeadInsight([{ role: 'user', content: 'ciao' }]);
    expect(out.ok && out.insight.objectionCategory).toBe('altro');
  });

  // 741 estrazioni su 765 in produzione erano JSON non parsabili, scritte a database
  // come se fossero analisi ("non chiaro" + "altro" + nota vuota) e mai piu' riprovate
  // perche' ai_insight_at risultava valorizzato.
  it('JSON illeggibile → fallimento dichiarato, NON un insight finto', async () => {
    messagesCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: 'mi dispiace, non posso' }] });
    const out = await extractLeadInsight([{ role: 'user', content: 'ciao' }]);
    expect(out.ok).toBe(false);
  });

  it('risposta vuota → fallimento', async () => {
    messagesCreate.mockResolvedValueOnce({ content: [] });
    expect((await extractLeadInsight([{ role: 'user', content: 'ciao' }])).ok).toBe(false);
  });

  it('JSON troncato a meta → fallimento, non un insight parziale', async () => {
    messagesCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: '{"dropoffStage":"prezzo","objectionNote":"dice che ' }] });
    expect((await extractLeadInsight([{ role: 'user', content: 'ciao' }])).ok).toBe(false);
  });

  it('recupera il JSON dentro i fence markdown: e la forma piu comune di risposta', async () => {
    messagesCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: '```json\n{"dropoffStage":"proposta_call","objectionCategory":"ci_penso","objectionNote":"ci penso"}\n```' }],
    });
    const out = await extractLeadInsight([{ role: 'user', content: 'ciao' }]);
    expect(out.ok && out.insight.dropoffStage).toBe('proposta_call');
  });

  it('recupera il JSON preceduto da un preambolo', async () => {
    messagesCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'Ecco l’analisi:\n{"dropoffStage":"noemi_video","objectionCategory":"tempo","objectionNote":"non ha tempo"}' }],
    });
    const out = await extractLeadInsight([{ role: 'user', content: 'ciao' }]);
    expect(out.ok && out.insight.dropoffStage).toBe('noemi_video');
  });

  it('ha abbastanza spazio per rispondere senza troncarsi', async () => {
    messagesCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: '{"dropoffStage":"prezzo","objectionCategory":"prezzo","objectionNote":"x"}' }],
    });
    await extractLeadInsight([{ role: 'user', content: 'ciao' }]);
    expect(messagesCreate.mock.calls[0][0].max_tokens).toBeGreaterThanOrEqual(1000);
  });
});

describe('aggregateInsights', () => {
  it('conta obiezioni e stadi, e include la narrativa di Claude', async () => {
    messagesCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: 'Il prezzo è il blocco principale. Suggerimento: anticipare il valore.' }] });
    const out = await aggregateInsights({
      insights: [
        { dropoffStage: 'prezzo', objectionCategory: 'prezzo', objectionNote: 'a' },
        { dropoffStage: 'prezzo', objectionCategory: 'prezzo', objectionNote: 'b' },
        { dropoffStage: 'apertura', objectionCategory: 'sfiducia', objectionNote: 'c' },
      ],
      maiRisposto: 10,
      respondedNotTaken: 3,
    });
    expect(out.topObjections[0]).toEqual({ category: 'prezzo', count: 2 });
    expect(out.dropoffStages.find(s => s.stage === 'prezzo')?.count).toBe(2);
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
