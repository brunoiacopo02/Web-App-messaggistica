import { describe, it, expect, vi, beforeEach } from 'vitest';

const messagesCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: messagesCreate };
  },
}));

const eventInsert = vi.fn(async (_row: Record<string, unknown>) => ({ error: null }));
vi.mock('./supabase/admin', () => ({
  getSupabaseAdmin: () => ({ from: () => ({ insert: eventInsert }) }),
}));

const braccioFinto = vi.fn(async (_s: unknown, _id: number): Promise<'sonnet' | 'opus'> => 'sonnet');
vi.mock('./mario-braccio', async (orig) => ({
  ...(await orig<typeof import('./mario-braccio')>()),
  braccioConversazione: (s: unknown, id: number) => braccioFinto(s, id),
}));

import { parseMarioReply, generateMarioReply, GDO_CONTEXT_NOTE } from './mario';
import { BLOCCO_OPUS } from './mario-blocco-opus';
import { MARIO_SYSTEM_PROMPT, buildMarioSystem } from './mario-prompt';

beforeEach(() => {
  messagesCreate.mockReset();
  eventInsert.mockClear();
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

/** Il system viaggia in due blocchi (il primo in cache): qui si rilegge come un testo
 *  solo, che e' quello che il modello vede davvero. */
const systemDi = (call = 0): string =>
  (messagesCreate.mock.calls[call][0].system as Array<{ text: string }>).map((b) => b.text).join('');

describe('generateMarioReply', () => {
  it('chiama Claude con system prompt + history e ritorna il testo pulito', async () => {
    messagesCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: 'Ciao! Sono Mario 😊' }] });
    const out = await generateMarioReply([{ role: 'user', content: 'ciao' }]);
    expect(out.visibleReply).toBe('Ciao! Sono Mario 😊');
    const arg = messagesCreate.mock.calls[0][0];
    expect(arg.model).toBe('claude-sonnet-5-5');
    // Sonnet 5.5 rifiuta thinking 'disabled' con un 400: il minimo e' between_tools,
    // che vuole effort high o piu' basso.
    expect(arg.thinking).toEqual({ type: 'between_tools' });
    expect(arg.output_config).toEqual({ effort: 'high' });
    expect(out.braccio).toBe('sonnet');
    expect(arg.messages).toEqual([{ role: 'user', content: 'ciao' }]);
    expect(Array.isArray(arg.system)).toBe(true);
  });

  // Il caching non deve cambiare una virgola di cio' che il modello legge: la prova e'
  // che i due blocchi concatenati diano il manuale seguito dal contesto, e che la
  // cache stia SOLO sul primo (il secondo cambia a ogni turno).
  it('spezza il system in manuale (in cache) + contesto, senza alterare il testo', async () => {
    messagesCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: 'ok' }] });
    await generateMarioReply([{ role: 'user', content: 'ciao' }], { personaName: 'Marta' });

    const blocchi = messagesCreate.mock.calls[0][0].system as Array<Record<string, unknown>>;
    expect(blocchi).toHaveLength(2);
    expect(blocchi[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(blocchi[1].cache_control).toBeUndefined();
    // il manuale sta tutto nel primo blocco, il secondo si aggancia con i due a capo
    expect(blocchi[0].text as string).toBe(buildMarioSystem('Marta'));
    expect((blocchi[1].text as string).startsWith('\n\n')).toBe(true);
    expect(systemDi(0)).toBe(`${blocchi[0].text}${blocchi[1].text}`);
  });

  // Il client nasce con `timeout: 60_000, maxRetries: 5`: dentro una funzione con un
  // `maxDuration` di 60s un solo tentativo puo' bruciarla tutta, e chi ha gia' mandato
  // qualcosa al lead viene ucciso prima di poterselo scrivere da qualche parte.
  it('timeoutMs e maxRetries arrivano all SDK come opzioni della singola richiesta', async () => {
    messagesCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: 'ok' }] });
    await generateMarioReply([{ role: 'user', content: 'ciao' }], { timeoutMs: 20_000, maxRetries: 1 });
    expect(messagesCreate.mock.calls[0][1]).toEqual({ timeout: 20_000, maxRetries: 1 });
  });

  it('chi non chiede un budget non cambia comportamento: nessuna opzione, valgono quelle del client', async () => {
    messagesCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: 'ok' }] });
    await generateMarioReply([{ role: 'user', content: 'ciao' }]);
    expect(messagesCreate.mock.calls[0][1]).toBeUndefined();
  });

  it('history vuota: usa il seed di apertura', async () => {
    messagesCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: 'Ciao!' }] });
    await generateMarioReply([]);
    expect(messagesCreate.mock.calls[0][0].messages).toEqual([
      { role: 'user', content: 'Inizia la conversazione presentandoti.' },
    ]);
  });

  // Un media senza didascalia arriva da Twilio con body vuoto. Finito nello storico,
  // faceva fallire OGNI turno successivo di quella chat con 400 "user messages must
  // have non-empty content", e il cron riprovava all'infinito.
  it('racconta a Mario il media del lead invece di mandare un turno vuoto', async () => {
    messagesCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: 'Ok!' }] });
    await generateMarioReply([
      { role: 'user', content: 'ciao' },
      { role: 'assistant', content: 'Dimmi pure' },
      { role: 'user', content: '   ' },
    ]);
    const inviati = messagesCreate.mock.calls[0][0].messages;
    expect(inviati).toHaveLength(3);
    expect(inviati[2].role).toBe('user');
    expect(inviati[2].content).toContain('senza testo');
  });

  // Il vuoto è quasi sempre l'ULTIMO messaggio della chat: scartarlo lascerebbe la
  // conversazione a finire con un turno assistant, che Sonnet 4.6 rifiuta con
  // 400 "does not support assistant message prefill".
  it('non lascia mai la conversazione finita su un turno assistant', async () => {
    messagesCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: 'Ok!' }] });
    await generateMarioReply([
      { role: 'user', content: 'grazie mille' },
      { role: 'assistant', content: 'Grazie a te, a presto 👋' },
      { role: 'user', content: '' },
    ]);
    const inviati = messagesCreate.mock.calls[0][0].messages;
    expect(inviati[inviati.length - 1].role).toBe('user');
  });

  it('un turno assistant vuoto invece si scarta: non ha nulla da dire', async () => {
    messagesCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: 'Ok!' }] });
    await generateMarioReply([
      { role: 'user', content: 'ciao' },
      { role: 'assistant', content: '' },
      { role: 'user', content: 'ci sei?' },
    ]);
    expect(messagesCreate.mock.calls[0][0].messages).toEqual([
      { role: 'user', content: 'ciao' },
      { role: 'user', content: 'ci sei?' },
    ]);
  });

  it('history di soli turni assistant vuoti: ripiega sul seed di apertura', async () => {
    messagesCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: 'Ciao!' }] });
    await generateMarioReply([
      { role: 'assistant', content: '' },
      { role: 'assistant', content: '  ' },
    ]);
    expect(messagesCreate.mock.calls[0][0].messages).toEqual([
      { role: 'user', content: 'Inizia la conversazione presentandoti.' },
    ]);
  });

  // La scheda "subito" del funnel Professioni metteva il PDF in coda alla cronologia come
  // turno assistant: claude-sonnet-5 rispondeva 400 "does not support assistant message
  // prefill" (17/17 dal 31/10/2026) e il lead riceveva il PDF senza una riga di testo.
  it("cronologia finita su assistant: l'ultimo messaggio resta del lead, la coda va nella nota", async () => {
    messagesCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: 'Ok!' }] });
    await generateMarioReply([
      { role: 'user', content: 'mi mandi la scheda?' },
      { role: 'assistant', content: 'Ecco la scheda del corso 👇' },
    ], { contextNote: 'NOTA DEL TURNO' });
    const arg = messagesCreate.mock.calls[0][0];
    expect(arg.messages.at(-1).role).toBe('user');
    expect(arg.messages).toEqual([{ role: 'user', content: 'mi mandi la scheda?' }]);
    const variabile = arg.system[1].text as string;
    expect(variabile).toContain('NOTA DEL TURNO');
    expect(variabile).toContain('«Ecco la scheda del corso 👇»');
    expect(eventInsert).toHaveBeenCalledTimes(1);
    expect(eventInsert.mock.calls[0][0]).toMatchObject({ type: 'mario_turno_assistant_finale_rimosso', level: 'warn' });
  });

  it("piu' turni assistant in coda: escono tutti, nell'ordine", async () => {
    messagesCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: 'Ok!' }] });
    await generateMarioReply([
      { role: 'user', content: 'ciao' },
      { role: 'assistant', content: 'primo' },
      { role: 'assistant', content: 'secondo' },
    ]);
    const arg = messagesCreate.mock.calls[0][0];
    expect(arg.messages.at(-1).role).toBe('user');
    const variabile = arg.system[1].text as string;
    expect(variabile.indexOf('«primo»')).toBeLessThan(variabile.indexOf('«secondo»'));
  });

  it("cronologia gia' finita sul lead: nessuna nota e nessun log", async () => {
    messagesCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: 'Ok!' }] });
    await generateMarioReply([
      { role: 'assistant', content: 'Ciao, sono Mario' },
      { role: 'user', content: 'ciao' },
    ]);
    expect(messagesCreate.mock.calls[0][0].system[1].text).not.toContain("GIA' INVIATO DA TE");
    expect(eventInsert).not.toHaveBeenCalled();
  });

  it('tollera un content nullo arrivato dal database', async () => {
    messagesCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: 'Ok!' }] });
    await generateMarioReply([
      { role: 'assistant', content: null as unknown as string },
      { role: 'user', content: 'ci sei?' },
    ]);
    expect(messagesCreate.mock.calls[0][0].messages).toEqual([{ role: 'user', content: 'ci sei?' }]);
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

