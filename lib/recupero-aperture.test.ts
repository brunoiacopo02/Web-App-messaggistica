import { describe, it, expect, vi } from 'vitest';
import {
  configRecupero,
  decidiChat,
  eseguiRecupero,
  inFinestraRecupero,
  motivoLavoratoDalCrm,
  ordinaCoda,
  parseTettiRecupero,
  qualitaAmmessaRecupero,
  scegliNumeroRecupero,
  EVENTO_RECUPERO_INVIATA,
  EVENTO_RECUPERO_RESTITUITA,
  EVENTO_RECUPERO_SALTATA,
  RECUPERO_MAX_PER_GIRO,
  type ChatCoda,
  type ConfigRecupero,
  type DepsRecupero,
} from './recupero-aperture';

const H = 3600_000;
// Venerdi' 06/11/2026 15:00 Roma (UTC+1).
const ADESSO = Date.parse('2026-11-06T14:00:00Z');
const N0047 = 'whatsapp:+393522070047';
const N8718 = 'whatsapp:+393522018718';
const N2245 = 'whatsapp:+393522622245';
const N2508 = 'whatsapp:+393522782508';

const chat = (id: number, aiStartedAt: string, extra: Partial<ChatCoda> = {}): ChatCoda => ({
  id, ai_started_at: aiStartedAt, crm_lead_id: `crm-${id}`, crm_funnel: null,
  wa_number: 'whatsapp:+393520158061', phone: `+39333${id}`, firstName: 'Anna', ...extra,
});

describe('configRecupero', () => {
  it('assente o 0 = spento', () => {
    expect(configRecupero({}).tetto).toBe(0);
    expect(configRecupero({ RECUPERO_APERTURE_GIORNALIERE: '0' }).tetto).toBe(0);
    expect(configRecupero({ RECUPERO_APERTURE_GIORNALIERE: 'abc' }).tetto).toBe(0);
    expect(configRecupero({ RECUPERO_APERTURE_GIORNALIERE: '-3' }).tetto).toBe(0);
    expect(configRecupero({ RECUPERO_APERTURE_GIORNALIERE: '40' }).tetto).toBe(40);
  });

  it('mai 8061, mai 3199 ne\' il primario, qualunque cosa dica l\'env', () => {
    const c = configRecupero({
      RECUPERO_APERTURE_GIORNALIERE: '40',
      TWILIO_WHATSAPP_NUMBER_FENICE: 'whatsapp:+393520413199',
      RECUPERO_NUMERI: '+393520158061, whatsapp:+393520413199,+393522070047,whatsapp:+393522018718,+393522070047',
    });
    expect(c.numeri).toEqual([N0047, N8718]);
    expect(c.maxPerGiro).toBe(RECUPERO_MAX_PER_GIRO);
    expect(c.tettiNumero.size).toBe(0);
  });

  it('RECUPERO_TETTI_NUMERO: tetto per numero; a 0 il numero esce dalla lista', () => {
    const c = configRecupero({
      RECUPERO_APERTURE_GIORNALIERE: '60',
      RECUPERO_NUMERI: '+393522018718,+393522070047,+393522622245,+393522782508',
      RECUPERO_TETTI_NUMERO: '+393522018718:25, whatsapp:+393522070047:20,+393522622245:6,+393522782508:0',
    });
    expect(c.numeri).toEqual([N8718, N0047, N2245]);
    expect(c.tettiNumero.get(N8718)).toBe(25);
    expect(c.tettiNumero.get(N0047)).toBe(20);
    expect(c.tettiNumero.get(N2245)).toBe(6);
    expect(c.tettiNumero.get(N2508)).toBe(0);
  });
});

describe('parseTettiRecupero', () => {
  it('ignora voci malformate o negative', () => {
    const m = parseTettiRecupero('+393522018718:25,abc,:4,+393522070047:-1,+393522622245:x,+393522782508:,+393520158061:2.5');
    expect([...m.entries()]).toEqual([[N8718, 25]]);
    expect(parseTettiRecupero(undefined).size).toBe(0);
  });
});

