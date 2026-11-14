import { describe, expect, it, vi } from 'vitest';
import {
  applicaGuardie,
  citazioneDelLead,
  costruisciInputGiudice,
  giudicaDisdetta,
  giudiceDisdetteAcceso,
  proponeAltroGiorno,
  SYSTEM_GIUDICE,
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
  it("salta la risposta del bot gia' partita: il turno resta quello del lead", () => {
    const conRisposta: MessaggioChat[] = [
      ...chat,
      { direction: 'out', body: 'Va bene, nessun problema', created_at: '2026-10-27T10:10:50Z' },
    ];
    expect(ultimoTurnoLead(conRisposta, adesso)).toEqual(['Ho fatto le mie valutazioni,', 'non mi interessa più. Annullate la chiamata']);
    const spostamento: MessaggioChat[] = [
      ...chat.slice(0, 3),
      { direction: 'in', body: 'oggi non riesco, possiamo fare domani? altrimenti annullate', created_at: '2026-10-27T10:10:00Z' },
      { direction: 'out', body: 'Ok, lo segnalo', created_at: '2026-10-27T10:10:20Z' },
    ];
    expect(applicaGuardie({ verdetto: 'disdetta_vera', citazione: 'annullate' }, spostamento, adesso).guardia).toContain('segnale_altro_giorno');
  });
  it("l'unico segnale rimasto: il lead propone lui un altro giorno o un'altra ora", () => {
    for (const si of [
      'non riesco a partecipare stasera, possiamo fare domani?',
      'Buongiorno, vorrei rimandare la chiamata a venerdì stesso orario.',
      'si può spostare a lunedì mattina?',
      'facciamo giovedì alle 18',
      'ho bisogno di posticipare, possiamo fare direttamente nella settimana del 23/11?',
      'riesco solo dopo le 18',
    ]) expect(proponeAltroGiorno([si]), si).toBe(true);
  });
  it("non scatta piu' sui segnali larghi di prima (75 salvati, 0 presenti)", () => {
    for (const no of [
      "non posso unirmi all'appuntamento delle 15. Annullo tutto",
      'oggi non posso, annullo',
      'non posso fare la call domani, annullate',
      'posso annullare la call di domani?',
      'Vorrei annullare la call di oggi pomeriggio alle 17.00',
      'annullate la videochiamata di lunedì alle 20',
      'sono a lavoro',
      'ci sentiamo più avanti',
      'per ora rimando il tutto',
      'ho avuto un contrattempo',
      'vi ricontatto io',
      'Dobbiamo annullare la video chiamata. Ho avuto un imprevisto',
      'Mi scuso ma mi ritiro. Ho un lutto in famiglia',
      'al momento non sono più interessata, non contattarmi più',
    ]) expect(proponeAltroGiorno([no]), no).toBe(false);
  });
  it('la citazione deve essere del lead', () => {
    expect(citazioneDelLead('non mi interessa più', chat)).toBe(true);
    expect(citazioneDelLead('cosa ne pensi', chat)).toBe(false);
    expect(citazioneDelLead('ok', chat)).toBe(false);
  });
  it('citazione inventata o proposta di un altro giorno: disdetta_vera scende a dubbio; il resto non si tocca', () => {
    expect(applicaGuardie({ verdetto: 'disdetta_vera', citazione: 'non mi interessa più' }, chat, adesso)).toEqual({ verdetto: 'disdetta_vera', guardia: [] });
    expect(applicaGuardie({ verdetto: 'disdetta_vera', citazione: 'frase inventata dal modello' }, chat, adesso)).toEqual({ verdetto: 'dubbio', guardia: ['citazione_non_trovata'] });
    expect(applicaGuardie({ verdetto: 'non_disdetta', citazione: '' }, chat, adesso)).toEqual({ verdetto: 'non_disdetta', guardia: [] });
    const conProposta: MessaggioChat[] = [...chat, { direction: 'in', body: 'possiamo fare venerdì alle 17?', created_at: '2026-10-27T10:10:40Z' }];
    expect(applicaGuardie({ verdetto: 'disdetta_vera', citazione: 'non mi interessa più' }, conProposta, adesso).verdetto).toBe('dubbio');
  });
  it("12/11/2026: nominare il giorno o l'ora della call da annullare, il lavoro o un lutto NON salva piu'", () => {
    const conOrario: MessaggioChat[] = [...chat, { direction: 'in', body: 'domani alle 17 non posso', created_at: '2026-10-27T10:10:40Z' }];
    expect(applicaGuardie({ verdetto: 'disdetta_vera', citazione: 'non mi interessa più' }, conOrario, adesso)).toEqual({ verdetto: 'disdetta_vera', guardia: [] });
    const lutto: MessaggioChat[] = [
      ...chat.slice(0, 1),
      { direction: 'in', body: 'Mi scuso ma mi ritiro. Ho un luto in famiglia e non riesco fare adesso niente del genere.', created_at: '2026-10-27T10:10:00Z' },
    ];
    expect(applicaGuardie({ verdetto: 'disdetta_vera', citazione: 'Mi scuso ma mi ritiro' }, lutto, adesso)).toEqual({ verdetto: 'disdetta_vera', guardia: [] });
  });
});

