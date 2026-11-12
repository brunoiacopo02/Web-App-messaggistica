import { describe, expect, it, vi } from 'vitest';
import {
  dataCallDelBot, elencoGiorni, esitoDaSpostare, giorniSpostamento, motivoDataNonValida, motivoNonSpostabile, notaSpostamentoFattoPrompt, notaSpostamentoPrompt,
  origineSpostamento, spostamentoAbilitato, testoSpostamentoFatto, ultimoLinkVideo,
  richiamoNonESpostamento, spostamentoGiaRifiutato, testoSpostamentoNonFatto,
  TESTO_SPOSTAMENTO_NON_FATTO, TESTO_SPOSTAMENTO_PASSATO_AI_COLLEGHI,
} from './gdo-spostamento';
import { inviaSpostamentoAlCrm } from './gdo-spostamento-send';
import { parseMarioReply } from './mario';

// mercoledì 28/10/2026 15:00 Roma (CET, +01:00)
const MER_15 = new Date('2026-10-28T15:00:00+01:00');
const CALL = '2026-10-29T17:00:00.000Z'; // giovedì 29 alle 18
const NESSUNA_CHIUSURA: { from: string; to: string }[] = [];

describe('interruttore', () => {
  it('acceso di default, spento solo con 0', () => {
    expect(spostamentoAbilitato(undefined)).toBe(true);
    expect(spostamentoAbilitato('1')).toBe(true);
    expect(spostamentoAbilitato('0')).toBe(false);
  });
});

describe('giorni dello spostamento', () => {
  it('i prossimi 3 lavorativi, oggi escluso', () =>
    expect(giorniSpostamento(MER_15, NESSUNA_CHIUSURA)).toEqual(['2026-10-29', '2026-10-30', '2026-10-31']));
  it('la domenica salta', () =>
    expect(giorniSpostamento(new Date('2026-10-30T10:00:00+01:00'), NESSUNA_CHIUSURA)).toEqual(['2026-10-31', '2026-11-02', '2026-11-03']));
  it('un giorno di chiusura si toglie, non si sostituisce', () =>
    expect(giorniSpostamento(MER_15, [{ from: '2026-10-30', to: '2026-10-30' }])).toEqual(['2026-10-29', '2026-10-31']));
  it('elenco leggibile', () =>
    expect(elencoGiorni(['2026-10-29', '2026-10-30', '2026-10-31'])).toBe('giovedì 29, venerdì 30 e sabato 31'));
});