describe('qualitaAmmessaRecupero', () => {
  const OGGI = '2026-11-07';
  const IERI = '2026-11-06';
  const stato = {
    pause: { '+393522070047': { dal: 'x' } },
    storico: {
      '+393522018718': { [IERI]: 'LOW', [OGGI]: 'HIGH' },
      '+393522070047': { [OGGI]: 'HIGH' },
      '+393522622245': { [IERI]: 'UNKNOWN' },
      '+393522782508': { [IERI]: 'LOW', [OGGI]: 'UNKNOWN' },
      '+393520000001': { [OGGI]: 'MEDIUM' },
    },
  };
  it('HIGH fuori pausa si', () => expect(qualitaAmmessaRecupero(stato, N8718, OGGI, IERI, undefined)).toBe('HIGH'));
  it('in pausa no, anche se HIGH', () => expect(qualitaAmmessaRecupero(stato, N0047, OGGI, IERI, 20)).toBeNull());
  it('UNKNOWN mai valutato col tetto di recupero > 0: in prova', () => {
    expect(qualitaAmmessaRecupero(stato, N2245, OGGI, IERI, 6)).toBe('UNKNOWN_IN_PROVA');
  });
  it('UNKNOWN senza tetto di recupero (o a 0): no', () => {
    expect(qualitaAmmessaRecupero(stato, N2245, OGGI, IERI, undefined)).toBeNull();
    expect(qualitaAmmessaRecupero(stato, N2245, OGGI, IERI, 0)).toBeNull();
  });
  it('UNKNOWN ma gia\' letto LOW in passato: no', () => {
    expect(qualitaAmmessaRecupero(stato, N2508, OGGI, IERI, 6)).toBeNull();
  });
  it('MEDIUM, lettura mancante, stato illeggibile: no', () => {
    expect(qualitaAmmessaRecupero(stato, 'whatsapp:+393520000001', OGGI, IERI, 6)).toBeNull();
    expect(qualitaAmmessaRecupero(stato, 'whatsapp:+393520000002', OGGI, IERI, 6)).toBeNull();
    expect(qualitaAmmessaRecupero(null, N8718, OGGI, IERI, 6)).toBeNull();
  });
});

describe('inFinestraRecupero', () => {
  it('09:30-20:30 Roma, estremo alto escluso', () => {
    expect(inFinestraRecupero(Date.parse('2026-11-06T08:29:00Z'))).toBe(false); // 09:29
    expect(inFinestraRecupero(Date.parse('2026-11-06T08:30:00Z'))).toBe(true); // 09:30
    expect(inFinestraRecupero(Date.parse('2026-11-06T19:29:00Z'))).toBe(true); // 20:29
    expect(inFinestraRecupero(Date.parse('2026-11-06T19:30:00Z'))).toBe(false); // 20:30
  });
});

describe('decidiChat', () => {
  const nessuno = { out: 0, in: 0 };
  it('chat della coda mai aperta e recente = invia', () => {
    expect(decidiChat(chat(1, '2026-11-05T01:00:00Z'), nessuno, ADESSO)).toEqual({ azione: 'invia', oltreCinqueGiorni: false });
  });
  it('un messaggio in uscita, anche fallito, la toglie dalla coda', () => {
    expect(decidiChat(chat(1, '2026-11-05T01:00:00Z'), { out: 1, in: 0 }, ADESSO)).toEqual({ azione: 'ignora', motivo: 'gia_aperta' });
  });
  it('arruolata dal 06/11 07:00 UTC in poi: e\' della rete, non del recupero', () => {
    expect(decidiChat(chat(1, '2026-11-06T07:00:00Z'), nessuno, ADESSO)).toEqual({ azione: 'ignora', motivo: 'fuori_coda' });
  });
  it('troppo vecchia per la coda (prima del 01/11): non si tocca', () => {
    expect(decidiChat(chat(1, '2026-10-30T10:00:00Z'), nessuno, ADESSO)).toEqual({ azione: 'ignora', motivo: 'fuori_coda' });
  });
  it('ci ha scritto lui: saltata', () => {
    expect(decidiChat(chat(1, '2026-11-05T01:00:00Z'), { out: 0, in: 2 }, ADESSO)).toEqual({ azione: 'salta', motivo: 'ha_scritto_lui' });
  });
  it('oltre 5 giorni dall\'arruolamento = restituisci (PO 07/11: resta a 5)', () => {
    expect(decidiChat(chat(1, '2026-11-03T01:00:00Z'), nessuno, Date.parse('2026-11-08T01:01:00Z'))).toEqual({ azione: 'restituisci' });
    expect(decidiChat(chat(1, '2026-11-03T01:00:00Z'), nessuno, Date.parse('2026-11-08T00:59:00Z'))).toEqual({ azione: 'invia', oltreCinqueGiorni: false });
  });
  it('senza telefono: saltata', () => {
    expect(decidiChat(chat(1, '2026-11-05T01:00:00Z', { phone: null }), nessuno, ADESSO)).toEqual({ azione: 'salta', motivo: 'senza_telefono' });
  });
});

