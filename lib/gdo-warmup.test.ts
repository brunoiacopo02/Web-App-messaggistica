import { describe, expect, it } from 'vitest';
import {
  accodaDomanda, decideCon, decidiDomanda, domandaNelRecap, notaDomandaGiaFatta, DOMANDA_1, DOMANDA_2, domandaInAttesa, eRispostaDaNotare, motivoRiscaldamento,
  notaRisposta, parlaDAltro, parlaDiDisdireOSpostare, riscaldamentoInerte, segnaleBrutto, testoRispostaCompleto, togliDomandaRifatta, type TurnoRiscaldamento,
} from './gdo-warmup';

const NOW = Date.parse('2026-10-21T12:00:00+02:00');
const CALL = '2026-10-23T10:00:00+02:00'; // venerdì 23

const base = {
  enabled: true,
  step: null as number | null,
  recapForAt: CALL,
  recapInQuestoTurno: false,
  appuntamentoAt: CALL,
  serveNoemi: false,
  nowMs: NOW,
};

const turno = (over: Partial<TurnoRiscaldamento> = {}): TurnoRiscaldamento => ({
  esito: false, passaggio: false, disdettaOSpostamento: false, spiegaNoemi: false,
  fallback: false, videoInUscita: false, rispostaModello: 'Perfetto, grazie!', ...over,
});

describe('motivoRiscaldamento: le guardie', () => {
  it.each([
    ['interruttore spento', { enabled: false }, 'spento'],
    ['turno non del postino', { postino: false }, 'non_postino'],
    ['lead con cancel', { cancelRequested: true }, 'cancel'],
    ['riscaldamento chiuso (passo 3)', { step: 3 }, 'chiuso'],
    ['recap mai mandato', { recapForAt: null }, 'no_recap'],
    ['recap partito in questo turno', { recapInQuestoTurno: true }, 'recap_turno'],
    ['in questo turno si spiega Noemi', { serveNoemi: true }, 'noemi'],
    ['call fra 2 ore', { appuntamentoAt: new Date(NOW + 2 * 3600_000).toISOString() }, 'meno_3h'],
    ['call senza data', { appuntamentoAt: null }, 'meno_3h'],
    ['call non parsabile', { appuntamentoAt: 'boh' }, 'meno_3h'],
    ['tutto a posto', {}, 'in_prompt'],
  ] as const)('%s → %s', (_, over, motivo) => {
    expect(motivoRiscaldamento({ ...base, ...over })).toBe(motivo);
  });

  it('spento vince su tutto il resto', () => {
    expect(motivoRiscaldamento({ ...base, enabled: false, postino: false, cancelRequested: true, step: 3 })).toBe('spento');
  });

  it('inerti: spento, non_postino, cancel (e nessun motivo)', () => {
    expect(riscaldamentoInerte('spento')).toBe(true);
    expect(riscaldamentoInerte('non_postino')).toBe(true);
    expect(riscaldamentoInerte('cancel')).toBe(true);
    expect(riscaldamentoInerte(null)).toBe(true);
    expect(riscaldamentoInerte('meno_3h')).toBe(false);
    expect(riscaldamentoInerte('in_prompt')).toBe(false);
  });
});

describe('decidiDomanda', () => {
  it('passo 0 → domanda 1, passo 1 → domanda 2, passo 2 → niente', () => {
    expect(decidiDomanda('in_prompt', null, turno()).domanda).toEqual({ testo: DOMANDA_1, step: 1 });
    expect(decidiDomanda('in_prompt', 1, turno()).domanda).toEqual({ testo: DOMANDA_2, step: 2 });
    expect(decidiDomanda('in_prompt', 2, turno())).toEqual({ domanda: null, salto: 'gia_fatte' });
  });

  it.each(['spento', 'cancel', 'chiuso', 'no_recap', 'recap_turno', 'noemi', 'meno_3h', 'non_postino'] as const)(
    'motivo %s → nessuna domanda',
    (m) => {
      expect(decidiDomanda(m, null, turno())).toEqual({ domanda: null, salto: m });
    },
  );

  it.each([
    ['esito', { esito: true }],
    ['passaggio', { passaggio: true }],
    ['disdetta_spostamento', { disdettaOSpostamento: true }],
    ['noemi', { spiegaNoemi: true }],
    ['fallback', { fallback: true }],
    ['video_in_uscita', { videoInUscita: true }],
    ['risposta_vuota', { rispostaModello: '  ' }],
    ['modello_ha_chiesto', { rispostaModello: 'Hai visto il video?' }],
  ] as const)('turno con %s → nessuna domanda', (salto, over) => {
    expect(decidiDomanda('in_prompt', null, turno(over))).toEqual({ domanda: null, salto });
  });
});

