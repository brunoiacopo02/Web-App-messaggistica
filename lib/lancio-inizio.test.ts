import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  inFinestraInizio,
  finestraInizioChiusa,
  runRimasti,
  dimensioneLotto,
  haScrittoDopoBenvenuto,
  idoneoAllInizio,
  linkZoomTroppoRecente,
  ordinaCandidatiInizio,
  scegliLottoInizio,
  inizioBody,
  type CandidatoInizio,
} from './lancio-inizio';

// L'evento del 5/10 alle 21:00 di Roma (CEST, UTC+2) = 19:00 UTC.
const EVENTO = new Date('2026-10-05T19:00:00Z');
const roma = (hhmm: string, ss = '00') => new Date(`2026-10-05T${hhmm}:${ss}+02:00`);

const BENVENUTO = '2026-10-01T10:00:00Z';
const cand = (over: Partial<CandidatoInizio> & { id?: number } = {}): CandidatoInizio & { id: number } => ({
  id: 1,
  lancio_slug: 'webdev-2026-10',
  lancio_fase: 'posto_bloccato',
  lancio_info: null,
  lancio_benvenuto_at: BENVENUTO,
  last_inbound_at: '2026-10-01T10:05:00Z',
  lancio_link_inviato_at: null,
  lancio_inizio_inviato_at: null,
  ...over,
});

describe('finestra 20:30-21:30 derivata da lancio_evento_at', () => {
  it('dentro dalle 20:30 alle 21:30, estremi compresi', () => {
    expect(inFinestraInizio(roma('20:30'), EVENTO)).toBe(true);
    expect(inFinestraInizio(roma('21:00'), EVENTO)).toBe(true);
    expect(inFinestraInizio(roma('21:30'), EVENTO)).toBe(true);
  });

  it('il run delle 21:30 partito in ritardo resta dentro (tolleranza del cron)', () => {
    expect(inFinestraInizio(roma('21:30', '40'), EVENTO)).toBe(true);
  });

  it('fuori prima delle 20:28 e dopo le 21:32', () => {
    expect(inFinestraInizio(roma('20:25'), EVENTO)).toBe(false);
    expect(inFinestraInizio(roma('21:35'), EVENTO)).toBe(false);
    expect(inFinestraInizio(new Date('2026-10-04T19:00:00Z'), EVENTO)).toBe(false);
  });

  it('segue l evento: spostato alle 18:00, la finestra e 17:30-18:30', () => {
    const prova = roma('18:00');
    expect(inFinestraInizio(roma('17:30'), prova)).toBe(true);
    expect(inFinestraInizio(roma('20:30'), prova)).toBe(false);
  });

  it('chiusa solo dopo la fine (con tolleranza)', () => {
    expect(finestraInizioChiusa(roma('20:00'), EVENTO)).toBe(false);
    expect(finestraInizioChiusa(roma('21:30'), EVENTO)).toBe(false);
    expect(finestraInizioChiusa(roma('21:35'), EVENTO)).toBe(true);
  });
});

describe('distribuzione del lotto sui run rimasti', () => {
  it('conta i run rimasti, questo compreso: 13 alle 20:30, 1 alle 21:30', () => {
    expect(runRimasti(roma('20:30'), EVENTO)).toBe(13);
    expect(runRimasti(roma('20:30', '40'), EVENTO)).toBe(13);
    expect(runRimasti(roma('21:00'), EVENTO)).toBe(7);
    expect(runRimasti(roma('21:25'), EVENTO)).toBe(2);
    expect(runRimasti(roma('21:30'), EVENTO)).toBe(1);
    expect(runRimasti(roma('21:30', '50'), EVENTO)).toBe(1);
    expect(runRimasti(roma('22:00'), EVENTO)).toBe(1);
  });

  it('divide per eccesso e rispetta il tetto', () => {
    expect(dimensioneLotto(390, 13, 300)).toBe(30);
    expect(dimensioneLotto(391, 13, 300)).toBe(31);
    expect(dimensioneLotto(5, 13, 300)).toBe(1);
    expect(dimensioneLotto(0, 13, 300)).toBe(0);
    expect(dimensioneLotto(10_000, 13, 300)).toBe(300);
    expect(dimensioneLotto(250, 1, 300)).toBe(250);
    expect(dimensioneLotto(10, 0, 300)).toBe(10);
  });

  it('simulando tutti i run da 20:30 a 21:30 la coda si svuota in modo uniforme', () => {
    let rimanenti = 1000;
    const lotti: number[] = [];
    for (let m = 0; m <= 60; m += 5) {
      const now = new Date(roma('20:30').getTime() + m * 60_000 + 20_000); // 20" di ritardo del cron
      const n = dimensioneLotto(rimanenti, runRimasti(now, EVENTO), 300);
      lotti.push(n);
      rimanenti -= n;
    }
    expect(lotti).toHaveLength(13);
    expect(rimanenti).toBe(0);
    expect(Math.max(...lotti) - Math.min(...lotti)).toBeLessThanOrEqual(2);
  });
});