describe('chat 32198: «non voglio più essere contattata» non è mai recuperabile', () => {
  const chat32198: MessaggioChat[] = [
    { direction: 'out', body: 'Dimmi solo se alle 17:00 di oggi riesci a esserci o preferisci spostare?', created_at: '2026-11-12T14:16:12Z' },
    { direction: 'in', body: 'Sì a sto punto si che purtroppo oggi non so che ha mia figlia', created_at: '2026-11-12T14:45:17Z' },
    { direction: 'out', body: 'Nessun problema, si può spostare una volta sola. Dimmi giorno e ora in cui sei sicura di esserci', created_at: '2026-11-12T14:45:32Z' },
    { direction: 'out', body: 'Ciao Sahide, è la terza volta che proviamo a chiamarti per la call di giovedì 12 alle 17:00. Quando ti va bene essere richiamata?', created_at: '2026-11-12T15:47:01Z' },
    { direction: 'in', body: 'Allora oggi non posso dato che insistete non voglio più essere contatta', created_at: '2026-11-12T15:47:40Z' },
    { direction: 'out', body: 'Ok, rispetto la tua scelta, non ti scrivo più.', created_at: '2026-11-12T15:48:00Z' },
  ];
  const ora = '2026-11-12T15:48:04Z';
  const frase = 'Allora oggi non posso dato che insistete non voglio più essere contatta';

  it('il verdetto «dubbio» del modello (quello vero del 12/11) diventa disdetta_vera', () => {
    expect(applicaGuardie({ verdetto: 'dubbio', citazione: frase }, chat32198, ora)).toEqual({ verdetto: 'disdetta_vera', guardia: ['stop_contatti'] });
  });
  it('anche da non_disdetta; senza una citazione buona la citazione diventa la frase del lead', () => {
    expect(applicaGuardie({ verdetto: 'non_disdetta', citazione: '' }, chat32198, ora)).toEqual({ verdetto: 'disdetta_vera', guardia: ['stop_contatti'], citazione: frase });
  });
  it("giudicaDisdetta: verdetto finale disdetta_vera, quello del modello resta in verdettoModello per l'audit", async () => {
    const a = {
      messages: {
        parse: vi.fn().mockResolvedValue({
          stop_reason: 'end_turn',
          parsed_output: { verdetto: 'dubbio', categoria: 'personale_salute', citazione: frase, motivo: 'sembra uno spostamento esasperato' },
          usage: { input_tokens: 3612, output_tokens: 162, cache_read_input_tokens: 0, cache_creation_input_tokens: 3034 },
        }),
      },
    };
    const g = await giudicaDisdetta(chat32198, { adesso: ora, appuntamentoAt: '2026-11-12T16:00:00Z' }, { anthropic: a as never });
    expect(g.verdetto).toBe('disdetta_vera');
    expect(g.verdettoModello).toBe('dubbio');
    expect(g.guardia).toEqual(['stop_contatti']);
    expect(g.citazione).toBe(frase);
  });
  it('chi vuole solo la fine dei messaggi ma tiene la call non viene forzato: decide il modello', () => {
    const tieneLaCall: MessaggioChat[] = [
      { direction: 'out', body: 'Ti ricordo il video', created_at: '2026-11-12T15:47:01Z' },
      { direction: 'in', body: 'ho già un appuntamento con Noemi domani, non rispondermi più', created_at: '2026-11-12T15:47:40Z' },
    ];
    expect(applicaGuardie({ verdetto: 'non_disdetta', citazione: '' }, tieneLaCall, ora)).toEqual({ verdetto: 'non_disdetta', guardia: [] });
  });
});