describe('quando la chat può offrire lo spostamento', () => {
  const base = {
    enabled: true, origine: 'gdo' as const, appuntamentoAt: CALL, giaSpostato: false, nowMs: MER_15.getTime(),
  };
  it('lead GDO con call futura: sì', () => expect(motivoNonSpostabile(base)).toBeNull());
  it('call fissata dal bot con call futura: sì (PO 29/10/2026)', () =>
    expect(motivoNonSpostabile({ ...base, origine: 'bot' })).toBeNull());
  it('i no', () => {
    expect(motivoNonSpostabile({ ...base, enabled: false })).toBe('spento');
    expect(motivoNonSpostabile({ ...base, origine: null })).toBe('non_postino');
    expect(motivoNonSpostabile({ ...base, origine: 'bot', dataCambiata: true })).toBe('data_cambiata_dal_crm');
    expect(motivoNonSpostabile({ ...base, origine: 'bot', giaSpostato: true })).toBe('gia_spostato');
    expect(motivoNonSpostabile({ ...base, origine: 'bot', confermeOutcome: 'confermato' })).toBe('esito_conferme');
    expect(motivoNonSpostabile({ ...base, appuntamentoAt: null })).toBe('senza_data');
    expect(motivoNonSpostabile({ ...base, giaSpostato: true })).toBe('gia_spostato');
    expect(motivoNonSpostabile({ ...base, presented: true })).toBe('gia_presentato');
    expect(motivoNonSpostabile({ ...base, confermeOutcome: 'confermato' })).toBe('esito_conferme');
    expect(motivoNonSpostabile({ ...base, confermeOutcome: 'da_rifissare' })).toBe('esito_conferme');
  });
  describe('il bot sposta sempre (PO 12/11/2026): rami che prima finivano in sola nota', () => {
    it('scartato dalle Conferme (tre chiamate senza risposta): ora si sposta, lo scarto lo riapre il CRM', () => {
      expect(motivoNonSpostabile({ ...base, confermeOutcome: 'scartato' })).toBeNull();
      expect(motivoNonSpostabile({ ...base, origine: 'bot', confermeOutcome: 'scartato' })).toBeNull();
      // Una volta sola e «già presentato» valgono anche per lo scartato.
      expect(motivoNonSpostabile({ ...base, confermeOutcome: 'scartato', giaSpostato: true })).toBe('gia_spostato');
      expect(motivoNonSpostabile({ ...base, confermeOutcome: 'scartato', salesOutcome: 'Chiuso' })).toBe('gia_presentato');
    });
    it('call a meno di 30 minuti: ora si sposta, basta che sia futura', () => {
      // MER_15 = 14:00Z; call alle 14:20Z e alle 14:01Z.
      expect(motivoNonSpostabile({ ...base, appuntamentoAt: '2026-10-28T14:20:00Z' })).toBeNull();
      expect(motivoNonSpostabile({ ...base, origine: 'bot', appuntamentoAt: '2026-10-28T14:01:00Z' })).toBeNull();
    });
    it('call del GDO passata da non più di 7 giorni: si sposta; oltre, o sulle call del bot, no', () => {
      expect(motivoNonSpostabile({ ...base, appuntamentoAt: '2026-10-28T11:00:00Z' })).toBeNull();
      expect(motivoNonSpostabile({ ...base, appuntamentoAt: '2026-10-22T17:00:00Z' })).toBeNull();
      expect(motivoNonSpostabile({ ...base, appuntamentoAt: '2026-10-21T13:00:00Z' })).toBe('call_passata');
      // Sulle call del bot una call passata si rifissa da zero (isRifissaggioDopoCallPassata).
      expect(motivoNonSpostabile({ ...base, origine: 'bot', appuntamentoAt: '2026-10-28T11:00:00Z' })).toBe('call_passata');
    });
  });
});

describe('esitoDaSpostare: RICHIAMO o APPUNTAMENTO con una data nuova buona valgono [SPOSTA] (PO 12/11/2026)', () => {
  // mercoledì 28/10 15:00; call giovedì 29 alle 18:00; finestra gio 29, ven 30, sab 31.
  const base = {
    outcome: 'RICHIAMO' as string | undefined, date: '2026-10-30T12:00:00+01:00' as string | undefined, spostaAt: undefined as string | undefined,
    motivoNoSposta: null as ReturnType<typeof motivoNonSpostabile>, callAt: CALL as string | null, nowMs: MER_15.getTime(), ranges: [],
  };
  it('conv 30493: [ESITO:RICHIAMO|venerdì alle 12] su una call spostabile → si sposta a quella data', () => {
    expect(esitoDaSpostare(base)).toBe('2026-10-30T12:00:00+01:00');
  });
  it('conv 30950/32096: anche [ESITO:APPUNTAMENTO|data nuova]', () => {
    expect(esitoDaSpostare({ ...base, outcome: 'APPUNTAMENTO', date: '2026-10-29T21:00:00+01:00' })).toBe('2026-10-29T21:00:00+01:00');
  });
  it('resta una nota: senza data, data fuori finestra o fascia, stessa data, call non spostabile, altri esiti, [SPOSTA] già nel turno', () => {
    expect(esitoDaSpostare({ ...base, date: undefined })).toBeNull();
    expect(esitoDaSpostare({ ...base, date: 'a gennaio' })).toBeNull();
    expect(esitoDaSpostare({ ...base, date: '2026-11-10T12:00:00+01:00' })).toBeNull();
    expect(esitoDaSpostare({ ...base, date: '2026-10-30T22:30:00+01:00' })).toBeNull();
    expect(esitoDaSpostare({ ...base, date: '2026-10-29T18:00:00+01:00' })).toBeNull();
    expect(esitoDaSpostare({ ...base, motivoNoSposta: 'gia_spostato' })).toBeNull();
    expect(esitoDaSpostare({ ...base, motivoNoSposta: 'esito_conferme' })).toBeNull();
    expect(esitoDaSpostare({ ...base, outcome: 'DA_SCARTARE' })).toBeNull();
    expect(esitoDaSpostare({ ...base, outcome: undefined })).toBeNull();
    expect(esitoDaSpostare({ ...base, spostaAt: '2026-10-30T12:00:00+01:00' })).toBeNull();
  });
  it('un anticipo resta una nota: «richiamatemi domani alle 10» di solito è la chiamata di Noemi, non la videochiamata', () => {
    expect(esitoDaSpostare({ ...base, date: '2026-10-29T10:00:00+01:00' })).toBeNull();
  });
  it('call del GDO già passata: qualunque data buona nella finestra è un posticipo', () => {
    expect(esitoDaSpostare({ ...base, callAt: '2026-10-28T11:00:00Z', date: '2026-10-29T10:00:00+01:00' })).toBe('2026-10-29T10:00:00+01:00');
  });
});