describe('selezione dei destinatari', () => {
  it('ha scritto dopo il benvenuto: last_inbound_at successivo', () => {
    expect(haScrittoDopoBenvenuto({ lancio_benvenuto_at: BENVENUTO, last_inbound_at: '2026-10-01T10:00:01Z' })).toBe(true);
    expect(haScrittoDopoBenvenuto({ lancio_benvenuto_at: BENVENUTO, last_inbound_at: BENVENUTO })).toBe(false);
    expect(haScrittoDopoBenvenuto({ lancio_benvenuto_at: BENVENUTO, last_inbound_at: '2026-09-30T10:00:00Z' })).toBe(false);
    expect(haScrittoDopoBenvenuto({ lancio_benvenuto_at: BENVENUTO, last_inbound_at: null })).toBe(false);
    expect(haScrittoDopoBenvenuto({ lancio_benvenuto_at: null, last_inbound_at: '2026-10-01T10:05:00Z' })).toBe(false);
  });

  it('idoneo: fase attesa, posto_bloccato o link_inviato', () => {
    expect(idoneoAllInizio(cand({ lancio_fase: 'attesa' }))).toBe(true);
    expect(idoneoAllInizio(cand({ lancio_fase: 'posto_bloccato' }))).toBe(true);
    expect(idoneoAllInizio(cand({ lancio_fase: 'link_inviato' }))).toBe(true);
  });

  it('esclusi: terminali, scelta_fatta, post_pitch, followup, fase nulla', () => {
    for (const f of ['chiuso', 'restituito', 'scelta_fatta', 'post_pitch', 'followup_inviato', null]) {
      expect(idoneoAllInizio(cand({ lancio_fase: f }))).toBe(false);
    }
  });

  it('esclusi: congedati, gia serviti, mai scritto dopo il benvenuto, chat non del lancio', () => {
    expect(idoneoAllInizio(cand({ lancio_info: { congedo_at: '2026-10-02T10:00:00Z' } }))).toBe(false);
    expect(idoneoAllInizio(cand({ lancio_info: { riscaldamento: 'x' } }))).toBe(true);
    expect(idoneoAllInizio(cand({ lancio_inizio_inviato_at: '2026-10-05T18:35:00Z' }))).toBe(false);
    expect(idoneoAllInizio(cand({ last_inbound_at: null }))).toBe(false);
    expect(idoneoAllInizio(cand({ lancio_benvenuto_at: null }))).toBe(false);
    expect(idoneoAllInizio(cand({ lancio_slug: null }))).toBe(false);
  });

  it('link Zoom partito da meno di 15 minuti: rimandato', () => {
    const now = roma('20:40');
    expect(linkZoomTroppoRecente({ lancio_link_inviato_at: roma('20:30').toISOString() }, now)).toBe(true);
    expect(linkZoomTroppoRecente({ lancio_link_inviato_at: roma('20:25').toISOString() }, now)).toBe(false);
    expect(linkZoomTroppoRecente({ lancio_link_inviato_at: null }, now)).toBe(false);
  });

  it('ordine: prima posto_bloccato, poi il resto, stabile', () => {
    const lista = [
      cand({ id: 1, lancio_fase: 'attesa' }),
      cand({ id: 2, lancio_fase: 'posto_bloccato' }),
      cand({ id: 3, lancio_fase: 'link_inviato' }),
      cand({ id: 4, lancio_fase: 'posto_bloccato' }),
    ];
    expect(ordinaCandidatiInizio(lista).map((c) => c.id)).toEqual([2, 4, 1, 3]);
  });
});