describe('tag [NOTA|...]', () => {
  it('estrae il testo della nota e lo toglie dal messaggio visibile', () => {
    const r = parseMarioReply(
      'Perfetto, lo passo a chi ti chiama. [NOTA|Secondo recapito del lead: 3924538096]',
    );
    expect(r.notaCrm).toBe('Secondo recapito del lead: 3924538096');
    expect(r.visibleReply).toBe('Perfetto, lo passo a chi ti chiama.');
    expect(r.visibleReply).not.toContain('[NOTA');
  });

  it('senza il tag notaCrm resta undefined', () => {
    expect(parseMarioReply('Ciao!').notaCrm).toBeUndefined();
  });

  it('una nota non è un esito: non chiude la conversazione', () => {
    const r = parseMarioReply('Ok. [NOTA|Secondo recapito: 333111]');
    expect(r.outcome).toBeUndefined();
    expect(r.passToHuman).toBe(false);
  });

  // Due recapiti nello stesso messaggio: con la regex non globale la seconda [NOTA|...]
  // restava nel testo, e al lead arrivava una bolla col tag tecnico e dentro il suo numero.
  it('due tag nello stesso messaggio: li unisce in una nota sola e li toglie tutti dal visibile', () => {
    const r = parseMarioReply(
      'Perfetto, li passo entrambi. [NOTA|Secondo recapito: 333111] [NOTA|Terzo recapito: 333222]',
    );
    expect(r.notaCrm).toBe('Secondo recapito: 333111; Terzo recapito: 333222');
    expect(r.visibleReply).toBe('Perfetto, li passo entrambi.');
    expect(r.visibleReply).not.toContain('[NOTA');
    expect(r.visibleReply).not.toContain('333222');
  });

  it('un tag vuoto non sporca la nota degli altri', () => {
    const r = parseMarioReply('Ok. [NOTA|] [NOTA|Secondo recapito: 333111]');
    expect(r.notaCrm).toBe('Secondo recapito: 333111');
  });

  it('convive con un tag [ESITO:...] nello stesso messaggio senza confondersi', () => {
    const r = parseMarioReply(
      'Va bene, allora non se ne parla più. [NOTA|Secondo recapito: 333111] [ESITO:SCARTO|non interessato]',
    );
    expect(r.notaCrm).toBe('Secondo recapito: 333111');
    expect(r.outcome).toBe('DA_SCARTARE');
    expect(r.visibleReply).toBe('Va bene, allora non se ne parla più.');
  });
});