describe('la data del tag [SPOSTA]', () => {
  const now = MER_15.getTime();
  it('buona: dentro i 3 giorni, 9-21', () => {
    expect(motivoDataNonValida('2026-10-30T18:00:00+01:00', CALL, now, NESSUNA_CHIUSURA)).toBeNull();
    expect(motivoDataNonValida('2026-10-31T09:00:00+01:00', CALL, now, NESSUNA_CHIUSURA)).toBeNull();
    expect(motivoDataNonValida('2026-10-31T21:00:00+01:00', CALL, now, NESSUNA_CHIUSURA)).toBeNull();
  });
  it('i no', () => {
    expect(motivoDataNonValida(undefined, CALL, now, NESSUNA_CHIUSURA)).toBe('assente');
    expect(motivoDataNonValida('venerdì alle 18', CALL, now, NESSUNA_CHIUSURA)).toBe('illeggibile');
    expect(motivoDataNonValida('2026-10-30T18:00:00', CALL, now, NESSUNA_CHIUSURA)).toBe('illeggibile');
    expect(motivoDataNonValida('2026-10-28T12:00:00+01:00', CALL, now, NESSUNA_CHIUSURA)).toBe('passato');
    expect(motivoDataNonValida('2026-10-29T18:00:00+01:00', CALL, now, NESSUNA_CHIUSURA)).toBe('stessa_data');
    expect(motivoDataNonValida('2026-11-01T11:00:00+01:00', CALL, now, NESSUNA_CHIUSURA)).toBe('domenica');
    expect(motivoDataNonValida('2026-10-30T11:00:00+01:00', CALL, now, [{ from: '2026-10-30', to: '2026-10-30' }])).toBe('giorno_chiuso');
    expect(motivoDataNonValida('2026-11-02T11:00:00+01:00', CALL, now, NESSUNA_CHIUSURA)).toBe('fuori_finestra');
    expect(motivoDataNonValida('2026-10-28T19:00:00+01:00', CALL, now, NESSUNA_CHIUSURA)).toBe('fuori_finestra');
    expect(motivoDataNonValida('2026-10-30T08:30:00+01:00', CALL, now, NESSUNA_CHIUSURA)).toBe('fuori_fascia');
    expect(motivoDataNonValida('2026-10-30T21:30:00+01:00', CALL, now, NESSUNA_CHIUSURA)).toBe('fuori_fascia');
  });
  it('legge l\'ora di Roma anche se il tag è in UTC', () =>
    expect(motivoDataNonValida('2026-10-30T20:30:00Z', CALL, now, NESSUNA_CHIUSURA)).toBe('fuori_fascia'));
});

