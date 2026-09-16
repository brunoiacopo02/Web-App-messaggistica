import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  inFinestraBlast,
  zoomMeetingId,
  zoomBlastBody,
  batchMax,
  parsePerimetroBlast,
  idoneoAlBlast,
  ordinaCandidatiBlast,
  decideFreno,
  LANCIO_BATCH_MAX_DEFAULT,
  LANCIO_BLAST_CONCURRENCY,
  LANCIO_BLAST_PERIMETRO_DEFAULT,
} from './lancio-zoom-blast';

const EVENTO = new Date('2026-10-05T21:00:00+02:00');
const rome = (hhmm: string, giorno = '2026-10-05') => new Date(`${giorno}T${hhmm}:00+02:00`);

describe('inFinestraBlast: 19:30-20:45 di Roma del giorno dell evento', () => {
  it('19:30 dentro, 19:25 fuori', () => {
    expect(inFinestraBlast(rome('19:30'), EVENTO)).toBe(true);
    expect(inFinestraBlast(rome('19:25'), EVENTO)).toBe(false);
  });
  it('20:45 dentro, 20:50 fuori', () => {
    expect(inFinestraBlast(rome('20:45'), EVENTO)).toBe(true);
    expect(inFinestraBlast(rome('20:50'), EVENTO)).toBe(false);
  });
  it('stessa ora del giorno prima o dopo: fuori', () => {
    expect(inFinestraBlast(rome('20:00', '2026-10-04'), EVENTO)).toBe(false);
    expect(inFinestraBlast(rome('20:00', '2026-10-06'), EVENTO)).toBe(false);
  });
  it('la finestra segue l evento: evento alle 20:00 ⇒ 18:30-19:45', () => {
    const prova = new Date('2026-10-05T20:00:00+02:00');
    expect(inFinestraBlast(rome('18:30'), prova)).toBe(true);
    expect(inFinestraBlast(rome('19:50'), prova)).toBe(false);
  });
});

describe('lo schedule di vercel.json copre esattamente la finestra', () => {
  const { crons } = JSON.parse(readFileSync('vercel.json', 'utf8'));
  const entry = crons.find((c: { path: string }) => c.path === '/api/cron/lancio-zoom');
  it('la voce esiste con lo schedule a data fissa', () => {
    expect(entry?.schedule).toBe('*/5 17-18 5 10 *');
  });
  it('i run utili sono 16, dal 19:30 al 20:45 di Roma', () => {
    const run: Date[] = [];
    for (const h of [17, 18]) for (let m = 0; m < 60; m += 5) run.push(new Date(Date.UTC(2026, 9, 5, h, m)));
    const utili = run.filter((d) => inFinestraBlast(d, EVENTO));
    const hhmm = (d: Date) => new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
    expect(utili).toHaveLength(16);
    expect(hhmm(utili[0])).toBe('19:30');
    expect(hhmm(utili[utili.length - 1])).toBe('20:45');
  });
});

describe('zoomMeetingId', () => {
  it('raggruppa le cifre 3-4-4 come le mostra Zoom', () => {
    expect(zoomMeetingId('https://us06web.zoom.us/j/89845223337')).toBe('898 4522 3337');
  });
  it('link con query string: ignora il resto', () => {
    expect(zoomMeetingId('https://us06web.zoom.us/j/89845223337?pwd=abc')).toBe('898 4522 3337');
  });
  it('link senza /j/: null, non si inventa un codice', () => {
    expect(zoomMeetingId('https://zoom.us/')).toBeNull();
  });
});

describe('zoomBlastBody e batchMax', () => {
  it('il corpo di fallback contiene nome, link e l ora della live', () => {
    const b = zoomBlastBody('Mario', 'https://us06web.zoom.us/j/1');
    expect(b).toContain('Ciao Mario');
    expect(b).toContain('https://us06web.zoom.us/j/1');
    expect(b).toContain('21:00');
  });
  it('batchMax: default 200 (delibera del 16/09, lotto ridotto da 400), env valida, env sporca', () => {
    expect(batchMax(undefined)).toBe(200);
    expect(batchMax('250')).toBe(250);
    expect(batchMax('zero')).toBe(200);
    expect(batchMax('0')).toBe(200);
  });
  it('le costanti riflettono la delibera: 200 di default, stessa concorrenza di send-batch', () => {
    expect(LANCIO_BATCH_MAX_DEFAULT).toBe(200);
    expect(LANCIO_BLAST_CONCURRENCY).toBe(5);
  });
});