describe('generateMarioReply — contesto extra (lead con appuntamento già fissato dal GDO)', () => {
  it('appende il contesto al system prompt senza toccare la cronologia', async () => {
    messagesCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: 'Ok!' }] });
    await generateMarioReply([{ role: 'user', content: 'ok' }], { contextNote: 'CONTESTO: appuntamento già fissato.' });

    const arg = messagesCreate.mock.calls[0][0];
    expect(systemDi(0)).toContain('CONTESTO: appuntamento già fissato.');
    expect(arg.messages).toEqual([{ role: 'user', content: 'ok' }]);
  });

  it('senza contesto il system prompt resta quello di sempre', async () => {
    messagesCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: 'Ok!' }] });
    await generateMarioReply([{ role: 'user', content: 'ok' }]);
    expect(systemDi(0)).not.toContain('CONTESTO:');
  });
});

describe('contesto Mario per i lead dei GDO', () => {
  it('dice che l\'appuntamento c\'è già e che il video è partito, rimandando alla sezione del prompt', () => {
    expect(GDO_CONTEXT_NOTE).toContain('appuntamento');
    expect(GDO_CONTEXT_NOTE).toContain("SE L'APPUNTAMENTO È GIÀ FISSATO");
    expect(GDO_CONTEXT_NOTE).toContain('collega');
  });

  it('la sezione richiamata esiste davvero nel prompt', () => {
    expect(MARIO_SYSTEM_PROMPT).toContain("SE L'APPUNTAMENTO È GIÀ FISSATO");
  });
});