describe('scegliNumeroRecupero', () => {
  it('il meno carico; a parita\' l\'ordine dell\'env', () => {
    expect(scegliNumeroRecupero([])).toBeNull();
    expect(scegliNumeroRecupero([{ numero: N8718, carico: 50 }, { numero: N0047, carico: 20 }])).toBe(N0047);
    expect(scegliNumeroRecupero([{ numero: N8718, carico: 5 }, { numero: N0047, carico: 5 }])).toBe(N8718);
  });
  it('mai oltre il tetto di recupero del numero', () => {
    expect(scegliNumeroRecupero([
      { numero: N0047, carico: 0, recuperiOggi: 20, tettoRecupero: 20 },
      { numero: N8718, carico: 90, recuperiOggi: 3, tettoRecupero: 25 },
    ])).toBe(N8718);
    expect(scegliNumeroRecupero([{ numero: N2245, carico: 0, recuperiOggi: 6, tettoRecupero: 6 }])).toBeNull();
  });
});

describe('ordinaCoda', () => {
  it('entro 5 giorni: dalla piu\' vecchia alla piu\' recente, a parita\' l\'id; senza arruolamento in fondo', () => {
    const c = [chat(3, '2026-11-05T01:00:00Z'), chat(9, '2026-11-03T08:00:00Z'), chat(1, '2026-11-05T01:00:00Z'), chat(7, '', { ai_started_at: null })];
    expect(ordinaCoda(c, ADESSO).map((x) => x.id)).toEqual([9, 1, 3, 7]);
  });
  it('prima tutte quelle entro 5 giorni (dalla piu\' vecchia), poi le oltre (dalla piu\' fresca)', () => {
    const now = Date.parse('2026-11-09T12:00:00Z'); // limite 5gg: 04/11 12:00 UTC
    const c = [
      chat(1, '2026-11-02T10:00:00Z'), // oltre, la piu' vecchia
      chat(2, '2026-11-04T11:00:00Z'), // oltre, la piu' fresca
      chat(3, '2026-11-03T10:00:00Z'), // oltre
      chat(4, '2026-11-05T10:00:00Z'), // entro
      chat(5, '2026-11-04T13:00:00Z'), // entro, la piu' vicina ai 5 giorni
      chat(6, '', { ai_started_at: null }),
    ];
    expect(ordinaCoda(c, now).map((x) => x.id)).toEqual([5, 4, 2, 3, 1, 6]);
  });
});

describe('motivoLavoratoDalCrm', () => {
  const base = { status: 'NEW', appointment_date: null, recall_at: null, conferme_outcome: null };
  it('NEW senza altro, o riga assente: si scrive', () => {
    expect(motivoLavoratoDalCrm(base)).toBeNull();
    expect(motivoLavoratoDalCrm(null)).toBeNull();
    expect(motivoLavoratoDalCrm({ ...base, status: null })).toBeNull();
  });
  it('in mano a una persona: mai a freddo', () => {
    expect(motivoLavoratoDalCrm({ ...base, status: 'IN_PROGRESS' })).toBe('crm_in_progress');
    expect(motivoLavoratoDalCrm({ ...base, status: 'REJECTED' })).toBe('crm_rejected');
    expect(motivoLavoratoDalCrm({ ...base, status: 'APPOINTMENT', appointment_date: '2026-11-10T10:00:00Z' })).toBe('crm_appuntamento');
    expect(motivoLavoratoDalCrm({ ...base, recall_at: '2026-11-10T10:00:00Z' })).toBe('crm_richiamo');
    expect(motivoLavoratoDalCrm({ ...base, conferme_outcome: 'scartato' })).toBe('crm_esito_conferme');
  });
});

// ─────────────────────────── orchestratore con dipendenze finte ───────────────────────────

