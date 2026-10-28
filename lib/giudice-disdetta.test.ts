import { describe, expect, it, vi } from 'vitest';
import {
  applicaGuardie,
  citazioneDelLead,
  costruisciInputGiudice,
  giudicaDisdetta,
  giudiceDisdetteAcceso,
  segnaliDiDubbio,
  ultimoTurnoLead,
  type MessaggioChat,
} from './giudice-disdetta';

const chat: MessaggioChat[] = [
  { direction: 'out', body: 'Ciao! Ti ricordo la videochiamata di domani alle 17', created_at: '2026-10-27T10:00:00Z', is_template: true },
  { direction: 'in', body: 'Ho visto il video', created_at: '2026-10-27T10:05:00Z' },
  { direction: 'out', body: 'Ottimo, cosa ne pensi?', created_at: '2026-10-27T10:06:00Z' },
  { direction: 'in', body: 'Ho fatto le mie valutazioni,', created_at: '2026-10-27T10:10:00Z' },
  { direction: 'in', body: 'non mi interessa più. Annullate la chiamata', created_at: '2026-10-27T10:10:30Z' },
];
const adesso = '2026-10-27T10:11:00Z';

describe('interruttore', () => {
  it('assente = acceso, "0" = spento', () => {
    expect(giudiceDisdetteAcceso({})).toBe(true);
    expect(giudiceDisdetteAcceso({ GIUDICE_DISDETTE_ENABLED: '1' })).toBe(true);
    expect(giudiceDisdetteAcceso({ GIUDICE_DISDETTE_ENABLED: '0' })).toBe(false);
    expect(giudiceDisdetteAcceso({ GIUDICE_DISDETTE_ENABLED: ' 0 ' })).toBe(false);
  });
});

describe('input del giudice', () => {
  it('mette i fatti in testa e la chat fino ad adesso', () => {
    const t = costruisciInputGiudice(
      [...chat, { direction: 'in', body: 'dopo', created_at: '2026-10-27T12:00:00Z' }],
      { adesso, appuntamentoAt: '2026-10-28T16:00:00Z', videoInviatoAt: '2026-10-27T09:00:00Z', videoVistoAt: '2026-10-27T13:00:00Z' },
    );
    expect(t).toContain('Videochiamata fissata dal GDO: mercoledì 28 ottobre alle 17:00 (fra 30 ore)');
    expect(t).toContain('non risulta visto');
    expect(t).toContain('LEAD: non mi interessa più');
    expect(t).toContain('BOT (messaggio automatico)');
    expect(t).not.toContain('dopo');
  });
  it('senza data lo dice', () => {
    expect(costruisciInputGiudice(chat, { adesso, appuntamentoAt: null })).toContain('non nota al bot');
  });
});

describe('guardie', () => {
  it("l'ultimo turno sono i messaggi del lead dopo l'ultimo nostro", () => {
    expect(ultimoTurnoLead(chat, adesso)).toEqual(['Ho fatto le mie valutazioni,', 'non mi interessa più. Annullate la chiamata']);
  });
  it('riconosce i segnali di spostamento', () => {
    expect(segnaliDiDubbio(['non posso unirmi all\'appuntamento delle 15. Annullo tutto'])).toContain('orario');
    expect(segnaliDiDubbio(['Ok ma oggi noemi? Non riesco sai'])).toEqual(expect.arrayContaining(['giorno', 'chiamata_noemi', 'domanda']));
    expect(segnaliDiDubbio(['sono a lavoro'])).toContain('lavoro');
    expect(segnaliDiDubbio(['ci sentiamo più avanti'])).toContain('futuro');
    expect(segnaliDiDubbio(['ho avuto un contrattempo'])).toContain('imprevisto');
    expect(segnaliDiDubbio(['al momento non sono più interessata, non contattarmi più'])).toEqual([]);
    expect(segnaliDiDubbio(['non ricontattatemi'])).toEqual([]);
    expect(segnaliDiDubbio(['ricontattatemi'])).toContain('futuro');
  });
  it('la citazione deve essere del lead', () => {
    expect(citazioneDelLead('non mi interessa più', chat)).toBe(true);
    expect(citazioneDelLead('cosa ne pensi', chat)).toBe(false);
    expect(citazioneDelLead('ok', chat)).toBe(false);
  });
  it('possono solo abbassare a dubbio', () => {
    expect(applicaGuardie({ verdetto: 'disdetta_vera', citazione: 'non mi interessa più' }, chat, adesso)).toEqual({ verdetto: 'disdetta_vera', guardia: [] });
    expect(applicaGuardie({ verdetto: 'disdetta_vera', citazione: 'frase inventata dal modello' }, chat, adesso).verdetto).toBe('dubbio');
    expect(applicaGuardie({ verdetto: 'non_disdetta', citazione: '' }, chat, adesso)).toEqual({ verdetto: 'non_disdetta', guardia: [] });
    const conOrario: MessaggioChat[] = [...chat, { direction: 'in', body: 'domani alle 17 non posso', created_at: '2026-10-27T10:10:40Z' }];
    expect(applicaGuardie({ verdetto: 'disdetta_vera', citazione: 'non mi interessa più' }, conOrario, adesso).verdetto).toBe('dubbio');
  });
});

describe('chiamata al modello', () => {
  const finto = (parsed: unknown, stop = 'end_turn') => ({
    messages: {
      parse: vi.fn().mockResolvedValue({
        stop_reason: stop,
        parsed_output: parsed,
        usage: { input_tokens: 3000, output_tokens: 400, cache_read_input_tokens: 2000, cache_creation_input_tokens: 0 },
      }),
    },
  });

  it('usa opus 5.5 con output strutturato e applica le guardie', async () => {
    const a = finto({ verdetto: 'disdetta_vera', categoria: 'ripensamento', citazione: 'non mi interessa più', motivo: 'rinuncia' });
    const g = await giudicaDisdetta(chat, { adesso, appuntamentoAt: null }, { anthropic: a as never });
    expect(g.verdetto).toBe('disdetta_vera');
    expect(g.token.input).toBe(3000);
    const arg = a.messages.parse.mock.calls[0][0];
    expect(arg.model).toBe('claude-opus-5-5');
    expect(arg.output_config.effort).toBe('high');
  });
  it('rifiuto o JSON mancante = eccezione (il chiamante fa come oggi)', async () => {
    await expect(giudicaDisdetta(chat, { adesso, appuntamentoAt: null }, { anthropic: finto(null, 'refusal') as never })).rejects.toThrow('giudice_rifiuto');
    await expect(giudicaDisdetta(chat, { adesso, appuntamentoAt: null }, { anthropic: finto(null) as never })).rejects.toThrow('giudice_senza_json');
  });
});