describe('testi', () => {
  it('prompt: giorni, fascia, una volta sola, tag', () => {
    const t = notaSpostamentoPrompt({ giorni: ['2026-10-29', '2026-10-30', '2026-10-31'], callAt: new Date(CALL) });
    expect(t).toContain('giovedì 29, venerdì 30 e sabato 31');
    expect(t).toContain('dalle 10:00 alle 21:00');
    expect(t).toContain('Si può spostare una volta sola');
    expect(t).toContain('[SPOSTA|');
    expect(t).toContain('[ESITO:RICHIAMO|');
    expect(t).toContain('giovedì 29 alle 18:00');
  });
  it('il bot sposta sempre (PO 12/11/2026): se il lead resta vago insiste e propone due orari precisi, fino a due volte, prima della nota', () => {
    const t = notaSpostamentoPrompt({ giorni: ['2026-10-29', '2026-10-30', '2026-10-31'], callAt: new Date(CALL) });
    expect(t).toContain('LO SPOSTI SEMPRE TU');
    expect(t).toContain('non mollare al primo giro');
    expect(t).toContain('proponigli TU due orari precisi');
    expect(t).toContain('al massimo due volte');
    expect(t).toContain('SOLO se dopo due tentativi non ti dà un giorno e un\'ora');
    // La vecchia uscita al primo «non so» non c'è più.
    expect(t).not.toContain('o resta vago ("non so", "ti faccio sapere"), NON usare [SPOSTA]');
    // L'orario sicuro del 10/11 resta com'era: prima gli impegni, poi le due ore.
    expect(t).toContain('Non proporgli tu orari al buio');
  });
  it('call del GDO già passata: il blocco dice che non si è fatta e che la sposta lui', () => {
    const t = notaSpostamentoPrompt({ giorni: ['2026-10-29'], callAt: new Date(CALL), callPassata: true });
    expect(t).toContain('la sua videochiamata era giovedì 29 alle 18:00 e non si è fatta');
    expect(notaSpostamentoPrompt({ giorni: ['2026-10-29'], callAt: new Date(CALL) })).toContain('la sua videochiamata è giovedì 29 alle 18:00.');
  });
  it('orario sicuro (PO 10/11/2026): niente fasce al buio, si parte dai suoi impegni', () => {
    const t = notaSpostamentoPrompt({ giorni: ['2026-10-29', '2026-10-30'], callAt: new Date(CALL) });
    expect(t).toContain('è CERTO di esserci');
    expect(t).toContain('non dargli fasce generiche ("dalle 10 in poi"');
    expect(t).toContain('lavoro, turni, figli o impegni');
    expect(t).toContain('questi sono i limiti, non una proposta');
  });
  it('conferma esplicita prima del [SPOSTA], e niente spostamento se tentenna', () => {
    const t = notaSpostamentoPrompt({ giorni: ['2026-10-29'], callAt: new Date(CALL) });
    expect(t).toContain('a quell\'ora sei sicuro di esserci');
    expect(t).toContain('NON spostare subito');
    expect(t).toContain('"penso di sì"');
    // Il tag arriva solo dopo la conferma.
    expect(t.indexOf('CONFERMA PRIMA DI SPOSTARE')).toBeLessThan(t.indexOf('scrivi SOLO il tag [SPOSTA|'));
    expect(t).toContain('Quando ti ha confermato in modo chiaro');
  });
  it('ore meno piene solo come criterio secondario, e solo se il CRM risponde', () => {
    const senza = notaSpostamentoPrompt({ giorni: ['2026-10-29'], callAt: new Date(CALL) });
    expect(senza).not.toContain('ORE MENO PIENE');
    const t = notaSpostamentoPrompt({
      giorni: ['2026-10-29', '2026-10-30'],
      callAt: new Date(CALL),
      oreOccupate: { soglia: 8, giorni: { '2026-10-29': { '10': 12, '11': 1, '12': 0, '13': 0, '15': 9, '18': 3 } } },
    });
    expect(t).toContain('criterio secondario, solo fra orari che per lui sono ugualmente sicuri');
    expect(t).toContain('giovedì 29: la mattina 12:00 o 13:00');
    expect(t).toContain('(già piene: 10:00, 15:00)');
    // Il giorno senza dati dal CRM non compare.
    expect(t).not.toContain('venerdì 30: la mattina');
    expect(t).toContain("va bene quella anche se è fra le già piene");
  });
  it('conferma: data nuova, Noemi, domanda sul video col link', () => {
    const t = testoSpostamentoFatto({
      nome: 'Luca Rossi', call: new Date('2026-10-30T18:00:00+01:00'), fissatoIl: MER_15, videoVisto: false, videoLink: 'https://x.it/v',
    });
    expect(t.split('\n')[0]).toBe('Fatto Luca, la tua videochiamata ora è *venerdì 30 alle 18:00*.');
    expect(t).toContain('una volta sola');
    // Spostata mercoledì per venerdì pomeriggio: 1ª chiamata giovedì (PO 07/11/2026).
    expect(t).toContain('*Ti chiama Noemi, una nostra collega, già giovedì 29, e se non ti trova venerdì 30, qualche ora prima*');
    expect(t).toContain("Il video l'hai già visto? Se no, guardalo prima della videochiamata 👉 https://x.it/v");
  });
  it('conferma: video già visto → niente riga del video', () => {
    const t = testoSpostamentoFatto({ nome: null, call: new Date('2026-10-30T11:00:00+01:00'), fissatoIl: MER_15, videoVisto: true, videoLink: 'https://x.it/v' });
    expect(t.startsWith('Fatto, ')).toBe(true);
    expect(t).not.toContain("Il video");
    expect(t).toContain('venerdì 30 in mattinata dalle 9');
  });
});