describe('il prompt del giudice dopo la stretta del 12/11/2026', () => {
  it("si salva solo chi chiede di spostare o da' una disponibilita' concreta", () => {
    expect(SYSTEM_GIUDICE).toContain('SI SALVA SOLO CHI VUOLE DAVVERO RIFARLA');
    expect(SYSTEM_GIUDICE).toContain('Chiede davvero di spostare');
    expect(SYSTEM_GIUDICE).toContain('Indica una nuova disponibilità concreta');
    expect(SYSTEM_GIUDICE).not.toContain('NEL DUBBIO VINCE SEMPRE');
  });
  it('i casi che prima venivano salvati sono scritti come disdetta_vera', () => {
    expect(SYSTEM_GIUDICE).toContain("«non posso unirmi all'appuntamento delle 15. Annullo tutto» → disdetta_vera");
    expect(SYSTEM_GIUDICE).toContain('«Preferisco rimandare il tutto, ricontatto a dicembre» → disdetta_vera');
    expect(SYSTEM_GIUDICE).toContain('«Annulliamo» (in risposta al messaggio sulle chiamate perse di Noemi) → disdetta_vera');
  });
  it("revisione 13/11/2026: chi non riesce, ha un imprevisto o deve rimandare senza annullare e' salvo anche senza una data", () => {
    // chat 22690, 27820, 18028: uscite disdetta_vera col modello vero
    expect(SYSTEM_GIUDICE).toContain('in uno di questi quattro casi');
    expect(SYSTEM_GIUDICE).toContain('D. Dice che alla videochiamata fissata non riesce');
    expect(SYSTEM_GIUDICE).toContain('SENZA annullare o rinunciare in modo esplicito');
    expect(SYSTEM_GIUDICE).toContain('solo se il BOT gli ha già chiesto quando e lui non dà un giorno');
    expect(SYSTEM_GIUDICE).toContain('rimanda a un periodo vago o lontano');
    // la domanda che conta e' quella sul giorno della VIDEOCHIAMATA (chat 30319: il BOT chiedeva quando richiamarla per Noemi)
    expect(SYSTEM_GIUDICE).toContain('il BOT gli ha già chiesto un altro giorno per la videochiamata e lui, invece di darlo, rinuncia o rimanda a un periodo vago o lontano.');
    expect(SYSTEM_GIUDICE).toContain('→ non_disdetta, spostamento: non annulla, il nuovo giorno glielo chiede il BOT.');
    expect(SYSTEM_GIUDICE).toContain('«non lo so, in questo periodo è un casino» → disdetta_vera');
    // niente «vi faccio sapere» nell'esempio: trascinava a disdetta la chat 4097 (presente)
    expect(SYSTEM_GIUDICE).not.toContain('«non so, vi faccio sapere io»');
  });
  it("la richiesta di non essere piu' contattati e' sempre disdetta_vera", () => {
    expect(SYSTEM_GIUDICE).toContain('NON CONTATTATEMI PIÙ');
    expect(SYSTEM_GIUDICE).toContain('non è mai recuperabile');
    expect(SYSTEM_GIUDICE).toContain('«Allora oggi non posso dato che insistete non voglio più essere contattata» → disdetta_vera');
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