function finti(o: {
  coda: ChatCoda[];
  giaOggi?: number | null;
  messaggi?: Map<number, { out: number; in: number }> | null;
  numeri?: { numero: string; carico: number; recuperiOggi?: number; tettoRecupero?: number }[];
  stop?: Record<string, string>;
  lavorati?: Record<string, string>;
  nonWa?: Record<string, boolean | null>;
  esitoInvio?: (id: number) => { ok: boolean; capped?: boolean; error?: string; configMancante?: boolean };
}) {
  const eventi: { type: string; payload: Record<string, unknown> }[] = [];
  const deps: DepsRecupero = {
    contaInviateOggi: vi.fn(async () => (o.giaOggi === undefined ? 0 : o.giaOggi)),
    caricaCoda: vi.fn(async () => o.coda),
    contaMessaggi: vi.fn(async () => (o.messaggi === undefined ? new Map() : o.messaggi)),
    stopCrm: vi.fn(async (id: string | null) => (id && o.stop?.[id]) || null),
    lavoratoDalCrm: vi.fn(async (id: string | null) => (id && o.lavorati?.[id]) || null),
    numeroNonWhatsapp: vi.fn(async (phone: string) => (o.nonWa && phone in o.nonWa ? (o.nonWa[phone] as boolean | null) : false)),
    numeriUtilizzabili: vi.fn(async () => ({ ok: (o.numeri ?? [{ numero: N0047, carico: 0 }]).map((n) => ({ ...n })), scarti: [] })),
    riassegnaNumero: vi.fn(async () => true),
    invia: vi.fn(async (c: ChatCoda) => (o.esitoInvio ? o.esitoInvio(c.id) : { ok: true })),
    restituisci: vi.fn(async () => ({ sent: true, status: 200 })),
    saltataOggi: vi.fn(async () => false),
    log: vi.fn(async (type: string, _l: 'info' | 'warn', payload: Record<string, unknown>) => { eventi.push({ type, payload }); }),
  };
  return { deps, eventi };
}

const CFG: ConfigRecupero = { tetto: 40, numeri: [N0047, N8718], maxPerGiro: 8, tettiNumero: new Map() };

/** n chat del 05/11, la piu' recente con id piu' alto. */
const codaDi = (n: number) =>
  Array.from({ length: n }, (_, i) => chat(100 + n - i, new Date(Date.parse('2026-11-05T06:00:00Z') - i * 60_000).toISOString()));

