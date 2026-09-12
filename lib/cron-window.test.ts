import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { inOpeningWindow } from './sequence';

// I cron di vercel.json sono espressi in UTC, la fascia d'invio in ora di Roma.
// Le due cose scivolano di un'ora al cambio d'ora, e il cancello vero e' il codice
// (`inOpeningWindow`): se il cron e' piu' stretto della fascia, i run non esistono
// proprio e la coda notturna resta ferma anche se il codice la lascerebbe passare.
// Questo test tiene insieme i due pezzi.

const cron = (() => {
  const { crons } = JSON.parse(readFileSync('vercel.json', 'utf8'));
  const entry = crons.find((c: { path: string }) => c.path.startsWith('/api/cron/sequence-touches'));
  if (!entry) throw new Error('cron sequence-touches assente da vercel.json');
  return entry.schedule as string;
})();

/** Ore UTC coperte da uno schedule cron: legge il secondo campo, es. "5-21". */
function oreUtc(schedule: string): number[] {
  const campoOre = schedule.split(' ')[1];
  const m = /^(\d+)-(\d+)$/.exec(campoOre);
  if (!m) throw new Error(`campo ore non gestito: ${campoOre}`);
  const [, da, a] = m;
  return Array.from({ length: Number(a) - Number(da) + 1 }, (_, i) => Number(da) + i);
}

/** Istanti in cui il cron gira davvero, in un giorno dato (run ogni 30'). */
function runDelGiorno(giornoUtc: string): number[] {
  return oreUtc(cron).flatMap((h) => [
    Date.parse(`${giornoUtc}T${String(h).padStart(2, '0')}:00:00Z`),
    Date.parse(`${giornoUtc}T${String(h).padStart(2, '0')}:30:00Z`),
  ]);
}

const romeHHMM = (ms: number) =>
  new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .format(new Date(ms));

describe('il cron copre la fascia delle aperture, estate e inverno', () => {
  for (const [stagione, giorno] of [['estate', '2026-07-15'], ['inverno', '2026-01-15']] as const) {
    const utili = runDelGiorno(giorno).filter(inOpeningWindow);

    it(`${stagione}: il primo run in fascia e' alle 07:00 di Roma, non piu' tardi`, () => {
      expect(romeHHMM(utili[0])).toBe('07:00');
    });

    it(`${stagione}: si arriva fino alle 22:30 di Roma`, () => {
      expect(romeHHMM(utili[utili.length - 1])).toBe('22:30');
    });
  }
});