describe('accodaDomanda: nella stessa bolla, mai una bolla in più', () => {
  it('in fondo all\'ultima bolla, dopo una riga vuota', () => {
    const r = accodaDomanda(['Perfetto, grazie!'], DOMANDA_1);
    expect(r.parts).toEqual([`Perfetto, grazie!\n\n${DOMANDA_1}`]);
    expect(r.bolla).toBe(r.parts[0]);
  });
  it('con più bolle tocca solo l\'ultima', () => {
    const r = accodaDomanda(['a', 'b'], DOMANDA_2);
    expect(r.parts).toEqual(['a', `b\n\n${DOMANDA_2}`]);
  });
  it('senza bolle non parte nessuna domanda da sola', () => {
    expect(accodaDomanda([], DOMANDA_1)).toEqual({ parts: [], bolla: null });
  });
  it('mai due volte la stessa domanda', () => {
    const r = accodaDomanda([`ok\n\n${DOMANDA_1}`], DOMANDA_1);
    expect(r.bolla).toBeNull();
    expect(r.parts).toEqual([`ok\n\n${DOMANDA_1}`]);
  });
  it('le domande stanno in 2 righe circa e non hanno condizionali sulla chiusura', () => {
    for (const d of [DOMANDA_1, DOMANDA_2]) {
      expect(d.length).toBeLessThanOrEqual(140);
      expect(d).not.toMatch(/se ti (convince|interessa)|eventualmente/i);
      expect(d).not.toContain('\n');
    }
    expect(DOMANDA_2).toContain('1.000 a 3.000 euro');
    expect(DOMANDA_2).not.toMatch(/\d+\s*rat/i); // mai cifre di rata
  });
});

describe('domandaInAttesa', () => {
  const T0 = Date.parse('2026-10-29T07:00:00Z');
  const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();
  const out = (body: string, sec: number) => ({ direction: 'out', body, created_at: at(sec) });
  const inn = (body: string, sec: number) => ({ direction: 'in', body, created_at: at(sec) });

  it('la nostra ultima bolla aveva la domanda 1 → 1', () => {
    const rows = [out('recap', 0), inn('ok', 60), out(`Bene!\n\n${DOMANDA_1}`, 70), inn('voglio cambiare lavoro', 200)];
    expect(domandaInAttesa(rows, 3, 1, false)).toEqual({ step: 1, continuazione: false });
  });
  it('domanda 2 → 2', () => {
    expect(domandaInAttesa([out(`Grazie!\n\n${DOMANDA_2}`, 0), inn('decido io', 120)], 1, 2, false)).toEqual({ step: 2, continuazione: false });
  });
  it('passo che non e\' 1 o 2, risposta gia\' notata, nessun outbound → null', () => {
    const rows = [out(`x\n\n${DOMANDA_1}`, 0), inn('a', 100)];
    expect(domandaInAttesa(rows, 1, null, false)).toBeNull();
    expect(domandaInAttesa(rows, 1, 3, false)).toBeNull();
    expect(domandaInAttesa(rows, 1, 1, true)).toBeNull();
    expect(domandaInAttesa([inn('ciao', 0)], 0, 1, false)).toBeNull();
  });
  it('oltre 3 turni del lead la domanda non e\' piu\' in attesa', () => {
    const rows = [out(`x\n\n${DOMANDA_1}`, 0), inn('a', 100), out('b', 110), inn('c', 200), out('d', 210), inn('e', 300), out('f', 310), inn('g', 400)];
    expect(domandaInAttesa(rows, 5, 1, false)).toEqual({ step: 1, continuazione: false }); // terzo turno
    expect(domandaInAttesa(rows, 7, 1, false)).toBeNull(); // quarto turno
  });

  it('conv 26100: il modello rifa la domanda a parole sue, la risposta vera resta della domanda 1', () => {
    const rows = [
      out(`Ok allora facciamo una cosa più semplice…\n\n${DOMANDA_1}`, 0),
      inn('Ok', 35),
      out('Dai Pier, dimmi pure: cosa ti piacerebbe ottenere con un percorso digitale, e perché hai deciso di muoverti proprio adesso?', 47),
      inn('Come dicevo al tuo collega, considerando che oggi si lavoro molto da remoto trovando sbocchi, vorrei capire se fa al caso mio', 124),
    ];
    expect(domandaInAttesa(rows, 3, 1, false)).toEqual({ step: 1, continuazione: false });
  });

  it('conv 28813: la seconda bolla della risposta 1 arriva a ridosso della domanda 2 → seguito, non risposta', () => {
    const rows = [
      out(`Perfetto Giulia…\n\n${DOMANDA_1}`, 0),
      inn('Guarda in realtà è molto semplice, vorrei capire il mondo digitale…', 117),
      out(`Ti capisco benissimo…\n\n${DOMANDA_2}`, 130),
      inn('Proprio adesso perché sono in naspi e ho del tempo da dedicarci', 131),
    ];
    expect(domandaInAttesa(rows, 3, 2, false)).toEqual({ step: 2, continuazione: true });
    // La risposta vera, due minuti dopo, e dopo una domanda del modello: e' della domanda 2.
    const dopo = [
      ...rows,
      out('Ah ok, quindi hai anche un po\' di respiro…', 143),
      out('Decidi tu da sola o ne parli con qualcuno prima?', 145),
      inn('Parlo sempre con qualcuno prima non decido da sola', 293),
    ];
    expect(domandaInAttesa(dopo, 6, 2, false)).toEqual({ step: 2, continuazione: false });
    expect(notaRisposta(2, 'Parlo sempre con qualcuno prima non decido da sola').nota)
      .toBe('⚠️ Decide con: qualcun altro — Riscaldamento – budget e chi decide: «Parlo sempre con qualcuno prima non decido da sola»');
  });

  it('conv 29034: il problema del video non e\' la risposta alla domanda 1', () => {
    const rows = [
      out(`Ciao Denise, prova così…\n\n${DOMANDA_1}`, 0),
      inn('Non funziona, mi esce ancora anche da Chrome', 123),
    ];
    expect(domandaInAttesa(rows, 1, 1, false)).toEqual({ step: 1, continuazione: false });
    expect(parlaDAltro('Non funziona, mi esce ancora anche da Chrome')).toBe(true);
    expect(eRispostaDaNotare({ testo: 'Non funziona, mi esce ancora anche da Chrome', esito: false, passaggio: false, soloPresaDAtto: false, soloConfermaVideo: false })).toBe(false);
    expect(decidiDomanda('in_prompt', 1, turno({ fuoriTema: true }))).toEqual({ domanda: null, salto: 'fuori_tema' });
  });
});