describe('eseguiRecupero', () => {
  it('spento: nessuna dipendenza toccata', async () => {
    const { deps } = finti({ coda: codaDi(3) });
    const r = await eseguiRecupero({ ...CFG, tetto: 0 }, deps, ADESSO);
    expect(r.disabled).toBe(true);
    expect(deps.caricaCoda).not.toHaveBeenCalled();
    expect(deps.invia).not.toHaveBeenCalled();
  });

  it('fuori finestra: niente', async () => {
    const { deps } = finti({ coda: codaDi(3) });
    const r = await eseguiRecupero(CFG, deps, Date.parse('2026-11-06T06:00:00Z')); // 07:00 Roma
    expect(r.fuoriFinestra).toBe(true);
    expect(deps.caricaCoda).not.toHaveBeenCalled();
  });

  it('al massimo 8 per giro, dalla piu\' vecchia (quelle che stanno per scadere)', async () => {
    const coda = codaDi(12);
    const { deps, eventi } = finti({ coda });
    const r = await eseguiRecupero(CFG, deps, ADESSO);
    expect(r.inviate).toBe(8);
    const inviati = (deps.invia as ReturnType<typeof vi.fn>).mock.calls.map((c) => (c[0] as ChatCoda).id);
    expect(inviati).toEqual([...coda].reverse().slice(0, 8).map((c) => c.id));
    expect(eventi.filter((e) => e.type === EVENTO_RECUPERO_INVIATA)).toHaveLength(8);
  });

  it('il tetto giornaliero conta i recuperi gia\' fatti oggi', async () => {
    const { deps } = finti({ coda: codaDi(12), giaOggi: 37 });
    const r = await eseguiRecupero(CFG, deps, ADESSO);
    expect(r.inviate).toBe(3);
    expect(r.residuoOggi).toBe(0);
  });

  it('conteggio di oggi fallito: nessun invio (fallisce chiuso)', async () => {
    const { deps } = finti({ coda: codaDi(3), giaOggi: null });
    const r = await eseguiRecupero(CFG, deps, ADESSO);
    expect(r.inviate).toBe(0);
    expect(deps.invia).not.toHaveBeenCalled();
  });

  it('riassegna il wa_number al numero scelto prima di inviare, e bilancia sul carico', async () => {
    const { deps, eventi } = finti({ coda: codaDi(4), numeri: [{ numero: N0047, carico: 21 }, { numero: N8718, carico: 20 }] });
    await eseguiRecupero(CFG, deps, ADESSO);
    const riass = (deps.riassegnaNumero as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1]);
    // 8718 (20) → pari 21/21 vince l'ordine dell'env (0047) → 8718 (21 vs 22) → pari, 0047
    expect(riass).toEqual([N8718, N0047, N8718, N0047]);
    const inv = eventi.filter((e) => e.type === EVENTO_RECUPERO_INVIATA);
    expect(inv[0].payload.numeroPrima).toBe('whatsapp:+393520158061');
    expect(inv[0].payload.numero).toBe(N8718);
    const daInvia = (deps.invia as ReturnType<typeof vi.fn>).mock.calls.map((c) => [(c[0] as ChatCoda).wa_number, c[1]]);
    expect(daInvia.every(([a, b]) => a === b)).toBe(true);
  });

  it('nessun numero utilizzabile: un solo evento, nessun invio', async () => {
    const { deps, eventi } = finti({ coda: codaDi(5), numeri: [] });
    const r = await eseguiRecupero(CFG, deps, ADESSO);
    expect(r.inviate).toBe(0);
    expect(deps.riassegnaNumero).not.toHaveBeenCalled();
    expect(eventi.filter((e) => e.type === EVENTO_RECUPERO_SALTATA && e.payload.motivo === 'nessun_numero')).toHaveLength(1);
  });

  it('stop dal CRM: saltata col motivo, non consuma il lotto', async () => {
    const coda = codaDi(10);
    const piuVecchia = coda[coda.length - 1];
    const { deps, eventi } = finti({ coda, stop: { [piuVecchia.crm_lead_id as string]: 'gia_cliente' } });
    const r = await eseguiRecupero(CFG, deps, ADESSO);
    expect(r.inviate).toBe(8);
    expect(eventi.find((e) => e.type === EVENTO_RECUPERO_SALTATA)?.payload.motivo).toBe('stop_crm_gia_cliente');
    expect(deps.riassegnaNumero).not.toHaveBeenCalledWith(piuVecchia.id, expect.anything());
  });

  it('chat gia\' aperta o con un inbound: non riceve niente', async () => {
    const coda = codaDi(3);
    const messaggi = new Map([[coda[0].id, { out: 1, in: 0 }], [coda[1].id, { out: 0, in: 1 }]]);
    const { deps, eventi } = finti({ coda, messaggi });
    const r = await eseguiRecupero(CFG, deps, ADESSO);
    expect(r.inviate).toBe(1);
    expect(r.gia_aperte).toBe(1);
    expect(eventi.find((e) => e.type === EVENTO_RECUPERO_SALTATA)?.payload.motivo).toBe('ha_scritto_lui');
  });

  it('lettura messaggi fallita: nessun invio e nessuna restituzione', async () => {
    const { deps } = finti({ coda: codaDi(3), messaggi: null });
    const r = await eseguiRecupero(CFG, deps, ADESSO);
    expect(r.inviate).toBe(0);
    expect(deps.invia).not.toHaveBeenCalled();
    expect(deps.restituisci).not.toHaveBeenCalled();
  });

  it('oltre 5 giorni: restituita al CRM (evento dedicato), anche a tetto esaurito', async () => {
    const vecchia = chat(9, '2026-11-01T06:00:00Z');
    const now = Date.parse('2026-11-16T10:00:00Z');
    const { deps, eventi } = finti({ coda: [vecchia], giaOggi: 40 });
    const r = await eseguiRecupero(CFG, deps, now);
    expect(r.inviate).toBe(0);
    expect(r.restituite).toBe(1);
    expect(deps.restituisci).toHaveBeenCalledWith(vecchia);
    expect(eventi.find((e) => e.type === EVENTO_RECUPERO_RESTITUITA)?.payload.conversationId).toBe(9);
  });

  it('oltre 5 giorni ma il CRM la sta lavorando: non si restituisce', async () => {
    const vecchia = chat(9, '2026-11-01T06:00:00Z');
    const { deps, eventi } = finti({ coda: [vecchia], lavorati: { 'crm-9': 'crm_in_progress' } });
    const r = await eseguiRecupero(CFG, deps, Date.parse('2026-11-16T10:00:00Z'));
    expect(r.restituite).toBe(0);
    expect(deps.restituisci).not.toHaveBeenCalled();
    expect(eventi.find((e) => e.type === EVENTO_RECUPERO_SALTATA)?.payload.motivo).toBe('crm_in_progress');
  });

  it('lead gia\' lavorato dal CRM o numero non WhatsApp: saltati col motivo, non consumano il lotto', async () => {
    const coda = codaDi(10);
    const a = coda[coda.length - 1];
    const b = coda[coda.length - 2];
    const c = coda[coda.length - 3];
    const { deps, eventi } = finti({
      coda,
      lavorati: { [a.crm_lead_id as string]: 'crm_appuntamento' },
      nonWa: { [b.phone as string]: true, [c.phone as string]: null },
    });
    const r = await eseguiRecupero(CFG, deps, ADESSO);
    expect(r.inviate).toBe(7);
    const motivi = eventi.filter((e) => e.type === EVENTO_RECUPERO_SALTATA).map((e) => e.payload.motivo);
    expect(motivi).toEqual(['crm_appuntamento', 'numero_non_whatsapp', 'errori_illeggibili']);
    const inviati = (deps.invia as ReturnType<typeof vi.fn>).mock.calls.map((x) => (x[0] as ChatCoda).id);
    expect(inviati).not.toContain(a.id);
    expect(inviati).not.toContain(b.id);
    expect(inviati).not.toContain(c.id);
  });

  it('frequency cap e invio fallito: saltate, non contano', async () => {
    const coda = codaDi(3);
    const { deps, eventi } = finti({
      coda,
      // coda[2] e' la piu' vecchia: parte per prima.
      esitoInvio: (id) => (id === coda[2].id ? { ok: false, capped: true } : id === coda[1].id ? { ok: false, error: 'boom' } : { ok: true }),
    });
    const r = await eseguiRecupero(CFG, deps, ADESSO);
    expect(r.inviate).toBe(1);
    const motivi = eventi.filter((e) => e.type === EVENTO_RECUPERO_SALTATA).map((e) => e.payload.motivo);
    expect(motivi).toEqual(['frequency_cap', 'invio_fallito']);
  });

  it('template di apertura non configurato: si ferma al primo', async () => {
    const { deps } = finti({ coda: codaDi(3), esitoInvio: () => ({ ok: false, configMancante: true }) });
    const r = await eseguiRecupero(CFG, deps, ADESSO);
    expect(r.inviate).toBe(0);
    expect(deps.invia).toHaveBeenCalledTimes(1);
  });

  it('una saltata gia\' scritta oggi per quella chat e motivo non si riscrive', async () => {
    const coda = codaDi(1);
    const { deps, eventi } = finti({ coda, messaggi: new Map([[coda[0].id, { out: 0, in: 1 }]]) });
    (deps.saltataOggi as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    await eseguiRecupero(CFG, deps, ADESSO);
    expect(eventi.filter((e) => e.type === EVENTO_RECUPERO_SALTATA)).toHaveLength(0);
  });

  it('tetti per numero: il meno carico finche\' ha posto, poi l\'altro; a tetti pieni basta', async () => {
    const coda = codaDi(8);
    const { deps, eventi } = finti({
      coda,
      numeri: [
        { numero: N2245, carico: 0, recuperiOggi: 0, tettoRecupero: 2 },
        { numero: N8718, carico: 40, recuperiOggi: 0, tettoRecupero: 3 },
      ],
    });
    const r = await eseguiRecupero({ ...CFG, numeri: [N2245, N8718] }, deps, ADESSO);
    const riass = (deps.riassegnaNumero as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1]);
    expect(riass).toEqual([N2245, N2245, N8718, N8718, N8718]);
    expect(r.inviate).toBe(5);
    expect(r.saltate.nessun_numero).toBe(1);
    expect(eventi.filter((e) => e.type === EVENTO_RECUPERO_SALTATA && e.payload.motivo === 'nessun_numero')).toHaveLength(1);
  });

  it('chat appena arrivate dopo le 12h (rete) non vengono mai prese', async () => {
    const { deps } = finti({ coda: [chat(1, new Date(ADESSO - 2 * H).toISOString())] });
    const r = await eseguiRecupero(CFG, deps, ADESSO);
    expect(r.inviate).toBe(0);
  });
});
