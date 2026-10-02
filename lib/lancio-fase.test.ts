import { describe, it, expect } from 'vitest';
import {
  LANCIO_SLUG, LANCIO_FASI, LANCIO_FASI_TERMINALI, FILTRO_FUORI_LANCIO, MAX_SCAMBI_DOMANDE,
  TESTO_POSTO_BLOCCATO, TESTO_CONGEDO, TESTO_CHIUSURA_DOMANDE, TESTO_PASSAGGIO_UMANO,
  isLancioFase, lancioInCorso, decideLancioTurno, contaScambiDomande, lancioFaseLabel, lancioBenvenutoText,
  inboundDelLotto, ultimoTestoDelLotto, haCongedo, pulsanteRiportaInPostPitch, pulsantePrendeChat,
  colonnePresaPulsante, serveNotaRestituzione, NOTA_RESTITUZIONE_OGNI_MS, lancioRestituito,
  tagliaRigheDalLancio, lancioRipartePerRiarruolamento, LANCIO_FASE_RIPARTE_AL_RIARRUOLAMENTO,
  linkSviluppatoreEntraNelLancio, registrazionePromessa,
  TESTO_REGISTRAZIONE_PROMESSA, TESTO_REGISTRAZIONE_PROMESSA_STASERA,
  congedoInPiedi, congedoRevocato, faseDopoRevocaCongedo, notaCongedoRevocato,
} from './lancio-fase';