describe('anticipo e domande doppie (PO 29/10/2026)', () => {
  it('senza recap ma col video gia\' mandato le domande possono partire', () => {
    expect(motivoRiscaldamento({ ...base, recapForAt: null })).toBe('no_recap');
    expect(motivoRiscaldamento({ ...base, recapForAt: null, videoSentAt: '2026-10-21T09:00:00+02:00' })).toBe('in_prompt');
  });
  it('domandaNelRecap: solo a riscaldamento non iniziato, call oltre 3 ore, mai su spostamento/annullamento/pausa', () => {
    const ok = { enabled: true, tipo: 'senza-video', step: null, appuntamentoAt: CALL, cancelRequested: false, aiPaused: false, nowMs: NOW };
    expect(domandaNelRecap(ok)).toBe(true);
    expect(domandaNelRecap({ ...ok, step: 0 })).toBe(true);
    expect(domandaNelRecap({ ...ok, enabled: false })).toBe(false);
    expect(domandaNelRecap({ ...ok, step: 1 })).toBe(false);
    expect(domandaNelRecap({ ...ok, tipo: 'spostamento' })).toBe(false);
    expect(domandaNelRecap({ ...ok, cancelRequested: true })).toBe(false);
    expect(domandaNelRecap({ ...ok, aiPaused: true })).toBe(false);
    expect(domandaNelRecap({ ...ok, appuntamentoAt: new Date(NOW + 2 * 3600_000).toISOString() })).toBe(false);
    expect(domandaNelRecap({ ...ok, appuntamentoAt: null })).toBe(false);
  });
  it('la nota al modello vieta solo di rifare la domanda del riscaldamento, non le altre', () => {
    expect(notaDomandaGiaFatta(1)).toContain('perché adesso');
    expect(notaDomandaGiaFatta(2)).toContain('decide da solo');
    expect(notaDomandaGiaFatta(1)).toContain('Non rifarla');
    expect(notaDomandaGiaFatta(1)).toContain('il video');
  });
});

describe('parlaDAltro', () => {
  it.each([
    'Non funziona, mi esce ancora anche da Chrome',
    'Un bunner / Dice riattiva il tuo account',
    'il link non si apre',
    'non riesco a vedere il video',
  ])('"%s" → fuori tema', (t) => expect(parlaDAltro(t)).toBe(true));
  it.each([
    'ho visto il video e vorrei lavorare da remoto',
    'voglio cambiare lavoro perché sono stufa',
    'decido io',
    'non so ancora precisamente cosa voglio ottenere',
  ])('"%s" → e\' una risposta', (t) => expect(parlaDAltro(t)).toBe(false));
});

