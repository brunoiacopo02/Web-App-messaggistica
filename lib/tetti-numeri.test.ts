import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseTettiNumeri, tettoDi, getTettiNumeri, eHighEFuoriPausa } from './tetti-numeri';

describe('parseTettiNumeri', () => {
  it('legge la mappa e normalizza le chiavi', () => {
    const t = parseTettiNumeri({ 'whatsapp:+393522018718': 150, '+393520158061': 150, 'whatsapp:+393522070047': 0 });
    expect(tettoDi(t, 'whatsapp:+393522018718')).toBe(150);
    expect(tettoDi(t, 'whatsapp:+393520158061')).toBe(150);
    expect(tettoDi(t, '+393522070047')).toBe(0);
  });

  it('numero assente = 0', () => {
    expect(tettoDi(parseTettiNumeri({}), 'whatsapp:+393522018718')).toBe(0);
  });

  it('valori strani = 0', () => {
    const t = parseTettiNumeri({ '+391': -5, '+392': 3.5, '+393': 'tanti', '+394': null, '+395': '40' });
    for (const n of ['+391', '+392', '+393', '+394']) expect(tettoDi(t, n), n).toBe(0);
    expect(tettoDi(t, '+395')).toBe(40); // stringa intera: accettata, e' come la scrive un umano
  });

  it('non un oggetto = mappa vuota', () => {
    for (const raw of [null, undefined, 'x', 3, [1, 2]]) expect(parseTettiNumeri(raw).size).toBe(0);
  });
});

describe('eHighEFuoriPausa (titolare 17/11/2026: fuori solo dopo due letture cattive di fila)', () => {
  const N = '+393522070047';
  const P = '+393520413199';
  const OGGI = '2026-11-17';
  const IERI = '2026-11-16';
  const ultima = (qualita: string, cattiveDiFila: number) => ({ qualita, alle: '2026-11-17T08:10:00.000Z', cattiveDiFila });
  beforeEach(() => { vi.stubEnv('TWILIO_WHATSAPP_NUMBER_FENICE', `whatsapp:${P}`); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('HIGH oggi, o ieri se oggi manca: si', () => {
    expect(eHighEFuoriPausa({ storico: { [N]: { [OGGI]: 'HIGH' } }, pause: {} }, `whatsapp:${N}`, OGGI, IERI)).toBe(true);
    expect(eHighEFuoriPausa({ storico: { [N]: { [IERI]: 'HIGH' } }, pause: {} }, N, OGGI, IERI)).toBe(true);
  });

  it('una lettura cattiva isolata oggi: resta dentro', () => {
    const stato = { storico: { [N]: { [OGGI]: 'LOW' } }, pause: {}, ultime: { [N]: ultima('LOW', 1) } };
    expect(eHighEFuoriPausa(stato, N, OGGI, IERI)).toBe(true);
  });

  it('cattiva e poi di nuovo HIGH (peggiore del giorno LOW): resta dentro', () => {
    const stato = { storico: { [N]: { [OGGI]: 'LOW' } }, pause: {}, ultime: { [N]: ultima('HIGH', 0) } };
    expect(eHighEFuoriPausa(stato, N, OGGI, IERI)).toBe(true);
  });

  it('in pausa: fuori, qualunque lettura', () => {
    const stato = { storico: { [N]: { [OGGI]: 'HIGH' } }, pause: { [N]: { fino: '2026-11-20' } }, ultime: { [N]: ultima('HIGH', 0) } };
    expect(eHighEFuoriPausa(stato, N, OGGI, IERI)).toBe(false);
  });

  it('due cattive di fila senza pausa (l ultimo aperto, che il cron non ferma): fuori', () => {
    const stato = { storico: { [N]: { [OGGI]: 'MEDIUM' } }, pause: {}, ultime: { [N]: ultima('MEDIUM', 2) } };
    expect(eHighEFuoriPausa(stato, N, OGGI, IERI)).toBe(false);
  });

  it('stato scritto prima della regola (senza `ultime`) con una lettura cattiva: fuori, come prima', () => {
    expect(eHighEFuoriPausa({ storico: { [N]: { [OGGI]: 'LOW' } }, pause: {} }, N, OGGI, IERI)).toBe(false);
    expect(eHighEFuoriPausa({ storico: { [N]: { [OGGI]: 'LOW' } }, pause: {}, ultime: { [N]: { qualita: 'LOW' } } }, N, OGGI, IERI)).toBe(false);
  });

  it('nessuna lettura, lettura vecchia, UNKNOWN, stato illeggibile: fuori', () => {
    const u = { [N]: ultima('HIGH', 0) };
    expect(eHighEFuoriPausa({ storico: {}, pause: {}, ultime: u }, N, OGGI, IERI)).toBe(false);
    expect(eHighEFuoriPausa({ storico: { [N]: { '2026-11-15': 'HIGH' } }, pause: {}, ultime: u }, N, OGGI, IERI)).toBe(false);
    expect(eHighEFuoriPausa({ storico: { [N]: { [OGGI]: 'UNKNOWN' } }, pause: {}, ultime: u }, N, OGGI, IERI)).toBe(false);
    expect(eHighEFuoriPausa(null, N, OGGI, IERI)).toBe(false);
  });

  it('il primario (3199) esce alla prima lettura cattiva: per lui la regola non cambia', () => {
    const stato = { storico: { [P]: { [OGGI]: 'LOW' } }, pause: {}, ultime: { [P]: ultima('LOW', 1) } };
    expect(eHighEFuoriPausa(stato, `whatsapp:${P}`, OGGI, IERI)).toBe(false);
    expect(eHighEFuoriPausa({ storico: { [P]: { [OGGI]: 'HIGH' } }, pause: {} }, P, OGGI, IERI)).toBe(true);
  });
});

describe('getTettiNumeri', () => {
  const finto = (risposta: { data?: unknown; error?: unknown; lancia?: boolean }) => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => {
      if (risposta.lancia) throw new Error('rete giu');
      return { data: risposta.data ?? null, error: risposta.error ?? null };
    } }) }) }),
  }) as never;

  it('riga presente', async () => {
    const t = await getTettiNumeri(finto({ data: { value: { '+393522018718': 150 } } }));
    expect(t && tettoDi(t, '+393522018718')).toBe(150);
  });
  it('riga assente = mappa vuota (tutti a 0)', async () => {
    expect((await getTettiNumeri(finto({ data: null })))?.size).toBe(0);
  });
  it('errore o eccezione = null', async () => {
    expect(await getTettiNumeri(finto({ error: { message: 'boom' } }))).toBeNull();
    expect(await getTettiNumeri(finto({ lancia: true }))).toBeNull();
  });
});