describe('parse del tag', () => {
  it('[SPOSTA|...] esce da spostaAt e mai in chat', () => {
    const r = parseMarioReply('[SPOSTA|2026-10-30T18:00:00+01:00]');
    expect(r.spostaAt).toBe('2026-10-30T18:00:00+01:00');
    expect(r.visibleReply).toBe('');
    expect(r.outcome).toBeUndefined();
  });
  it('senza tag niente spostaAt', () => expect(parseMarioReply('ciao').spostaAt).toBeUndefined());
});

describe('invio al CRM', () => {
  it('ok solo con rescheduled:true', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ ok: true, rescheduled: true }), { status: 200 }));
    expect(await inviaSpostamentoAlCrm('L1', '2026-10-30T18:00:00+01:00', 's', f as unknown as typeof fetch)).toEqual({ ok: true });
    const body = JSON.parse((f.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body).toEqual({ leadId: 'L1', outcome: 'SPOSTAMENTO', date: '2026-10-30T18:00:00+01:00' });
  });
  it('409 col motivo del CRM', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ error: 'spostamento_rifiutato', motivo: 'confermato' }), { status: 409 }));
    expect(await inviaSpostamentoAlCrm('L1', '2026-10-30T18:00:00+01:00', 's', f as unknown as typeof fetch)).toEqual({ ok: false, status: 409, motivo: 'confermato' });
  });
  it('rete giù: ok false, non lancia', async () => {
    const f = vi.fn(async () => { throw new Error('boom'); });
    expect(await inviaSpostamentoAlCrm('L1', '2026-10-30T18:00:00+01:00', 's', f as unknown as typeof fetch)).toEqual({ ok: false, motivo: 'boom' });
  });
});