describe('decideCon', () => {
  it.each([
    ['Essendo sposato e avendo 2 bambini, ovviamente ne devo comunque discutere con mia moglie', ['moglie']],
    ['devo sentire sia dal mio fidanzato che da mia madre', ['fidanzato/a', 'madre']],
    ['ne parlo con mio marito', ['marito']],
    ['decido con i miei genitori', ['genitori']],
    ['Grazie delle informazioni — Ne parlo domani.', []],
    ['ne parlo con un amico', ['qualcun altro']],
    ['No no deciso io', []],
    ['decido io', []],
  ])('"%s" → %j', (t, atteso) => expect(decideCon(t)).toEqual(atteso));
});

describe('notaRisposta: la nota al CRM', () => {
  it('domanda 1 senza segnali brutti', () => {
    expect(notaRisposta(1, 'voglio  cambiare lavoro\nperché sono stufo')).toEqual({
      nota: 'Riscaldamento – obiettivo e perché adesso: «voglio cambiare lavoro perché sono stufo»',
      alert: false,
    });
  });
  it('domanda 2 con segnale brutto → ⚠️ in testa', () => {
    expect(notaRisposta(2, 'Non ho soldi, sono disoccupato')).toEqual({
      nota: '⚠️ Riscaldamento – budget e chi decide: «Non ho soldi, sono disoccupato»',
      alert: true,
    });
  });
  it('decide con qualcuno → "⚠️ Decide con: …" in testa (vince sul ⚠️ semplice)', () => {
    expect(notaRisposta(2, 'Non ho soldi, devo chiedere a mia moglie')).toEqual({
      nota: '⚠️ Decide con: moglie — Riscaldamento – budget e chi decide: «Non ho soldi, devo chiedere a mia moglie»',
      alert: true,
    });
    expect(notaRisposta(2, 'devo sentire sia dal mio fidanzato che da mia madre').nota)
      .toBe('⚠️ Decide con: fidanzato/a, madre — Riscaldamento – budget e chi decide: «devo sentire sia dal mio fidanzato che da mia madre»');
  });
  it('seguito della risposta 1 → "(continua)"', () => {
    expect(notaRisposta(1, 'sono in naspi', { continua: true }).nota).toBe('Riscaldamento – obiettivo e perché adesso (continua): «sono in naspi»');
  });
  it('testo lunghissimo tagliato', () => {
    const { nota } = notaRisposta(1, 'a'.repeat(2000));
    expect(nota.length).toBeLessThan(700);
    expect(nota).toContain('…»');
  });
});

describe('segnaleBrutto', () => {
  it.each([
    'non ho soldi', 'i soldi sono un problema', 'non posso permettermelo', 'quanto costa?',
    'non mi interessa più', 'non ricordo di aver fissato', 'era per curiosità', 'devo chiedere a mio padre',
  ])('"%s" → ⚠️', (t) => {
    expect(segnaleBrutto(t)).toBe(true);
  });
  it.each(['voglio diventare sviluppatore', 'decido io', 'costante impegno', 'ricordo tutto'])('"%s" → niente', (t) => {
    expect(segnaleBrutto(t)).toBe(false);
  });
});

describe('parlaDiDisdireOSpostare', () => {
  it.each(['devo spostare la call', 'posso rimandare?', 'annullo tutto', 'voglio disdire', 'non posso venire', 'ho un imprevisto'])(
    '"%s" → sì', (t) => { expect(parlaDiDisdireOSpostare(t)).toBe(true); },
  );
  it.each(['voglio cambiare lavoro', 'decido io', 'ok grazie'])('"%s" → no', (t) => {
    expect(parlaDiDisdireOSpostare(t)).toBe(false);
  });
});

describe('eRispostaDaNotare', () => {
  const r = { testo: 'voglio cambiare lavoro', esito: false, passaggio: false, soloPresaDAtto: false, soloConfermaVideo: false };
  it('risposta vera → sì', () => { expect(eRispostaDaNotare(r)).toBe(true); });
  it.each([
    ['testo vuoto', { testo: ' ' }],
    ['esito', { esito: true }],
    ['passaggio', { passaggio: true }],
    ['solo ok', { soloPresaDAtto: true }],
    ['solo fatto', { soloConfermaVideo: true }],
    ['disdetta', { testo: 'devo annullare' }],
  ] as const)('%s → no', (_, over) => {
    expect(eRispostaDaNotare({ ...r, ...over })).toBe(false);
  });
});