describe('costanti della spec §3.2 / §5.2', () => {
  it('slug e fasi con i nomi esatti', () => {
    expect(LANCIO_SLUG).toBe('webdev-2026-10');
    expect([...LANCIO_FASI]).toEqual([
      'attesa', 'posto_bloccato', 'link_inviato', 'post_pitch', 'scelta_fatta', 'followup_inviato', 'restituito', 'chiuso',
    ]);
    expect(isLancioFase('attesa')).toBe(true);
    expect(isLancioFase('boh')).toBe(false);
  });

  it('il testo del posto bloccato è quello della spec, verbatim', () => {
    expect(TESTO_POSTO_BLOCCATO).toBe('Perfetto, il tuo posto è bloccato. Ti scrivo qui il 5 ottobre con il link per collegarti.');
  });

  it('i testi fissi non contengono link, prezzi o inviti a una call', () => {
    for (const t of [TESTO_POSTO_BLOCCATO, TESTO_CONGEDO, TESTO_CHIUSURA_DOMANDE, TESTO_PASSAGGIO_UMANO]) {
      expect(t).not.toMatch(/https?:\/\//);
      expect(t).not.toMatch(/€|euro|call|videochiamata|appuntamento/i);
    }
  });
});

describe('lancioInCorso — quando la chat è del lancio e va tenuta fuori da Mario', () => {
  it('senza slug non è del lancio', () => {
    expect(lancioInCorso({ lancio_slug: null, lancio_fase: null })).toBe(false);
    expect(lancioInCorso({})).toBe(false);
  });
  it('con slug e fase non terminale è in corso', () => {
    for (const fase of ['attesa', 'posto_bloccato', 'link_inviato', 'post_pitch', 'scelta_fatta', 'followup_inviato']) {
      expect(lancioInCorso({ lancio_slug: LANCIO_SLUG, lancio_fase: fase })).toBe(true);
    }
  });
  it('chiuso e restituito rendono la chat di nuovo di Mario (o del GDO)', () => {
    for (const fase of LANCIO_FASI_TERMINALI) {
      expect(lancioInCorso({ lancio_slug: LANCIO_SLUG, lancio_fase: fase })).toBe(false);
    }
  });
  it('il filtro PostgREST dice la stessa cosa al contrario', () => {
    expect(FILTRO_FUORI_LANCIO).toBe('lancio_slug.is.null,lancio_fase.in.(chiuso,restituito)');
  });
});

describe('decideLancioTurno — fase attesa', () => {
  const base = { fase: 'attesa', scambiDomande: 0 } as const;

  it('sì → posto bloccato col testo fisso', () => {
    expect(decideLancioTurno({ ...base, classe: 'si' })).toEqual({ kind: 'posto_bloccato', testo: TESTO_POSTO_BLOCCATO });
  });
  it('no → congedo col testo fisso', () => {
    expect(decideLancioTurno({ ...base, classe: 'no' })).toEqual({ kind: 'congedo', testo: TESTO_CONGEDO });
  });
  it('domanda → risponde il modello, senza chiudere', () => {
    expect(decideLancioTurno({ ...base, classe: 'domanda' })).toEqual({ kind: 'domanda', chiudi: false });
  });
  it('al terzo scambio di domande risponde e chiude con "ci sentiamo il 5"', () => {
    expect(decideLancioTurno({ ...base, classe: 'domanda', scambiDomande: MAX_SCAMBI_DOMANDE - 1 }))
      .toEqual({ kind: 'domanda', chiudi: true });
  });
  it('dopo tre scambi tace fino al link', () => {
    expect(decideLancioTurno({ ...base, classe: 'domanda', scambiDomande: MAX_SCAMBI_DOMANDE }))
      .toEqual({ kind: 'silenzio', motivo: 'domande_esaurite' });
  });
  it('incerto senza modello → silenzio, mai una risposta a caso', () => {
    expect(decideLancioTurno({ ...base, classe: 'incerto' })).toEqual({ kind: 'silenzio', motivo: 'classe_incerta' });
  });
});

describe('decideLancioTurno — fase posto_bloccato', () => {
  const base = { fase: 'posto_bloccato', scambiDomande: 0 } as const;
  it('un secondo sì non riceve un secondo "posto bloccato"', () => {
    expect(decideLancioTurno({ ...base, classe: 'si' })).toEqual({ kind: 'silenzio', motivo: 'gia_bloccato' });
  });
  it('le domande si rispondono ancora, col solito tetto', () => {
    expect(decideLancioTurno({ ...base, classe: 'domanda' })).toEqual({ kind: 'domanda', chiudi: false });
    expect(decideLancioTurno({ ...base, classe: 'domanda', scambiDomande: 3 }).kind).toBe('domanda');
    expect(decideLancioTurno({ ...base, classe: 'domanda', scambiDomande: MAX_SCAMBI_DOMANDE }).kind).toBe('silenzio');
  });
  it('un no dopo il posto bloccato è comunque un congedo', () => {
    expect(decideLancioTurno({ ...base, classe: 'no' }).kind).toBe('congedo');
  });
});

describe('decideLancioTurno — chi non può esserci: la registrazione (PO 01/10/2026)', () => {
  it('la prima volta → la frase fissa della promessa, mai un congedo', () => {
    expect(decideLancioTurno({ fase: 'attesa', classe: 'registrazione', scambiDomande: 0 }))
      .toEqual({ kind: 'registrazione', testo: TESTO_REGISTRAZIONE_PROMESSA });
    expect(TESTO_REGISTRAZIONE_PROMESSA).toBe('Nessun problema: dopo la live ti mandiamo qui la registrazione, così la guardi quando vuoi.');
  });
  it('vale anche in posto_bloccato', () => {
    expect(decideLancioTurno({ fase: 'posto_bloccato', classe: 'registrazione', scambiDomande: 0 }).kind).toBe('registrazione');
  });
  it('già promessa → è una domanda: risponde il modello, col solito tetto', () => {
    expect(decideLancioTurno({ fase: 'attesa', classe: 'registrazione', scambiDomande: 0, registrazionePromessa: true }))
      .toEqual({ kind: 'domanda', chiudi: false });
    expect(decideLancioTurno({ fase: 'attesa', classe: 'registrazione', scambiDomande: MAX_SCAMBI_DOMANDE, registrazionePromessa: true }))
      .toEqual({ kind: 'silenzio', motivo: 'domande_esaurite' });
  });
  it('fuori da attesa/posto_bloccato resta silenzio: in assistenza decide il suo turno', () => {
    expect(decideLancioTurno({ fase: 'link_inviato', classe: 'registrazione', scambiDomande: 0 }).kind).toBe('silenzio');
  });
  it('le frasi della promessa non contano come scambi di domande', () => {
    const out = (body: string) => ({ direction: 'out', body, template_sid: null });
    expect(contaScambiDomande([out(TESTO_REGISTRAZIONE_PROMESSA), out(TESTO_REGISTRAZIONE_PROMESSA_STASERA)])).toBe(0);
  });
  it('registrazionePromessa legge il marcatore di lancio_info', () => {
    expect(registrazionePromessa({ registrazione_promessa_at: '2026-10-01T10:00:00.000Z' })).toBe(true);
    expect(registrazionePromessa({ congedo_at: 'x' })).toBe(false);
    expect(registrazionePromessa({ registrazione_promessa_at: '' })).toBe(false);
    expect(registrazionePromessa(null)).toBe(false);
    expect(registrazionePromessa([])).toBe(false);
  });
});

describe('decideLancioTurno — fasi che B1 non gestisce', () => {
  it('link_inviato, post_pitch ecc. sono di B4/B5: qui silenzio, mai il pitch di Mario', () => {
    for (const fase of ['link_inviato', 'post_pitch', 'scelta_fatta', 'followup_inviato']) {
      expect(decideLancioTurno({ fase, classe: 'domanda', scambiDomande: 0 }))
        .toEqual({ kind: 'silenzio', motivo: 'fase_non_gestita' });
    }
  });
});

describe('contaScambiDomande — quante risposte a domande sono già uscite', () => {
  const out = (body: string, template_sid: string | null = null) => ({ direction: 'out', body, template_sid });
  const inb = (body: string) => ({ direction: 'in', body, template_sid: null });

  it('il benvenuto (template) e i testi fissi non contano', () => {
    expect(contaScambiDomande([
      out('Ciao Anna, sono l\'assistente...', 'HX_WELCOME'),
      inb('si'),
      out(TESTO_POSTO_BLOCCATO),
    ])).toBe(0);
  });
  it('ogni risposta libera del bot vale uno scambio', () => {
    expect(contaScambiDomande([
      out('benvenuto', 'HX_WELCOME'),
      inb('è a pagamento?'), out('No, è gratuita.'),
      inb('a che ora?'), out('Alle 21, il link ti arriva qui.'),
    ])).toBe(2);
  });
  it('la risposta con la chiusura in coda conta uno, non due', () => {
    expect(contaScambiDomande([out(`Sì, su Zoom.\n${TESTO_CHIUSURA_DOMANDE}`)])).toBe(1);
  });
  it('body nullo (media) non conta', () => {
    expect(contaScambiDomande([{ direction: 'out', body: null, template_sid: null }])).toBe(0);
  });
});

describe('etichette e benvenuto', () => {
  it("lancioFaseLabel ha un'etichetta per ogni fase e un ripiego", () => {
    for (const f of LANCIO_FASI) expect(lancioFaseLabel(f)).not.toBe('');
    expect(lancioFaseLabel('attesa')).toBe('In attesa');
    expect(lancioFaseLabel('posto_bloccato')).toBe('Posto bloccato');
    expect(lancioFaseLabel(null)).toBe('Lancio');
  });
  it('lancioBenvenutoText usa il solo nome proprio e il vocativo neutro senza nome', () => {
    expect(lancioBenvenutoText('ANNA BIANCHI')).toMatch(/^Ciao Anna, sono l'assistente virtuale di Fenice Academy\./);
    expect(lancioBenvenutoText(null)).toMatch(/^Ciao a te, /);
    expect(lancioBenvenutoText('Anna')).toContain('per bloccare il posto.');
  });
});

describe('il lotto a cui risponde il turno', () => {
  const i = (body: string | null) => ({ direction: 'in', body, template_sid: null });
  const o = (body: string) => ({ direction: 'out', body, template_sid: null });

  it('sono i messaggi del lead dopo l ultima bolla nostra, tutti', () => {
    expect(inboundDelLotto([o('benvenuto'), i('ok'), o('posto bloccato'), i('aspetta'), i('no grazie')]))
      .toEqual([i('aspetta'), i('no grazie')]);
  });
  it('senza outbound in cronologia il lotto e tutta la chat del lead', () => {
    expect(inboundDelLotto([i('ciao'), i('ci sono')])).toHaveLength(2);
  });
  it('nessun messaggio dopo l ultima bolla: lotto vuoto (inbound fuori lancio)', () => {
    expect(inboundDelLotto([i('si'), o('benvenuto')])).toEqual([]);
  });

  it('si classifica sull ultimo che abbia del testo, non sul primo', () => {
    expect(ultimoTestoDelLotto([i(''), i('si')])).toBe('si');
    expect(ultimoTestoDelLotto([i('ok'), i('no grazie')])).toBe('no grazie');
  });
  it('un lotto di soli media non ha testo: il turno tace', () => {
    expect(ultimoTestoDelLotto([i(''), i(null), i('   ')])).toBe('');
    expect(ultimoTestoDelLotto([])).toBe('');
  });
});

describe('haCongedo — il marcatore durevole', () => {
  it('vero solo con un congedo_at valorizzato', () => {
    expect(haCongedo({ congedo_at: '2026-09-21T10:00:00Z' })).toBe(true);
    expect(haCongedo({ congedo_at: '2026-09-21T10:00:00Z', risposta1: 'x' })).toBe(true);
  });
  it('falso su tutto il resto, senza mai lanciare', () => {
    expect(haCongedo(null)).toBe(false);
    expect(haCongedo(undefined)).toBe(false);
    expect(haCongedo({})).toBe(false);
    expect(haCongedo({ congedo_at: '' })).toBe(false);
    expect(haCongedo({ congedo_at: 123 })).toBe(false);
    expect(haCongedo([{ congedo_at: 'x' }])).toBe(false);
    expect(haCongedo('congedo_at')).toBe(false);
  });
});

describe('pulsanteRiportaInPostPitch — la sera il pulsante porta al dopo-pitch da ogni fase (PO 02/10)', () => {
  it('riporta a post_pitch dal prima-e-durante, e anche da followup_inviato, chiuso e restituito', () => {
    for (const fase of ['attesa', 'posto_bloccato', 'link_inviato', 'followup_inviato', 'chiuso', 'restituito']) {
      expect(pulsanteRiportaInPostPitch(fase)).toBe(true);
    }
  });

  it('una chat senza fase (mai stata nel lancio) entra nel dopo-pitch', () => {
    expect(pulsanteRiportaInPostPitch(null)).toBe(true);
    expect(pulsanteRiportaInPostPitch(undefined)).toBe(true);
    expect(pulsanteRiportaInPostPitch('')).toBe(true);
  });

  it('non riscrive post_pitch (c e gia) ne scelta_fatta (ha gia scelto, ce l ha il CRM)', () => {
    expect(pulsanteRiportaInPostPitch('post_pitch')).toBe(false);
    expect(pulsanteRiportaInPostPitch('scelta_fatta')).toBe(false);
  });

  it('una fase illeggibile va nel dopo-pitch: una chat presa non resta fuori da tutti i turni', () => {
    expect(pulsanteRiportaInPostPitch('boh')).toBe(true);
  });
});

describe('pulsantePrendeChat — il pulsante prende la chat in ogni caso (PO 02/10)', () => {
  it('pulsante che vale e bot acceso: prende, chiunque avesse la chat', () => {
    expect(pulsantePrendeChat({ pulsanteVale: true, autoReplyOn: true })).toEqual({ prende: true });
  });

  it('pulsante che non vale: orfano, pulsante_spento — e viene prima del bot spento', () => {
    expect(pulsantePrendeChat({ pulsanteVale: false, autoReplyOn: true }))
      .toEqual({ prende: false, motivo: 'pulsante_spento' });
    expect(pulsantePrendeChat({ pulsanteVale: false, autoReplyOn: false }))
      .toEqual({ prende: false, motivo: 'pulsante_spento' });
  });

  it('bot spento (freno d emergenza): orfano, bot_spento', () => {
    expect(pulsantePrendeChat({ pulsanteVale: true, autoReplyOn: false }))
      .toEqual({ prende: false, motivo: 'bot_spento' });
  });
});

describe('colonnePresaPulsante — Mario, attiva, nessun fermo, nessun passaggio', () => {
  const ADESSO = Date.parse('2026-10-05T21:30:00.000Z');

  it('chat di un altro padrone, senza ai_started_at: tutto azzerato, owner mario, partenza 5 minuti indietro', () => {
    expect(colonnePresaPulsante({ aiOwner: 'marta', aiStartedAt: null }, ADESSO)).toEqual({
      ai_status: 'active', ai_paused_at: null, handed_off_at: null, handed_off_reason: null,
      ai_owner: 'mario', ai_started_at: '2026-10-05T21:25:00.000Z',
    });
  });

  it('ai_started_at gia valorizzato: non si tocca, la cronologia di prima serve al modello', () => {
    const c = colonnePresaPulsante({ aiOwner: 'mario', aiStartedAt: '2026-09-20T10:00:00Z' }, ADESSO);
    expect(c).not.toHaveProperty('ai_started_at');
    expect(c.ai_owner).toBe('mario');
  });

  it('chat senza padrone: ai_owner non si scrive, la prende l adozione col suo compare-and-set', () => {
    const c = colonnePresaPulsante({ aiOwner: null, aiStartedAt: null }, ADESSO);
    expect(c).not.toHaveProperty('ai_owner');
    expect(c).toMatchObject({ ai_status: 'active', ai_paused_at: null, handed_off_at: null });
  });
});

describe('tagliaRigheDalLancio: il taglio sull ancora confronta ISTANTI, non stringhe', () => {
  // Le righe e l'ancora arrivano da colonne diverse: `...Z` contro `...+00:00`,
  // microsecondi contro millisecondi. Confrontate come testo, `2026-10-05T19:59:59+00:00`
  // risulta DOPO `2026-10-05T20:00:00Z` (il '+' viene prima delle cifre) e il taglio si
  // tirerebbe dietro il giro precedente di Mario.
  const riga = (created_at: string, body: string) => ({ direction: 'in', body, template_sid: null, created_at });

  it('formati misti: si taglia dove dice l orologio, e l ancora resta inclusa', () => {
    const rows = [
      riga('2026-10-05T19:59:59+00:00', 'vecchio giro di Mario'),
      riga('2026-10-05T20:00:00.000000Z', 'esattamente sull ancora'),
      riga('2026-10-05T22:30:00+02:00', 'dopo (20:30 UTC)'),
    ];
    expect(tagliaRigheDalLancio(rows, null, '2026-10-05T20:00:00Z').map((r) => r.body)).toEqual([
      'esattamente sull ancora',
      'dopo (20:30 UTC)',
    ]);
  });

  it('una data illeggibile non fa sparire la riga: si torna al confronto di prima', () => {
    const rows = [riga('data-strana', 'illeggibile'), riga('2026-10-05T21:00:00Z', 'dopo')];
    expect(tagliaRigheDalLancio(rows, null, '2026-10-05T20:00:00Z').map((r) => r.body)).toEqual(['illeggibile', 'dopo']);
  });
});

describe('serveNotaRestituzione — una nota al CRM ogni ora per chat (C8)', () => {
  const ADESSO = Date.parse('2026-10-09T10:00:00.000Z');
  it('mai avvisato: si', () => {
    expect(serveNotaRestituzione(null, ADESSO)).toBe(true);
    expect(serveNotaRestituzione({ risposta_riscaldamento: 'si' }, ADESSO)).toBe(true);
  });
  it('avvisato da meno di un ora: no', () => {
    expect(serveNotaRestituzione({ restituito_nota_at: '2026-10-09T09:30:00.000Z' }, ADESSO)).toBe(false);
  });
  it('avvisato da piu di un ora: si', () => {
    expect(serveNotaRestituzione({ restituito_nota_at: '2026-10-09T08:59:00.000Z' }, ADESSO)).toBe(true);
  });
  it('marcatore illeggibile: si avvisa (meglio una campanella in piu che un silenzio)', () => {
    expect(serveNotaRestituzione({ restituito_nota_at: 'ieri' }, ADESSO)).toBe(true);
    expect(serveNotaRestituzione({ restituito_nota_at: 42 }, ADESSO)).toBe(true);
  });
  it('la finestra e un ora esatta', () => {
    expect(NOTA_RESTITUZIONE_OGNI_MS).toBe(60 * 60 * 1000);
  });
});

describe('lancioRestituito — il veto al re-drive di bot-followups (C8, difesa in profondita)', () => {
  it('vero solo sulla fase restituito', () => {
    expect(lancioRestituito({ lancio_fase: 'restituito' })).toBe(true);
    for (const fase of ['attesa', 'posto_bloccato', 'link_inviato', 'post_pitch', 'scelta_fatta', 'followup_inviato', 'chiuso']) {
      expect(lancioRestituito({ lancio_fase: fase })).toBe(false);
    }
  });
  it('una chat che nel lancio non c e mai entrata non e restituita', () => {
    expect(lancioRestituito({ lancio_fase: null })).toBe(false);
    expect(lancioRestituito({})).toBe(false);
  });
  it('lancioInCorso NON basta come guardia: su restituito e gia falso', () => {
    // E' il motivo per cui la guardia serve: al blocco 2a-bis del cron una chat
    // restituita non e' "in corso", ma il re-drive sta PRIMA di quel blocco.
    const c = { lancio_slug: LANCIO_SLUG, lancio_fase: 'restituito' };
    expect(lancioInCorso(c)).toBe(false);
    expect(lancioRestituito(c)).toBe(true);
  });
});

describe('lancioRipartePerRiarruolamento — chi riparte e chi si preserva', () => {
  // Decisione del PO (19/09/2026): "se uno dice no e poi si registra per il lancio deve
  // ripartire". Iscriversi di nuovo e' un atto nuovo di interesse e vale piu' del no.
  it('le fasi terminali ripartono', () => {
    for (const fase of LANCIO_FASI_TERMINALI) expect(lancioRipartePerRiarruolamento(fase)).toBe(true);
  });

  it("chi e' a meta' percorso si preserva: e' il bug del 19/09", () => {
    for (const fase of LANCIO_FASI.filter((f) => !LANCIO_FASI_TERMINALI.includes(f))) {
      expect(lancioRipartePerRiarruolamento(fase)).toBe(false);
    }
  });

  // Riga anomala: con lo slug scritto e la fase illeggibile non c'e' nessun avanzamento
  // da proteggere, e lasciarla com'e' vorrebbe dire una chat fuori da tutti i cron.
  it('fase nulla o sconosciuta riparte', () => {
    expect(lancioRipartePerRiarruolamento(null)).toBe(true);
    expect(lancioRipartePerRiarruolamento(undefined)).toBe(true);
    expect(lancioRipartePerRiarruolamento('fase_che_non_esiste')).toBe(true);
  });

  // La mappa e' esaustiva per costruzione (Record<LancioFase, boolean>): questo test e'
  // la rete se qualcuno la allarga a `Partial` per far compilare una fase nuova.
  it('ogni fase del lancio ha una voce decisa', () => {
    for (const fase of LANCIO_FASI) expect(typeof LANCIO_FASE_RIPARTE_AL_RIARRUOLAMENTO[fase]).toBe('boolean');
  });
});

describe('linkSviluppatoreEntraNelLancio — il link "Sviluppatore AI" porta la chat nel lancio (PO 24/09)', () => {
  const libera = { lancioSlug: null, aiOwner: 'mario', aiPausedAt: null, handedOffAt: null };
  it('si su una chat di Mario libera mai entrata nel lancio (appena adottata o gia sua)', () => {
    expect(linkSviluppatoreEntraNelLancio(libera)).toBe(true);
  });
  it('no su una chat gia nel lancio, in qualunque fase: la gestisce gia il lancio (o e del GDO)', () => {
    expect(linkSviluppatoreEntraNelLancio({ ...libera, lancioSlug: 'webdev-2026-10' })).toBe(false);
  });
  it('no se la chat non e di Mario, e in pausa o passata a una persona', () => {
    expect(linkSviluppatoreEntraNelLancio({ ...libera, aiOwner: null })).toBe(false);
    expect(linkSviluppatoreEntraNelLancio({ ...libera, aiOwner: 'gdo' })).toBe(false);
    expect(linkSviluppatoreEntraNelLancio({ ...libera, aiPausedAt: '2026-10-06T10:00:00Z' })).toBe(false);
    expect(linkSviluppatoreEntraNelLancio({ ...libera, handedOffAt: '2026-10-06T10:00:00Z' })).toBe(false);
  });
});

describe('dopo la notte del webinar (PO 25/09)', () => {
  it('pulsantePassaAMario: da ogni fase, chiuso followup_inviato e restituito compresi; non da scelta_fatta (PO 02/10)', async () => {
    const { pulsantePassaAMario } = await import('./lancio-fase');
    for (const f of [null, '', 'attesa', 'posto_bloccato', 'link_inviato', 'post_pitch', 'chiuso', 'followup_inviato', 'restituito']) {
      expect(pulsantePassaAMario(f)).toBe(true);
    }
    expect(pulsantePassaAMario('scelta_fatta')).toBe(false);
  });

  it('conMarioDopoNotte tiene quello che c era; marioDopoNotte lo rilegge e scarta le forme sporche', async () => {
    const { conMarioDopoNotte, marioDopoNotte, risposteRiscaldamento } = await import('./lancio-fase');
    const info = conMarioDopoNotte({ risposte: ['a', 'b'], slotsMostratiAt: 'x' }, 'post_pitch', '2026-10-06T08:00:00Z');
    expect(info).toEqual({ risposte: ['a', 'b'], slotsMostratiAt: 'x', mario_dopo_notte: { da: 'post_pitch', at: '2026-10-06T08:00:00Z' } });
    expect(marioDopoNotte(info)).toEqual({ da: 'post_pitch', at: '2026-10-06T08:00:00Z' });
    expect(conMarioDopoNotte(null, 'pulsante', 't')).toEqual({ mario_dopo_notte: { da: 'pulsante', at: 't' } });
    expect(marioDopoNotte(null)).toBeNull();
    expect(marioDopoNotte({ mario_dopo_notte: { da: 'boh', at: 't' } })).toBeNull();
    expect(marioDopoNotte({ mario_dopo_notte: 'si' })).toBeNull();
    expect(risposteRiscaldamento(info)).toEqual(['a', 'b']);
    expect(risposteRiscaldamento({ risposte: ['ok', 3, ' '] })).toEqual(['ok']);
    expect(risposteRiscaldamento(null)).toEqual([]);
  });
});

// Piano 2026-10-01, Task 3: il congedo sciolto dal webhook quando il lead riscrive.
describe('congedo sciolto', () => {
  const out = (body: string) => ({ direction: 'out', body, template_sid: null });
  const inb = (body: string) => ({ direction: 'in', body, template_sid: null });
  const righe = [inb('non mi interessa'), out(TESTO_CONGEDO), inb('Vorrei sapere del percorso')];

  it('congedoInPiedi: la frase in cronologia non basta piu se il congedo e stato sciolto', () => {
    expect(congedoInPiedi(righe, { congedo_at: 'x' })).toBe(true);
    // marcatore non scritto (lettura fallita al congedo): vale la cronologia, come prima
    expect(congedoInPiedi(righe, null)).toBe(true);
    expect(congedoInPiedi(righe, { congedo_revocato_at: '2026-10-01T10:00:00Z' })).toBe(false);
    // sciolto e poi congedato di nuovo: vale il congedo nuovo
    expect(congedoInPiedi(righe, { congedo_revocato_at: 'x', congedo_at: 'y' })).toBe(true);
    expect(congedoInPiedi([inb('ciao')], { congedo_at: 'x' })).toBe(false);
  });

  it('congedoRevocato legge il marcatore', () => {
    expect(congedoRevocato({ congedo_revocato_at: '2026-10-01T10:00:00Z' })).toBe(true);
    expect(congedoRevocato({ congedo_at: 'x' })).toBe(false);
    expect(congedoRevocato(null)).toBe(false);
  });

  it('faseDopoRevocaCongedo: attesa prima della live, chiuso dall ora della live o senza data', () => {
    const evento = '2026-10-05T21:00:00+02:00';
    expect(faseDopoRevocaCongedo(new Date('2026-10-01T10:00:00+02:00'), evento)).toBe('attesa');
    expect(faseDopoRevocaCongedo(new Date('2026-10-05T21:00:00+02:00'), evento)).toBe('chiuso');
    expect(faseDopoRevocaCongedo(new Date('2026-10-06T10:00:00+02:00'), evento)).toBe('chiuso');
    expect(faseDopoRevocaCongedo(new Date('2026-10-01T10:00:00+02:00'), null)).toBe('chiuso');
    expect(faseDopoRevocaCongedo(new Date('2026-10-01T10:00:00+02:00'), 'non una data')).toBe('chiuso');
  });

  it('notaCongedoRevocato: la frase del PO con le parole del lead, tagliate a 300', () => {
    expect(notaCongedoRevocato('  Vorrei sapere del percorso ')).toBe(
      'Lancio Web Dev AI: aveva detto di no, poi ha riscritto ("Vorrei sapere del percorso"): il bot ha ripreso la conversazione.',
    );
    expect(notaCongedoRevocato('x'.repeat(500))).toContain(`("${'x'.repeat(300)}")`);
  });
});

describe('decideLancioTurno — classe altro (Task 5)', () => {
  it('nelle fasi del B1 passa al postino, fuori tace come sempre', () => {
    expect(decideLancioTurno({ fase: 'attesa', classe: 'altro', scambiDomande: 0 })).toEqual({ kind: 'al_postino' });
    expect(decideLancioTurno({ fase: 'posto_bloccato', classe: 'altro', scambiDomande: 0 })).toEqual({ kind: 'al_postino' });
    expect(decideLancioTurno({ fase: 'link_inviato', classe: 'altro', scambiDomande: 0 }).kind).toBe('silenzio');
  });
});