describe('scegliLottoInizio', () => {
  const coda = [
    cand({ id: 1, lancio_fase: 'attesa' }),
    cand({ id: 2, lancio_fase: 'posto_bloccato' }),
    cand({ id: 3, lancio_fase: 'link_inviato', lancio_link_inviato_at: roma('20:28').toISOString() }),
    cand({ id: 4, lancio_fase: 'posto_bloccato', lancio_info: { congedo_at: 'x' } }),
    cand({ id: 5, lancio_fase: 'chiuso' }),
    cand({ id: 6, lancio_fase: 'attesa', last_inbound_at: null }),
    cand({ id: 7, lancio_fase: 'link_inviato', lancio_link_inviato_at: roma('20:00').toISOString() }),
  ];

  it('alle 20:35: 4 rimanenti, uno rimandato, quota 1 su 12 run', () => {
    const s = scegliLottoInizio(coda, roma('20:35'), EVENTO, 300);
    expect(s.rimanenti.map((c) => c.id)).toEqual([2, 1, 3, 7]);
    expect(s.pronti.map((c) => c.id)).toEqual([2, 1, 7]);
    expect(s.rimandati).toBe(1);
    expect(s.run).toBe(12);
    expect(s.quota).toBe(1);
    expect(s.lotto.map((c) => c.id)).toEqual([2]);
  });

  it('all ultimo run si svuota tutto quello che e pronto', () => {
    const s = scegliLottoInizio(coda, roma('21:30'), EVENTO, 300);
    expect(s.run).toBe(1);
    expect(s.lotto.map((c) => c.id)).toEqual([2, 1, 3, 7]);
  });

  it('il tetto vince sulla quota', () => {
    const tanti = Array.from({ length: 50 }, (_, i) => cand({ id: i + 1 }));
    expect(scegliLottoInizio(tanti, roma('21:30'), EVENTO, 20).lotto).toHaveLength(20);
  });

  it('forza (prova generale): niente distribuzione, tutto il pronto dentro al tetto', () => {
    const s = scegliLottoInizio(coda, roma('23:00'), EVENTO, 300, true);
    expect(s.lotto.map((c) => c.id)).toEqual([2, 1, 3, 7]);
  });
});

describe('inizioBody', () => {
  it('coincide col testo sottomesso a Meta', () => {
    expect(inizioBody('{{1}}', '{{2}}')).toBe(
      'Promemoria evento: ciao {{1}}, la live Web Developer AI a cui ti sei iscritto è in programma oggi alle 21:00. ' +
        'Questo è il link per accedere: {{2}} - se la live è già iniziata puoi entrare comunque dallo stesso link. ' +
        'Se hai difficoltà a collegarti, rispondi a questo messaggio.',
    );
  });
});

describe('lo schedule di vercel.json copre la finestra 20:30-21:30', () => {
  const { crons } = JSON.parse(readFileSync('vercel.json', 'utf8'));
  const entry = crons.find((c: { path: string }) => c.path === '/api/cron/lancio-inizio');
  it('la voce esiste con lo schedule a data fissa', () => {
    expect(entry?.schedule).toBe('*/5 18-19 5 10 *');
  });
  it('i run utili sono 13, dalle 20:30 alle 21:30 di Roma', () => {
    const run: Date[] = [];
    for (const h of [18, 19]) for (let m = 0; m < 60; m += 5) run.push(new Date(Date.UTC(2026, 9, 5, h, m)));
    const utili = run.filter((d) => inFinestraInizio(d, EVENTO));
    expect(utili).toHaveLength(13);
    expect(utili[0].toISOString()).toBe('2026-10-05T18:30:00.000Z');
    expect(utili[12].toISOString()).toBe('2026-10-05T19:30:00.000Z');
  });
});
