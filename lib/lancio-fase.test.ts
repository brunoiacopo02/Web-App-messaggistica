import { describe, it, expect } from 'vitest';
import {
  LANCIO_SLUG, LANCIO_FASI, LANCIO_FASI_TERMINALI, FILTRO_FUORI_LANCIO, MAX_SCAMBI_DOMANDE,
  TESTO_POSTO_BLOCCATO, TESTO_CONGEDO, TESTO_CHIUSURA_DOMANDE, TESTO_PASSAGGIO_UMANO,
  isLancioFase, lancioInCorso, decideLancioTurno, contaScambiDomande, lancioFaseLabel, lancioBenvenutoText,
  inboundDelLotto, ultimoTestoDelLotto, haCongedo,
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
  const base = { fase: 'attesa', scambiDomande: 0, passToHuman: false } as const;

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
  it('la richiesta di una persona vince su tutto', () => {
    expect(decideLancioTurno({ ...base, classe: 'si', passToHuman: true })).toEqual({ kind: 'passaggio_umano' });
  });
});

describe('decideLancioTurno — fase posto_bloccato', () => {
  const base = { fase: 'posto_bloccato', scambiDomande: 0, passToHuman: false } as const;
  it('un secondo sì non riceve un secondo "posto bloccato"', () => {
    expect(decideLancioTurno({ ...base, classe: 'si' })).toEqual({ kind: 'silenzio', motivo: 'gia_bloccato' });
  });
  it('le domande si rispondono ancora, col solito tetto', () => {
    expect(decideLancioTurno({ ...base, classe: 'domanda' })).toEqual({ kind: 'domanda', chiudi: false });
    expect(decideLancioTurno({ ...base, classe: 'domanda', scambiDomande: 3 }).kind).toBe('silenzio');
  });
  it('un no dopo il posto bloccato è comunque un congedo', () => {
    expect(decideLancioTurno({ ...base, classe: 'no' }).kind).toBe('congedo');
  });
});

describe('decideLancioTurno — fasi che B1 non gestisce', () => {
  it('link_inviato, post_pitch ecc. sono di B4/B5: qui silenzio, mai il pitch di Mario', () => {
    for (const fase of ['link_inviato', 'post_pitch', 'scelta_fatta', 'followup_inviato']) {
      expect(decideLancioTurno({ fase, classe: 'domanda', scambiDomande: 0, passToHuman: false }))
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
