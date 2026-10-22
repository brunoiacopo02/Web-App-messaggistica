import { describe, expect, it } from 'vitest';
import {
  decideGdoRecap, gdoRecapText, gdoSpostamentoText, quandoNoemi, type RecapInput,
} from './gdo-recap';

const call = new Date('2026-10-23T10:00:00+02:00'); // venerdì

describe('testi del recap GDO', () => {
  it('quandoNoemi: call di mattina → pomeriggio del giorno prima', () =>
    expect(quandoNoemi(call)).toBe('giovedì 22 nel pomeriggio'));
  it('quandoNoemi: call dalle 15 → stesso giorno', () =>
    expect(quandoNoemi(new Date('2026-10-23T18:00:00+02:00'))).toBe('venerdì 23, qualche ora prima'));
  it('recap completo: una bolla con data, Noemi, video e FATTO', () => {
    const t = gdoRecapText({ nome: 'Luca Rossi', call, videoLink: 'https://corso.feniceacademy.it/conferenza-bx' });
    expect(t).toContain('Ciao Luca');
    expect(t).toContain('*venerdì 23 alle 10:00*');
    expect(t).toContain('*Ti chiama Noemi, una nostra collega, giovedì 22 nel pomeriggio*');
    expect(t).toContain('se non rispondi la videochiamata non è confermata');
    expect(t).toContain('👉 https://corso.feniceacademy.it/conferenza-bx');
    expect(t).toContain('scrivimi FATTO');
  });
  it('recap senza video: rimanda al video qui sopra, nessun link', () => {
    const t = gdoRecapText({ nome: null, call, videoLink: null });
    expect(t).toContain('Ciao, ti riassumo tutto 👇');
    expect(t).toContain('qui sopra');
    expect(t).not.toContain('https://');
  });
  it('spostamento: data nuova, niente Noemi, niente video', () => {
    const t = gdoSpostamentoText({ nome: 'Ada', call });
    expect(t).toContain('*venerdì 23 alle 10:00*');
    expect(t).not.toMatch(/Noemi|https:/);
  });
});

describe('decideGdoRecap', () => {
  const nowMs = Date.parse('2026-10-22T12:00:00+02:00');
  const base: RecapInput = {
    enabled: true,
    occasione: 'turno-video',
    gdoAgendaAt: '2026-10-22T09:00:00+02:00',
    botOutcome: null,
    appuntamentoAt: new Date(nowMs + 30 * 3600_000).toISOString(),
    recapForAt: null,
    videoSentAt: null,
    lastInboundAtMs: nowMs - 3600_000,
    aiPausedAt: null,
    cancelRequestedAt: null,
    nowMs,
  };
  const con = (o: Partial<RecapInput>): RecapInput => ({ ...base, ...o });

  it('turno-video → completo', () => expect(decideGdoRecap(base)).toBe('completo'));
  it('registrato col video mandato → senza-video', () =>
    expect(decideGdoRecap(con({ occasione: 'registrato', videoSentAt: '2026-10-22T10:00:00Z' }))).toBe('senza-video'));
  it('registrato senza video → null', () =>
    expect(decideGdoRecap(con({ occasione: 'registrato' }))).toBeNull());
  it('spostato con recap già mandato → spostamento', () =>
    expect(decideGdoRecap(con({ occasione: 'spostato', recapForAt: '2026-10-22T08:00:00Z' }))).toBe('spostamento'));
  it('spostato senza recap ma col video → senza-video', () =>
    expect(decideGdoRecap(con({ occasione: 'spostato', videoSentAt: '2026-10-22T10:00:00Z' }))).toBe('senza-video'));
  it('spostato senza recap né video → null', () =>
    expect(decideGdoRecap(con({ occasione: 'spostato' }))).toBeNull());

  const casi: Array<[string, Partial<RecapInput>]> = [
    ['disabilitato', { enabled: false }],
    ['senza agenda GDO', { gdoAgendaAt: null }],
    ['appuntamento già del bot', { botOutcome: 'APPUNTAMENTO' }],
    ['senza appuntamento', { appuntamentoAt: null }],
    ['call fra 59 minuti', { appuntamentoAt: new Date(nowMs + 59 * 60_000).toISOString() }],
    ['call passata', { appuntamentoAt: new Date(nowMs - 3600_000).toISOString() }],
    ['IA in pausa', { aiPausedAt: '2026-10-22T10:00:00Z' }],
    ['annullamento richiesto', { cancelRequestedAt: '2026-10-22T10:00:00Z' }],
    ['lead mai scritto', { lastInboundAtMs: null }],
    ['finestra chiusa (25h)', { lastInboundAtMs: nowMs - 25 * 3600_000 }],
    ['recap già mandato per lo stesso istante (altro fuso)', {
      appuntamentoAt: '2026-10-23T10:00:00+02:00', recapForAt: '2026-10-23T08:00:00Z',
    }],
  ];
  it.each(casi)('null: %s', (_n, o) => expect(decideGdoRecap(con(o))).toBeNull());
});