describe('difetti del 30/10/2026', () => {
  it.each([
    ['Si decide sempre insieme', ['qualcun altro']],
    ['Insieme', ['qualcun altro']],
    ['insieme ovviamente', ['qualcun altro']],
    ['la scelta la facciamo insieme in famiglia', ['famiglia']],
    ['valutiamo insieme', ['qualcun altro']],
  ])('1. "insieme" da solo: "%s" → %j', (t, atteso) => expect(decideCon(t)).toEqual(atteso));
  it.each([
    'devo mettere insieme i soldi per il corso ma decido io',
    'vorrei un lavoro dove stare insieme alla mia gente di più e guadagnare meglio',
    'decido io',
  ])('1. niente falso positivo: "%s"', (t) => expect(decideCon(t)).toEqual([]));

  it.each(['non posso acquistare adesso', 'Purtroppo non posso comprare il corso', 'non riesco a comprarlo'])(
    '2. "%s" → ⚠️', (t) => expect(segnaleBrutto(t)).toBe(true),
  );

  it.each([
    'È possibile anticipare la chiamata alle 20?',
    "le chiedo di cancellare l'appuntamento",
    'non sono interessato',
    'Non sono più interessata',
    'possiamo anticiparla?',
  ])('3. "%s" → disdire/spostare, non risposta', (t) => {
    expect(parlaDiDisdireOSpostare(t)).toBe(true);
    expect(eRispostaDaNotare({ testo: t, esito: false, passaggio: false, soloPresaDAtto: false, soloConfermaVideo: false })).toBe(false);
  });
  it.each(['posso dare un anticipo e poi a rate', 'pago in anticipo'])('3. "%s" resta una risposta', (t) => {
    expect(parlaDiDisdireOSpostare(t)).toBe(false);
  });

  it('4. la risposta arrivata durante il turno entra nella nota', () => {
    const testo = testoRispostaCompleto('Fatto', ['Comunque la risposta alla domanda è semplice: guadagnare di più nel breve periodo']);
    expect(testo).toBe('Fatto / Comunque la risposta alla domanda è semplice: guadagnare di più nel breve periodo');
    expect(eRispostaDaNotare({ testo, esito: false, passaggio: false, soloPresaDAtto: false, soloConfermaVideo: false })).toBe(true);
    expect(testoRispostaCompleto('ok', [])).toBe('ok');
    expect(testoRispostaCompleto('', ['  ', 'voglio cambiare'])).toBe('voglio cambiare');
  });

  it('5. la nota al modello dice di non insistere su ok/emoji', () => {
    expect(notaDomandaGiaFatta(2)).toContain('non chiedergli di rispondere');
  });
  it('5. la domanda 2 rifatta dal modello si toglie (conv 29566)', () => {
    const r = togliDomandaRifatta('Fausto, mi serve una risposta su questo: decidi da solo o ti confronti con qualcuno prima di partire col percorso?', 2);
    expect(r).toEqual({ testo: '', tolta: true });
  });
  it('5. si toglie solo la frase che rifà la domanda', () => {
    const r = togliDomandaRifatta('Perfetto, a lunedì allora! Ma alla call decidi tu o insieme a qualcuno?', 2);
    expect(r).toEqual({ testo: 'Perfetto, a lunedì allora!', tolta: true });
    const r1 = togliDomandaRifatta('Grazie! E cosa vorresti ottenere con il percorso?\nCi sentiamo lunedì.', 1);
    expect(r1).toEqual({ testo: 'Grazie!\nCi sentiamo lunedì.', tolta: true });
  });
  it('5. una risposta normale resta intatta', () => {
    const t = 'Perfetto Fausto, ci sentiamo lunedì 🙂 Hai già visto il video?';
    expect(togliDomandaRifatta(t, 2)).toEqual({ testo: t, tolta: false });
    expect(togliDomandaRifatta('Il percorso costa da 1.000 a 3.000 euro, come ti dicevo.', 2).tolta).toBe(false);
  });

  it.each(['avrei anche dei soldi in più', 'i soldi ci sono', 'ho dei soldi da parte', 'i soldi non sono un problema'])(
    '6. "%s" → niente ⚠️', (t) => expect(segnaleBrutto(t)).toBe(false),
  );
  it.each(['non ho soldi', 'non ho abbastanza soldi', 'ho pochi soldi', 'i soldi sono un problema', 'e i soldi?', 'soldi non ne ho'])(
    '6. "%s" → ⚠️', (t) => expect(segnaleBrutto(t)).toBe(true),
  );
});
