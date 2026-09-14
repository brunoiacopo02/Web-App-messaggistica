import { describe, it, expect } from 'vitest';
import {
  decideAperturaLancio,
  riassumiOutboundLancio,
  MAX_TENTATIVI_BENVENUTO,
  GAP_MIN_OUTBOUND_MS,
  GAP_MIN_INBOUND_MS,
} from './lancio-aperture';

const GIORNO = Date.parse('2026-09-20T10:00:00Z'); // 12:00 Roma
const NOTTE = Date.parse('2026-09-20T01:00:00Z'); // 03:00 Roma
const H = 3600_000;

const G = 24 * 3600_000;

const base = {
  nowMs: GIORNO,
  attivo: true,
  fase: 'attesa' as string | null,
  benvenutoAt: null as string | null,
  benvenutiRiusciti: 0,
  benvenutiFalliti: 0,
  ultimoOutboundMs: null as number | null,
  ultimoInboundMs: null as number | null,
};

const WELCOME = 'HXbenvenuto';

describe('decideAperturaLancio', () => {
  it('lead in attesa, niente partito, lancio acceso, in fascia, invia', () => {
    expect(decideAperturaLancio(base)).toBe('invia');
  });

  it('fuori dalla fascia 07-23 aspetta', () => {
    expect(decideAperturaLancio({ ...base, nowMs: NOTTE })).toBe('attendi');
  });

  it("lancio spento aspetta: e' il kill-switch, non una rinuncia", () => {
    expect(decideAperturaLancio({ ...base, attivo: false })).toBe('attendi');
  });

  it('il lucchetto `lancio_benvenuto_at` da solo basta a fermare tutto', () => {
    // E' la prova di appartenenza vera: non dipende dal SID del template in env, che
    // un domani potrebbe ruotare (template nuovo, stesso lancio).
    expect(decideAperturaLancio({ ...base, benvenutoAt: '2026-09-19T20:00:00Z' })).toBe('salta');
  });

  it('un benvenuto riuscito, salta: mai due benvenuti sulla stessa chat', () => {
    expect(decideAperturaLancio({ ...base, benvenutiRiusciti: 1 })).toBe('salta');
    // Anche se e' stato seguito da un fallimento: il lead il messaggio lo ha ricevuto.
    expect(decideAperturaLancio({ ...base, benvenutiRiusciti: 1, benvenutiFalliti: 1 })).toBe('salta');
  });

  it("un invio fallito si ritenta due volte, poi basta", () => {
    const vecchio = { ...base, ultimoOutboundMs: GIORNO - 13 * H };
    expect(decideAperturaLancio({ ...vecchio, benvenutiFalliti: 1 })).toBe('invia');
    expect(decideAperturaLancio({ ...vecchio, benvenutiFalliti: MAX_TENTATIVI_BENVENUTO })).toBe('invia');
    expect(decideAperturaLancio({ ...vecchio, benvenutiFalliti: MAX_TENTATIVI_BENVENUTO + 1 })).toBe('salta');
  });

  it("fase diversa da attesa, salta (ha gia' ricevuto qualcosa o e' finita)", () => {
    for (const fase of ['posto_bloccato', 'chiuso', 'restituito', null]) {
      expect(decideAperturaLancio({ ...base, fase })).toBe('salta');
      // La fase vince su tutto: una chat chiusa non torna mai in coda, nemmeno a
      // lancio spento (dove tutto il resto direbbe "attendi").
      expect(decideAperturaLancio({ ...base, fase, attivo: false })).toBe('salta');
    }
  });

  it("un'apertura di Mario di un'ora fa aspetta, una di 13 ore fa no", () => {
    // Stessa guardia `apertura_recente` dell'intake: 12h di silenzio outbound.
    expect(decideAperturaLancio({ ...base, ultimoOutboundMs: GIORNO - 1 * H })).toBe('attendi');
    expect(decideAperturaLancio({ ...base, ultimoOutboundMs: GIORNO - 13 * H })).toBe('invia');
    expect(decideAperturaLancio({ ...base, ultimoOutboundMs: GIORNO - GAP_MIN_OUTBOUND_MS })).toBe('invia');
    expect(decideAperturaLancio({ ...base, ultimoOutboundMs: GIORNO - GAP_MIN_OUTBOUND_MS + 1 })).toBe('attendi');
  });

  it('un benvenuto appena fallito non si ritenta subito: prima passano 12 ore', () => {
    expect(decideAperturaLancio({ ...base, benvenutiFalliti: 1, ultimoOutboundMs: GIORNO - 10 * H })).toBe('attendi');
  });

  it('una chat viva non si interrompe con un template: 7 giorni dall’ultimo inbound', () => {
    // Seconda guardia dell'intake (`conversazione_viva`): il lead sta parlando con
    // qualcuno, il benvenuto del lancio non gli cade in mezzo alla conversazione.
    expect(decideAperturaLancio({ ...base, ultimoInboundMs: GIORNO - 2 * G })).toBe('attendi');
    expect(decideAperturaLancio({ ...base, ultimoInboundMs: GIORNO - 8 * G })).toBe('invia');
    expect(decideAperturaLancio({ ...base, ultimoInboundMs: GIORNO - GAP_MIN_INBOUND_MS })).toBe('invia');
    expect(decideAperturaLancio({ ...base, ultimoInboundMs: GIORNO - GAP_MIN_INBOUND_MS + 1 })).toBe('attendi');
  });

  it('inbound vecchio ma outbound fresco: comanda la guardia piu’ severa', () => {
    expect(decideAperturaLancio({
      ...base, ultimoInboundMs: GIORNO - 8 * G, ultimoOutboundMs: GIORNO - 2 * H,
    })).toBe('attendi');
  });
});