// I due giorni prenotabili devono uscire da qui insieme alla risposta: sono quelli che
// il modello ha DAVVERO letto nel prompt di questo turno, e devono arrivare fino alla
// guardia sull'esito. Ricalcolarli più tardi, dopo le 20:00, sposta la finestra e fa
// scartare la call che il bot ha appena promesso al lead.
describe('generateMarioReply — i giorni prenotabili escono col risultato', () => {
  it('restituisce gli stessi due giorni che ha scritto nel prompt', async () => {
    messagesCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: 'Ok!' }] });
    // Giovedì 10 settembre 2026 alle 19:45: la finestra è venerdì 11 e sabato 12.
    const now = new Date('2026-09-10T17:45:00Z');
    const r = await generateMarioReply([{ role: 'user', content: 'ok' }], { now });

    expect(r.bookingDays).toEqual(['2026-09-11', '2026-09-12']);
    const system = systemDi(0);
    for (const g of r.bookingDays!) expect(system).toContain(g);
  });

  // Dal 26/10/2026 la finestra ruota a mezzanotte, non più alle 20:00.
  it('a mezzanotte la finestra è già ruotata: sono quelli nuovi a viaggiare, non i vecchi', async () => {
    messagesCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: 'Ok!' }] });
    const r = await generateMarioReply([{ role: 'user', content: 'ok' }], {
      now: new Date('2026-09-10T22:10:00Z'), // 00:10 di venerdì 11 a Roma
    });
    // Sabato 12 e lunedì 14: domenica 13 non è mai prenotabile.
    expect(r.bookingDays).toEqual(['2026-09-12', '2026-09-14']);
  });
});