describe('parsePerimetroBlast', () => {
  it('default "tutti" per qualunque valore che non sia esattamente "risposto"', () => {
    expect(parsePerimetroBlast(undefined)).toBe('tutti');
    expect(parsePerimetroBlast(null)).toBe('tutti');
    expect(parsePerimetroBlast('')).toBe('tutti');
    expect(parsePerimetroBlast('qualcosa')).toBe('tutti');
    expect(LANCIO_BLAST_PERIMETRO_DEFAULT).toBe('tutti');
  });
  it('"risposto" passa cosi com e', () => {
    expect(parsePerimetroBlast('risposto')).toBe('risposto');
  });
});

describe('idoneoAlBlast', () => {
  const base = { lancio_fase: 'attesa' as string | null, lancio_info: null as unknown, last_inbound_at: null as string | null };

  it('congedato: mai idoneo, qualunque fase o perimetro', () => {
    const c = { ...base, lancio_fase: 'posto_bloccato', lancio_info: { congedo_at: '2026-09-20T10:00:00Z' } };
    expect(idoneoAlBlast(c, 'tutti')).toBe(false);
    expect(idoneoAlBlast(c, 'risposto')).toBe(false);
  });

  it('fase diversa da attesa/posto_bloccato: mai idoneo (es. link gia inviato)', () => {
    expect(idoneoAlBlast({ ...base, lancio_fase: 'link_inviato' }, 'tutti')).toBe(false);
    expect(idoneoAlBlast({ ...base, lancio_fase: 'chiuso' }, 'tutti')).toBe(false);
    expect(idoneoAlBlast({ ...base, lancio_fase: null }, 'tutti')).toBe(false);
  });

  it('perimetro "tutti": posto_bloccato e attesa sempre idonei, con o senza inbound', () => {
    expect(idoneoAlBlast({ ...base, lancio_fase: 'posto_bloccato' }, 'tutti')).toBe(true);
    expect(idoneoAlBlast({ ...base, lancio_fase: 'attesa', last_inbound_at: null }, 'tutti')).toBe(true);
  });

  it('perimetro "risposto": serve almeno un inbound', () => {
    expect(idoneoAlBlast({ ...base, lancio_fase: 'attesa', last_inbound_at: null }, 'risposto')).toBe(false);
    expect(idoneoAlBlast({ ...base, lancio_fase: 'attesa', last_inbound_at: '2026-09-20T10:00:00Z' }, 'risposto')).toBe(true);
    expect(idoneoAlBlast({ ...base, lancio_fase: 'posto_bloccato', last_inbound_at: '2026-09-20T10:00:00Z' }, 'risposto')).toBe(true);
  });
});

describe('ordinaCandidatiBlast', () => {
  it('posto_bloccato prima, poi attesa con inbound, poi attesa senza — stabile a parita di gruppo', () => {
    const a = { id: 1, lancio_fase: 'attesa', last_inbound_at: null };
    const b = { id: 2, lancio_fase: 'posto_bloccato', last_inbound_at: null };
    const c = { id: 3, lancio_fase: 'attesa', last_inbound_at: '2026-09-20T10:00:00Z' };
    const d = { id: 4, lancio_fase: 'posto_bloccato', last_inbound_at: '2026-09-20T10:00:00Z' };
    const e = { id: 5, lancio_fase: 'attesa', last_inbound_at: null };
    const ordinati = ordinaCandidatiBlast([a, b, c, d, e]);
    expect(ordinati.map((x) => x.id)).toEqual([2, 4, 3, 1, 5]);
  });

  it('lista vuota resta vuota', () => {
    expect(ordinaCandidatiBlast([])).toEqual([]);
  });
});

describe('decideFreno', () => {
  it('continua sotto soglia', () => {
    expect(decideFreno({ inviati: 20, falliti: 2, codici: [] })).toBe('continua');
  });
  it('ferma se falliti/inviati > 10% con almeno 20 inviati', () => {
    expect(decideFreno({ inviati: 20, falliti: 3, codici: [] })).toBe('ferma');
  });
  it('sotto i 20 inviati non si ferma per il solo tasso di fallimento', () => {
    expect(decideFreno({ inviati: 5, falliti: 4, codici: [] })).toBe('continua');
  });
  it('ferma su qualunque codice Twilio 63018/63049/63051, anche con pochi invii', () => {
    expect(decideFreno({ inviati: 1, falliti: 1, codici: [63018] })).toBe('ferma');
    expect(decideFreno({ inviati: 1, falliti: 0, codici: [63049] })).toBe('ferma');
    expect(decideFreno({ inviati: 1, falliti: 0, codici: [63051] })).toBe('ferma');
  });
  it('altri codici Twilio non fermano da soli', () => {
    expect(decideFreno({ inviati: 20, falliti: 1, codici: [21211] })).toBe('continua');
  });
});
