import { describe, it, expect } from 'vitest';
import type { StatoQualita } from './qualita-numeri';
import { numeroHighOggi } from './numero-high';

const oggi = '2026-11-07';
const stato = (q: string | undefined, pausa = false): StatoQualita => ({
  storico: { '+393522018718': (q ? { [oggi]: q } : {}) as Record<string, 'HIGH'> },
  pause: (pausa ? { '+393522018718': { fino: '2026-11-10', tettoPrima: 50, dal: oggi } } : {}) as StatoQualita['pause'],
});
const tetti = { 'whatsapp:+393522018718': 50 };

describe('numeroHighOggi', () => {
  it('HIGH oggi, fuori pausa, tetto > 0: ok', () => {
    expect(numeroHighOggi({ numero: 'whatsapp:+393522018718', stato: stato('HIGH'), tetti, oggi })).toEqual({ ok: true });
  });
  it('MEDIUM o LOW oggi: sotto_high', () => {
    expect(numeroHighOggi({ numero: '+393522018718', stato: stato('MEDIUM'), tetti, oggi })).toEqual({ ok: false, motivo: 'sotto_high', qualita: 'MEDIUM' });
    expect(numeroHighOggi({ numero: '+393522018718', stato: stato('LOW'), tetti, oggi })).toMatchObject({ motivo: 'sotto_high' });
  });
  it('in pausa: fermo anche se HIGH', () => {
    expect(numeroHighOggi({ numero: '+393522018718', stato: stato('HIGH', true), tetti, oggi })).toMatchObject({ motivo: 'in_pausa' });
  });
  it('tetto 0 scritto: fermo; numero assente dai tetti: non fermo', () => {
    expect(numeroHighOggi({ numero: '+393522018718', stato: stato('HIGH'), tetti: { '+393522018718': 0 }, oggi })).toMatchObject({ motivo: 'tetto_zero' });
    expect(numeroHighOggi({ numero: '+393522018718', stato: stato('HIGH'), tetti: {}, oggi })).toEqual({ ok: true });
  });
  it('nessuna lettura oggi o stato illeggibile: non_letto', () => {
    expect(numeroHighOggi({ numero: '+393522018718', stato: stato(undefined), tetti, oggi })).toMatchObject({ motivo: 'non_letto' });
    expect(numeroHighOggi({ numero: '+393522018718', stato: null, tetti, oggi })).toMatchObject({ motivo: 'non_letto' });
  });
});