describe('origine dello spostamento (PO 29/10/2026)', () => {
  it('postino = lead GDO, APPUNTAMENTO del bot = call del bot', () => {
    expect(origineSpostamento({ postino: true, botOutcome: null })).toBe('gdo');
    expect(origineSpostamento({ postino: true, botOutcome: 'RICHIAMO' })).toBe('gdo');
    expect(origineSpostamento({ postino: false, botOutcome: 'APPUNTAMENTO' })).toBe('bot');
  });
  it('nessuna call da spostare, o origine incerta: null', () => {
    expect(origineSpostamento({ postino: false, botOutcome: null })).toBeNull();
    expect(origineSpostamento({ postino: false, botOutcome: 'RICHIAMO' })).toBeNull();
    expect(origineSpostamento({ postino: true, botOutcome: 'APPUNTAMENTO' })).toBeNull();
  });
  it('data della call del bot: bot_scheduled_at, salvo che il CRM l\'abbia cambiata', () => {
    expect(dataCallDelBot(CALL, null)).toEqual({ at: CALL, cambiata: false });
    expect(dataCallDelBot(CALL, '2026-10-29T18:00:00+01:00')).toEqual({ at: CALL, cambiata: false });
    expect(dataCallDelBot(CALL, '2026-10-30T18:00:00+01:00')).toEqual({ at: CALL, cambiata: true });
    expect(dataCallDelBot(null, null)).toEqual({ at: null, cambiata: false });
  });
  it('ultimo link del video uscito in chat', () => {
    expect(ultimoLinkVideo([
      { direction: 'out', body: 'guarda https://corso.feniceacademy.it/conferenza-bx prima' },
      { direction: 'in', body: 'https://corso.feniceacademy.it/conferenza-zz' },
      { direction: 'out', body: 'ok a domani' },
    ])).toBe('https://corso.feniceacademy.it/conferenza-bx');
    expect(ultimoLinkVideo([{ direction: 'out', body: 'niente link' }])).toBeNull();
  });
  it('la VSL dell\'offerta conta come video (Black Friday e lead evergreen, PO 10/11/2026)', () => {
    expect(ultimoLinkVideo([
      { direction: 'out', body: '*Prima della videochiamata guarda questo video* 👉 https://lp.feniceacademy.it/vsl-offerta' },
    ])).toBe('https://lp.feniceacademy.it/vsl-offerta');
  });
});

describe('spostamento non fatto: testo e niente doppioni (lead c91081be, 30/10/2026)', () => {
  it.each(['scartato', 'confermato', 'esito_conferme', 'gia_presentato'])('%s → niente promessa di Noemi', (m) => {
    expect(testoSpostamentoNonFatto(m)).toBe(TESTO_SPOSTAMENTO_PASSATO_AI_COLLEGHI);
    expect(TESTO_SPOSTAMENTO_PASSATO_AI_COLLEGHI).not.toMatch(/Noemi|chiama/);
  });
  it.each(['fuori_finestra', 'stessa_data', 'slot_pieno', null])('%s → testo di sempre', (m) => {
    expect(testoSpostamentoNonFatto(m)).toBe(TESTO_SPOSTAMENTO_NON_FATTO);
  });
  it('stessa data gia\' rifiutata → si', () => {
    expect(spostamentoGiaRifiutato('2026-11-03T17:00:00+01:00', ['2026-11-03T17:00:00+01:00'])).toBe(true);
    expect(spostamentoGiaRifiutato('2026-11-03T17:00:00+01:00', ['2026-11-03T16:00:00.000Z'])).toBe(true);
  });
  it('data diversa, nessun tentativo o data vuota → no', () => {
    expect(spostamentoGiaRifiutato('2026-11-03T18:00:00+01:00', ['2026-11-03T17:00:00+01:00'])).toBe(false);
    expect(spostamentoGiaRifiutato('2026-11-03T17:00:00+01:00', [])).toBe(false);
    expect(spostamentoGiaRifiutato('', ['2026-11-03T17:00:00+01:00'])).toBe(false);
    expect(spostamentoGiaRifiutato(undefined, [''])).toBe(false);
  });
});

