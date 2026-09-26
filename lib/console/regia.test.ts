import { it, expect } from 'vitest';
import { scalettaDa, statoOnda, consegnePerOra, inizioGiornoRoma, oraRoma } from './regia';

const evento = '2026-10-05T21:00:00+02:00';

it('scaletta a partire dall\'evento', () => {
  expect(scalettaDa(evento).map((v) => [v.voce, oraRoma(new Date(v.at))])).toEqual([['link', 20], ['inizio', 21], ['pitch', 21], ['chiusura', 22]]);
  expect(scalettaDa(null)).toEqual([]);
  expect(scalettaDa('non-una-data')).toEqual([]);
});

it('stato onda', () => {
  expect(statoOnda(new Date('2026-10-05T18:00:00+02:00'), evento)).toEqual({ stato: 'prima', secondi: 3 * 3600 });
  expect(statoOnda(new Date('2026-10-05T21:14:32+02:00'), evento)).toEqual({ stato: 'in_onda', secondi: 14 * 60 + 32 });
  expect(statoOnda(new Date('2026-10-05T23:00:00+02:00'), evento).stato).toBe('dopo');
  expect(statoOnda(new Date(), null)).toEqual({ stato: 'nessuno', secondi: 0 });
});

it('giorno e ore a Roma, anche col cambio d\'ora', () => {
  expect(inizioGiornoRoma(new Date('2026-10-05T10:00:00Z')).toISOString()).toBe('2026-10-04T22:00:00.000Z');
  expect(inizioGiornoRoma(new Date('2026-11-05T10:00:00Z')).toISOString()).toBe('2026-11-04T23:00:00.000Z');
});

it('consegne per ora', () => {
  const r = consegnePerOra([
    { created_at: '2026-10-05T16:02:00Z', twilio_status: 'delivered' },
    { created_at: '2026-10-05T16:03:00Z', twilio_status: 'read' },
    { created_at: '2026-10-05T16:04:00Z', twilio_status: 'failed' },
    { created_at: '2026-10-05T16:05:00Z', twilio_status: 'sent' },
  ]);
  expect(r).toHaveLength(24);
  expect(r[18]).toEqual({ ora: 18, inviati: 4, consegnati: 2, falliti: 1 });
});