describe('generateMarioReply — A/B Sonnet 5.5 / Opus 5.5 (PO 07/11/2026)', () => {
  beforeEach(() => { braccioFinto.mockReset(); braccioFinto.mockResolvedValue('sonnet'); });

  it('senza conversationId non chiede il braccio e usa Sonnet', async () => {
    messagesCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: 'ok' }], model: 'claude-sonnet-5-5' });
    const r = await generateMarioReply([{ role: 'user', content: 'ciao' }]);
    expect(braccioFinto).not.toHaveBeenCalled();
    expect(r.braccio).toBe('sonnet');
    expect(messagesCreate.mock.calls[0][0].model).toBe('claude-sonnet-5-5');
  });

  it('braccio opus: Opus 5.5 col ragionamento e il blocco dentro la parte in cache', async () => {
    braccioFinto.mockResolvedValue('opus');
    messagesCreate.mockResolvedValueOnce({
      content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: 'Ciao!' }],
      model: 'claude-opus-5-5', stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 300 },
    });
    const r = await generateMarioReply([{ role: 'user', content: 'ciao' }], { conversationId: 77 });
    const arg = messagesCreate.mock.calls[0][0];
    expect(braccioFinto.mock.calls[0][1]).toBe(77);
    expect(arg.model).toBe('claude-opus-5-5');
    expect(arg.thinking).toEqual({ type: 'adaptive' });
    expect(arg.output_config).toEqual({ effort: 'medium' });
    expect(arg.max_tokens).toBe(16000);
    expect(arg.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(arg.system[0].text).toBe(`${buildMarioSystem('Mario')}\n\n${BLOCCO_OPUS}`);
    expect(r.visibleReply).toBe('Ciao!');
    expect(r).toMatchObject({ braccio: 'opus', modello: 'claude-opus-5-5', token: { input: 10, output: 300 } });
    expect(r.ripiego).toBeUndefined();
  });

  it('il blocco NON va nel braccio sonnet', async () => {
    messagesCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: 'ok' }] });
    await generateMarioReply([{ role: 'user', content: 'ciao' }], { conversationId: 5 });
    expect(systemDi()).not.toContain('COME RAGIONARE PRIMA DI OGNI RISPOSTA');
  });

  it('Opus rifiuta: risponde Sonnet e resta traccia del ripiego', async () => {
    braccioFinto.mockResolvedValue('opus');
    messagesCreate
      .mockResolvedValueOnce({ content: [], stop_reason: 'refusal', model: 'claude-opus-5-5' })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'eccomi' }], model: 'claude-sonnet-5-5' });
    const r = await generateMarioReply([{ role: 'user', content: 'ciao' }], { conversationId: 9 });
    expect(messagesCreate.mock.calls[1][0].model).toBe('claude-sonnet-5-5');
    expect(r).toMatchObject({ visibleReply: 'eccomi', braccio: 'opus', modello: 'claude-sonnet-5-5', ripiego: 'rifiuto' });
    expect(eventInsert.mock.calls.some(([row]) => row.type === 'mario_opus_ripiego')).toBe(true);
  });

  it('Opus va in errore: ripiega su Sonnet, ma non se il chiamante ha un budget di tempo suo', async () => {
    braccioFinto.mockResolvedValue('opus');
    messagesCreate
      .mockRejectedValueOnce(new Error('overloaded'))
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'eccomi' }], model: 'claude-sonnet-5-5' });
    const r = await generateMarioReply([{ role: 'user', content: 'ciao' }], { conversationId: 9 });
    expect(r.ripiego).toMatch(/^errore: overloaded/);

    messagesCreate.mockReset();
    messagesCreate.mockRejectedValueOnce(new Error('timeout'));
    await expect(generateMarioReply([{ role: 'user', content: 'ciao' }], { conversationId: 9, timeoutMs: 20_000 })).rejects.toThrow('timeout');
    expect(messagesCreate).toHaveBeenCalledTimes(1);
  });
});

describe('blocco Opus', () => {
  it('su "ci penso" chiede prima cosa lo frena, non quando risentirsi (caso d_cipenso-24524)', () => {
    expect(BLOCCO_OPUS).toContain('"CI PENSO / TI FACCIO SAPERE": la prima volta che te lo dice, la tua risposta è SEMPRE una domanda sola su cosa lo frena davvero');
    expect(BLOCCO_OPUS).toContain('mai come risposta a un "ci penso"');
  });
  it('rimanda al manuale per rata e "sei un bot?"', () => {
    expect(BLOCCO_OPUS).toContain('rata, passaggi a persona e su cosa rispondere se ti chiede se sei un bot vale sempre il manuale');
    expect(BLOCCO_OPUS).not.toContain('Le cifre di rata non le dici mai');
  });
});