describe('riassumiOutboundLancio', () => {
  const riga = (sid: string | null, status: string | null, at: string, code: number | null = null) => ({
    template_sid: sid, twilio_status: status, created_at: at, twilio_error_code: code,
  });

  it('senza righe non c\u2019e\u2019 niente da contare', () => {
    expect(riassumiOutboundLancio([], WELCOME)).toEqual({
      benvenutiRiusciti: 0, benvenutiFalliti: 0, ultimoOutboundMs: null,
    });
  });

  it('il benvenuto consegnato conta come riuscito', () => {
    const r = riassumiOutboundLancio([riga(WELCOME, 'delivered', '2026-09-20T08:00:00Z')], WELCOME);
    expect(r.benvenutiRiusciti).toBe(1);
    expect(r.benvenutiFalliti).toBe(0);
  });

  it('failed e undelivered sono fallimenti, tutto il resto no', () => {
    const r = riassumiOutboundLancio([
      riga(WELCOME, 'failed', '2026-09-20T08:00:00Z'),
      riga(WELCOME, 'undelivered', '2026-09-20T09:00:00Z'),
      riga(WELCOME, 'queued', '2026-09-20T09:30:00Z'),
      riga(WELCOME, null, '2026-09-20T09:40:00Z'),
    ], WELCOME);
    expect(r.benvenutiFalliti).toBe(2);
    // `queued` e lo stato ancora ignoto valgono "partito": nel dubbio non si ripete.
    expect(r.benvenutiRiusciti).toBe(2);
  });

  it('il frequency cap Meta non e’ un tentativo bruciato', () => {
    // 63049 = Meta ha detto "troppi messaggi a questo numero": non e' colpa del lead e
    // non consuma il budget dei ritentativi. La riga pesa solo sulla guardia 12h.
    const r = riassumiOutboundLancio([
      riga(WELCOME, 'failed', '2026-09-20T08:00:00Z', 63049),
      riga(WELCOME, 'failed', '2026-09-20T08:30:00Z', 63024),
    ], WELCOME);
    expect(r.benvenutiFalliti).toBe(1);
    expect(r.benvenutiRiusciti).toBe(0);
    expect(r.ultimoOutboundMs).toBe(Date.parse('2026-09-20T08:30:00Z'));
  });

  it("l'apertura di Mario non e' un benvenuto, ma pesa sull'ultimo outbound", () => {
    const r = riassumiOutboundLancio([
      riga('HXapertura', 'delivered', '2026-09-20T07:00:00Z'),
      riga(null, 'sent', '2026-09-20T09:00:00Z'),
    ], WELCOME);
    expect(r.benvenutiRiusciti).toBe(0);
    expect(r.benvenutiFalliti).toBe(0);
    expect(r.ultimoOutboundMs).toBe(Date.parse('2026-09-20T09:00:00Z'));
  });

  it('senza SID del benvenuto non si conta nessun benvenuto (ma la guardia 12h resta)', () => {
    const r = riassumiOutboundLancio([riga(WELCOME, 'delivered', '2026-09-20T08:00:00Z')], null);
    expect(r.benvenutiRiusciti).toBe(0);
    expect(r.ultimoOutboundMs).toBe(Date.parse('2026-09-20T08:00:00Z'));
  });

  it('le date illeggibili non sporcano il massimo', () => {
    const r = riassumiOutboundLancio([
      riga(null, 'sent', '2026-09-20T06:00:00Z'),
      riga(null, 'sent', 'boh'),
      { template_sid: null, twilio_status: 'sent', created_at: null, twilio_error_code: null },
    ], WELCOME);
    expect(r.ultimoOutboundMs).toBe(Date.parse('2026-09-20T06:00:00Z'));
  });
});