describe('richiamoNonESpostamento: niente nota SPOSTAMENTO CHIESTO su frasi che non lo chiedono (lead 4da4e19f)', () => {
  const CALL3 = '2026-11-03T16:00:00.000Z';
  const base = {
    outcome: 'RICHIAMO' as string | undefined, date: undefined as string | undefined, spostaNelTurno: false,
    callAt: CALL3 as string | null, spostataDalBotA: CALL3 as string | null, testoLead: 'farò il possibile', soloPresaDAtto: false,
  };
  it('call appena spostata dal bot, «farò il possibile» / «l\'ho visto stamattina!» → ignora', () => {
    expect(richiamoNonESpostamento(base)).toBe(true);
    expect(richiamoNonESpostamento({ ...base, testoLead: "l'ho visto stamattina!" })).toBe(true);
    expect(richiamoNonESpostamento({ ...base, testoLead: 'mi aspetto tanto da questa call', date: '2026-11-03T17:00:00+01:00' })).toBe(true);
  });
  it('il lead chiede davvero di spostare, o il modello mette una data nuova → nota come prima', () => {
    expect(richiamoNonESpostamento({ ...base, testoLead: 'devo spostare di nuovo' })).toBe(false);
    expect(richiamoNonESpostamento({ ...base, testoLead: 'non ci sono martedì' })).toBe(false);
    expect(richiamoNonESpostamento({ ...base, date: '2026-11-04T18:00:00+01:00' })).toBe(false);
  });
  it('non RICHIAMO o [SPOSTA] nel turno → non tocca', () => {
    expect(richiamoNonESpostamento({ ...base, outcome: 'SCARTO' })).toBe(false);
    expect(richiamoNonESpostamento({ ...base, spostaNelTurno: true })).toBe(false);
  });
  it('chat 32173: sulla call spostata dal bot, una disdetta arrivata DOPO lo spostamento tiene vivo il RICHIAMO', () => {
    const dopo = 'ho già un finanziamento quindi annulliamo la video di domani / Grazie / Si';
    expect(richiamoNonESpostamento({ ...base, testoLead: 'La rata finisce a maggio', testoDopoSpostamento: dopo })).toBe(false);
    expect(richiamoNonESpostamento({ ...base, testoLead: 'Grazie', soloPresaDAtto: true, testoDopoSpostamento: dopo })).toBe(false);
    // Dopo lo spostamento il lead ha solo ringraziato: il RICHIAMO resta da buttare (lead 4da4e19f).
    expect(richiamoNonESpostamento({ ...base, testoLead: 'Grazie', soloPresaDAtto: true, testoDopoSpostamento: 'ok perfetto / a martedì' })).toBe(true);
    expect(richiamoNonESpostamento({ ...base, testoDopoSpostamento: '' })).toBe(true);
  });
  it('senza spostamento del bot: solo prese d\'atto e conferme nette, e mai dopo una richiesta aperta', () => {
    const senza = { ...base, spostataDalBotA: null };
    expect(richiamoNonESpostamento(senza)).toBe(true);
    expect(richiamoNonESpostamento({ ...senza, testoLead: 'ok', soloPresaDAtto: true })).toBe(true);
    expect(richiamoNonESpostamento({ ...senza, testoLead: 'grazie, purtroppo lavoro quel giorno' })).toBe(false);
    expect(richiamoNonESpostamento({ ...senza, testoLead: 'ok', soloPresaDAtto: true, testoPrima: 'giovedì devo spostare' })).toBe(false);
  });
});

describe('notaSpostamentoFattoPrompt: dopo lo spostamento il modello non si smentisce (chat 31379)', () => {
  const t = notaSpostamentoFattoPrompt({ callAt: new Date('2026-11-10T19:00:00Z') });
  it("dice la data nuova, che e' registrata e che il messaggio «Fatto» e' vero", () => {
    expect(t).toContain('SPOSTAMENTO GIÀ FATTO');
    expect(t).toContain('martedì 10 alle 20:00');
    expect(t).toContain('registrata in agenda');
    expect(t).toContain('Non smentirlo');
  });
  it('vieta le frasi della smentita del 09/11 e dice che la regola del manuale vale solo per un secondo spostamento', () => {
    expect(t).toContain('che lo deve confermare Noemi');
    expect(t).toContain('"per ora resta"');
    expect(t).toContain("non la sposti un'ALTRA volta");
    expect(t).toContain('senza [ESITO:RICHIAMO]');
  });
});
