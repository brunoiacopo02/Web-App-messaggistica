import { describe, it, expect } from 'vitest';
import {
  TOUCH_OFFSETS_DAYS, SEQUENCE_END_DAYS, NUDGE1_MIN_H, NUDGE1_MAX_H, TRACKB_GIVEUP_H,
  inSendWindow, anyDelivered, allOutboundDeadNoDelivery, countSequenceTouches,
  firstOutboundAtMs, lastOutboundAtMs, decideTrackA, decideTrackB, pickNudgeText,
  type MsgLite,
  toRomeIso,
} from './sequence';

const H = 3600_000;
// Luglio: Europe/Rome = UTC+2. NOW = 12:00 Rome (in fascia).
const NOW = Date.parse('2026-07-15T10:00:00Z');
// 22:00 Rome (fuori fascia).
const NOW_NIGHT = Date.parse('2026-07-15T20:00:00Z');
const hAgo = (h: number, from = NOW) => new Date(from - h * H).toISOString();

const out = (hoursAgo: number, status: string | null, sid: string | null = null, from = NOW): MsgLite =>
  ({ direction: 'out', twilio_status: status, template_sid: sid, created_at: hAgo(hoursAgo, from) });
const inbound = (hoursAgo: number, from = NOW): MsgLite =>
  ({ direction: 'in', twilio_status: 'delivered', template_sid: null, created_at: hAgo(hoursAgo, from) });

const SEQ = ['HX1', 'HX2', 'HX3', 'HX4'];

describe('costanti', () => {
  it('valori del piano', () => {
    // Un solo follow-up: i touch 2/3/4 sono stati rimossi il 01/08/2026.
    expect(TOUCH_OFFSETS_DAYS).toEqual([1]);
    expect(SEQUENCE_END_DAYS).toBe(4);
    // 24/08/2026: resa da 288h (12gg) a 96h (4gg) e nudge da [18,24) a [12,24).
    // Misurato su 1.074 chat e 205 silenzi: vedi i commenti in lib/sequence.ts.
    expect([NUDGE1_MIN_H, NUDGE1_MAX_H, TRACKB_GIVEUP_H]).toEqual([12, 24, 96]);
  });
});

// La resa a 4 giorni non è un numero scelto a occhio: oltre le 96h di silenzio, su
// 55 lead tornati a scrivere, ZERO hanno poi fissato. Tutti gli 11 recuperi che sono
// finiti in appuntamento vengono da silenzi sotto le 96h.
describe('decideTrackB — la resa a 4 giorni', () => {
  const base = { nudgesSent: 1, sequenceEnabled: true };
  // Mezzogiorno di Roma: dentro la fascia d'invio, così il ramo nudge non interferisce.
  const ORA = Date.parse('2026-08-26T10:00:00Z');
  const silenzioDa = (ore: number) => ({ nowMs: ORA, lastInboundAtMs: ORA - ore * 3600_000, ...base });

  it('a 95 ore il lead è ancora nostro: non si restituisce', () => {
    expect(decideTrackB(silenzioDa(95)).kind).not.toBe('classify');
  });

  it('a 96 ore tonde si restituisce', () => {
    expect(decideTrackB(silenzioDa(96))).toEqual({ kind: 'classify' });
  });

  it('non aspetta piu' + ' i 12 giorni di prima', () => {
    expect(decideTrackB(silenzioDa(200))).toEqual({ kind: 'classify' });
  });

  it('la resa classifica anche a sequenza spenta e fuori fascia: non è un invio', () => {
    const notte = Date.parse('2026-08-26T01:00:00Z');
    expect(
      decideTrackB({ nowMs: notte, lastInboundAtMs: notte - 100 * 3600_000, nudgesSent: 1, sequenceEnabled: false })
    ).toEqual({ kind: 'classify' });
  });
});

// Il nudge free-text vive dentro la finestra 24h di WhatsApp: oltre, servirebbe un
// template, che su un numero LOW costa reputazione e (misurato) non porta un solo
// appuntamento. Con la vecchia soglia a 18h un lead che taceva fra mezzanotte e le
// 08:30 non poteva riceverlo MAI: [18,24) gli cadeva tutta fuori dalla fascia d'invio.
describe('decideTrackB — la finestra del nudge copre anche chi tace di notte', () => {
  it('lead zitto dalle 07:00: alle 19:00 dello stesso giorno il nudge è ancora possibile', () => {
    // 07:00 Rome = 05:00Z; 19:00 Rome = 17:00Z → 12 ore di silenzio.
    const now = Date.parse('2026-08-26T17:00:00Z');
    expect(
      decideTrackB({ nowMs: now, lastInboundAtMs: Date.parse('2026-08-26T05:00:00Z'), nudgesSent: 0, sequenceEnabled: true })
    ).toEqual({ kind: 'nudge_free' });
  });

  it('sotto le 12 ore è troppo presto: non si insegue un lead che ha appena scritto', () => {
    const now = Date.parse('2026-08-26T14:00:00Z');
    expect(
      decideTrackB({ nowMs: now, lastInboundAtMs: now - 11 * 3600_000, nudgesSent: 0, sequenceEnabled: true }).kind
    ).toBe('wait');
  });

  it('oltre le 24 ore la finestra WhatsApp è chiusa: niente free-text', () => {
    const now = Date.parse('2026-08-26T14:00:00Z');
    expect(
      decideTrackB({ nowMs: now, lastInboundAtMs: now - 25 * 3600_000, nudgesSent: 0, sequenceEnabled: true }).kind
    ).not.toBe('nudge_free');
  });
});

describe('inSendWindow (Europe/Rome, 08:30–20:30)', () => {
  it('07:00 Rome (estate) → false', () => expect(inSendWindow(Date.parse('2026-07-15T05:00:00Z'))).toBe(false));
  it('09:00 Rome (estate) → true', () => expect(inSendWindow(Date.parse('2026-07-15T07:00:00Z'))).toBe(true));
  it('21:00 Rome (estate) → false', () => expect(inSendWindow(Date.parse('2026-07-15T19:00:00Z'))).toBe(false));
  it('08:30 Rome esatte → true', () => expect(inSendWindow(Date.parse('2026-07-15T06:30:00Z'))).toBe(true));
  it('08:29 Rome → false', () => expect(inSendWindow(Date.parse('2026-07-15T06:29:00Z'))).toBe(false));
  it('20:29 Rome → true', () => expect(inSendWindow(Date.parse('2026-07-15T18:29:00Z'))).toBe(true));
  it('20:30 Rome → false', () => expect(inSendWindow(Date.parse('2026-07-15T18:30:00Z'))).toBe(false));
  // Inverno: Rome = UTC+1 (l'implementazione non deve hardcodare l'offset)
  it('09:00 Rome (inverno, 08:00Z) → true', () => expect(inSendWindow(Date.parse('2026-01-15T08:00:00Z'))).toBe(true));
  it('08:00 Rome (inverno, 07:00Z) → false', () => expect(inSendWindow(Date.parse('2026-01-15T07:00:00Z'))).toBe(false));
});

describe('helpers su MsgLite', () => {
  it('anyDelivered: out delivered → true', () => expect(anyDelivered([out(5, 'delivered')])).toBe(true));
  it('anyDelivered: out read → true', () => expect(anyDelivered([out(5, 'read')])).toBe(true));
  it('anyDelivered: solo sent/undelivered → false', () =>
    expect(anyDelivered([out(5, 'sent'), out(3, 'undelivered')])).toBe(false));
  it('anyDelivered: inbound non conta', () => expect(anyDelivered([inbound(5)])).toBe(false));

  it('allOutboundDeadNoDelivery: undelivered+failed → true', () =>
    expect(allOutboundDeadNoDelivery([out(5, 'undelivered'), out(3, 'failed')])).toBe(true));
  it('allOutboundDeadNoDelivery: uno sent (esito ignoto) → false', () =>
    expect(allOutboundDeadNoDelivery([out(5, 'undelivered'), out(3, 'sent')])).toBe(false));
  it('allOutboundDeadNoDelivery: uno delivered → false', () =>
    expect(allOutboundDeadNoDelivery([out(5, 'failed'), out(3, 'delivered')])).toBe(false));
  it('allOutboundDeadNoDelivery: nessun out → false', () =>
    expect(allOutboundDeadNoDelivery([inbound(5)])).toBe(false));

  it('countSequenceTouches: conta solo out con sid della sequenza', () => {
    const msgs = [out(30, 'delivered', 'HXopening'), out(20, 'delivered', 'HX1'), out(10, 'sent', 'HX2'), inbound(5)];
    expect(countSequenceTouches(msgs, SEQ)).toBe(2);
  });

  it('first/lastOutboundAtMs', () => {
    const msgs = [out(30, 'delivered'), inbound(40), out(10, 'sent')];
    expect(firstOutboundAtMs(msgs)).toBe(NOW - 30 * H);
    expect(lastOutboundAtMs(msgs)).toBe(NOW - 10 * H);
    expect(firstOutboundAtMs([inbound(5)])).toBeNull();
    expect(lastOutboundAtMs([])).toBeNull();
  });
});

describe('decideTrackA — apertura differita', () => {
  it('nessun outbound, in fascia, enabled → send_opening', () => {
    expect(decideTrackA({ nowMs: NOW, msgs: [], seqSids: SEQ, sequenceEnabled: true })).toEqual({ kind: 'send_opening' });
  });
  it('nessun outbound, fuori fascia → wait', () => {
    expect(decideTrackA({ nowMs: NOW_NIGHT, msgs: [], seqSids: SEQ, sequenceEnabled: true })).toEqual({ kind: 'wait' });
  });
  it('nessun outbound, kill-switch off → wait', () => {
    expect(decideTrackA({ nowMs: NOW, msgs: [], seqSids: SEQ, sequenceEnabled: false })).toEqual({ kind: 'wait' });
  });
});

describe('decideTrackA — fast-fail numero morto', () => {
  it('1 touch, tutto undelivered/failed, 49h da t0 → discard_dead', () => {
    const msgs = [out(49, 'undelivered'), out(25, 'failed', 'HX1')];
    expect(decideTrackA({ nowMs: NOW, msgs, seqSids: SEQ, sequenceEnabled: true })).toEqual({ kind: 'discard_dead' });
  });
  it('fast-fail attivo anche con kill-switch off (non è un invio)', () => {
    const msgs = [out(49, 'undelivered'), out(25, 'failed', 'HX1')];
    expect(decideTrackA({ nowMs: NOW, msgs, seqSids: SEQ, sequenceEnabled: false })).toEqual({ kind: 'discard_dead' });
  });
  it('0 touch (solo apertura morta) a 49h → NO fast-fail (serve touches>=1)', () => {
    const msgs = [out(49, 'undelivered')];
    // in fascia: tocca il touch 1 (offset 1g superato, anti-doppione ok)
    expect(decideTrackA({ nowMs: NOW, msgs, seqSids: SEQ, sequenceEnabled: true })).toEqual({ kind: 'send_touch', touchIndex: 1 });
  });
  it('touch morto ma solo 40h da t0 → niente fast-fail', () => {
    const msgs = [out(40, 'undelivered'), out(21, 'failed', 'HX1')];
    expect(decideTrackA({ nowMs: NOW, msgs, seqSids: SEQ, sequenceEnabled: true })).toEqual({ kind: 'wait' });
  });
});

describe('decideTrackA — classificazione finale a 4 giorni', () => {
  it('4g, almeno un delivered → non_risposto', () => {
    const msgs = [out(4 * 24, 'delivered'), out(3 * 24, 'sent', 'HX1')];
    expect(decideTrackA({ nowMs: NOW, msgs, seqSids: SEQ, sequenceEnabled: true })).toEqual({ kind: 'non_risposto' });
  });
  it('3g e mezzo, touch già speso → wait (non ancora chiusa)', () => {
    const msgs = [out(84, 'delivered'), out(60, 'delivered', 'HX1')];
    expect(decideTrackA({ nowMs: NOW, msgs, seqSids: SEQ, sequenceEnabled: true })).toEqual({ kind: 'wait' });
  });
  it('4g, mai consegnato nulla → discard_dead', () => {
    const msgs = [out(4 * 24, 'sent'), out(3 * 24, 'sent', 'HX1')];
    expect(decideTrackA({ nowMs: NOW, msgs, seqSids: SEQ, sequenceEnabled: true })).toEqual({ kind: 'discard_dead' });
  });
  it('classificazione finale ATTIVA con kill-switch off', () => {
    const msgs = [out(4 * 24, 'delivered')];
    expect(decideTrackA({ nowMs: NOW, msgs, seqSids: SEQ, sequenceEnabled: false })).toEqual({ kind: 'non_risposto' });
  });
  it('classificazione finale anche fuori fascia', () => {
    const msgs = [out(4 * 24, 'delivered', null, NOW_NIGHT)];
    expect(decideTrackA({ nowMs: NOW_NIGHT, msgs, seqSids: SEQ, sequenceEnabled: true })).toEqual({ kind: 'non_risposto' });
  });
  it('vecchia conversazione a 14g resta classificabile', () => {
    const msgs = [out(14 * 24, 'delivered'), out(13 * 24, 'sent', 'HX1')];
    expect(decideTrackA({ nowMs: NOW, msgs, seqSids: SEQ, sequenceEnabled: true })).toEqual({ kind: 'non_risposto' });
  });
});

describe('decideTrackA — touch della sequenza', () => {
  it('touch 1 dovuto a +1g dal primo out (delivered) → send_touch(1)', () => {
    const msgs = [out(26, 'delivered')];
    expect(decideTrackA({ nowMs: NOW, msgs, seqSids: SEQ, sequenceEnabled: true })).toEqual({ kind: 'send_touch', touchIndex: 1 });
  });
  it('touch già speso a +3g → wait: il secondo follow-up non esiste più', () => {
    const msgs = [out(3 * 24, 'delivered'), out(2 * 24, 'delivered', 'HX1')];
    expect(decideTrackA({ nowMs: NOW, msgs, seqSids: SEQ, sequenceEnabled: true })).toEqual({ kind: 'wait' });
  });
  it('anti-doppione: ultimo out < 20h fa → wait', () => {
    const msgs = [out(26, 'delivered'), out(5, 'sent')];
    expect(decideTrackA({ nowMs: NOW, msgs, seqSids: SEQ, sequenceEnabled: true })).toEqual({ kind: 'wait' });
  });
  it('touch dovuto ma fuori fascia → wait', () => {
    const msgs = [out(26, 'delivered', null, NOW_NIGHT)];
    expect(decideTrackA({ nowMs: NOW_NIGHT, msgs, seqSids: SEQ, sequenceEnabled: true })).toEqual({ kind: 'wait' });
  });
  it('touch dovuto ma kill-switch off → wait', () => {
    const msgs = [out(26, 'delivered')];
    expect(decideTrackA({ nowMs: NOW, msgs, seqSids: SEQ, sequenceEnabled: false })).toEqual({ kind: 'wait' });
  });
  it('offset non ancora raggiunto (12h dal primo out) → wait', () => {
    const msgs = [out(12, 'delivered')];
    expect(decideTrackA({ nowMs: NOW, msgs, seqSids: SEQ, sequenceEnabled: true })).toEqual({ kind: 'wait' });
  });
  it('conversazione della vecchia sequenza (più touch già presi) → mai un altro touch', () => {
    // Chi era già a metà sequenza quando il taglio è entrato in vigore: i touch
    // storici restano contati, quindi si va dritti alla classificazione.
    const msgs = [
      out(80, 'delivered'),
      out(60, 'delivered', 'HX1'), out(40, 'delivered', 'HX2'), out(21, 'delivered', 'HX3'),
    ];
    expect(decideTrackA({ nowMs: NOW, msgs, seqSids: SEQ, sequenceEnabled: true })).toEqual({ kind: 'wait' });
  });
});

describe('decideTrackB', () => {
  const dec = (silH: number, nudgesSent: number, opts: { now?: number; enabled?: boolean } = {}) =>
    decideTrackB({
      nowMs: opts.now ?? NOW,
      lastInboundAtMs: (opts.now ?? NOW) - silH * H,
      nudgesSent,
      sequenceEnabled: opts.enabled ?? true,
    });

  it('11h di silenzio → wait: ha appena scritto, non lo si insegue', () => expect(dec(11, 0)).toEqual({ kind: 'wait' }));
  it('12h, in fascia, 0 nudge → nudge_free (soglia abbassata il 24/08)', () => expect(dec(12, 0)).toEqual({ kind: 'nudge_free' }));
  it('20h, in fascia, 0 nudge → nudge_free', () => expect(dec(20, 0)).toEqual({ kind: 'nudge_free' }));
  it('20h ma fuori fascia → wait', () => expect(dec(20, 0, { now: NOW_NIGHT })).toEqual({ kind: 'wait' }));
  it('20h ma kill-switch off → wait', () => expect(dec(20, 0, { enabled: false })).toEqual({ kind: 'wait' }));
  it('24h esatte, 0 nudge → wait (finestra [12,24) chiusa, e la resa e ancora lontana)', () => expect(dec(24, 0)).toEqual({ kind: 'wait' }));
  it('nudge già speso: nessun secondo richiamo finche non scatta la resa', () => {
    for (const h of [20, 30, 48, 50, 95]) expect(dec(h, 1)).toEqual({ kind: 'wait' });
  });
  it('50h con nudgesSent=0 → wait (niente template fuori finestra)', () =>
    expect(dec(50, 0)).toEqual({ kind: 'wait' }));
  // 24/08/2026: la resa scende a 96h. Su 55 lead tornati dopo piu' di 96h di
  // silenzio, ZERO hanno poi fissato: tenerli fermi altri otto giorni non recupera
  // niente e ritarda solo la restituzione ai GDO.
  it('96h con nudgesSent=0 → classify: e la resa, non un invio', () => expect(dec(96, 0)).toEqual({ kind: 'classify' }));
  it('a 120h si classifica: oltre le 96h non torna piu nessuno che converta', () => {
    expect(dec(120, 1)).toEqual({ kind: 'classify' });
    expect(dec(200, 1, { now: NOW_NIGHT, enabled: false })).toEqual({ kind: 'classify' });
  });

  it('la resa classifica anche fuori fascia e con kill-switch off', () => {
    expect(dec(96, 0)).toEqual({ kind: 'classify' });
    expect(dec(300, 3, { now: NOW_NIGHT, enabled: false })).toEqual({ kind: 'classify' });
  });

  it('non si classifica finche il nudge gratuito e ancora da spendere', () => {
    // Silenzio dentro la finestra del nudge e nudge non ancora mandato: non abbiamo
    // finito di lavorare il lead, quindi non lo restituiamo.
    expect(dec(20, 0, { enabled: false })).toEqual({ kind: 'wait' });
  });

  it('chi perde comunque la finestra free arriva alla resa senza toccare un template', () => {
    // Se il cron gira solo di notte la finestra free si perde: oltre le 24h WhatsApp
    // non consente piu' il free-text, e un template non si manda (costa reputazione
    // su un numero LOW e non ha mai portato un appuntamento).
    expect(dec(20, 0, { now: NOW_NIGHT })).toEqual({ kind: 'wait' });
    expect(dec(30, 0)).toEqual({ kind: 'wait' });
    expect(dec(48, 0)).toEqual({ kind: 'wait' });
    // Resta solo la resa, ora a 96h.
    expect(dec(96, 0)).toEqual({ kind: 'classify' });
  });
});

describe('pickNudgeText', () => {
  it('3 varianti a rotazione per conversationId % 3', () => {
    const [a, b, c] = [pickNudgeText(0, null), pickNudgeText(1, null), pickNudgeText(2, null)];
    expect(new Set([a, b, c]).size).toBe(3);
    expect(pickNudgeText(3, null)).toBe(a);
    expect(pickNudgeText(4, null)).toBe(b);
  });
  it('include il nome se presente', () => {
    for (const id of [0, 1, 2]) expect(pickNudgeText(id, 'Luca')).toContain('Luca');
  });
  it('senza nome resta una frase pulita (niente doppi spazi o placeholder)', () => {
    for (const id of [0, 1, 2]) {
      const t = pickNudgeText(id, null);
      expect(t.length).toBeGreaterThan(10);
      expect(t).not.toMatch(/  |\{|\}|undefined|null/);
    }
  });
  it("default: firma come Mario (persona omessa = 'Mario')", () => {
    for (const id of [0, 1, 2]) {
      expect(pickNudgeText(id, 'Luca')).toContain('Mario');
      expect(pickNudgeText(id, 'Luca')).toBe(pickNudgeText(id, 'Luca', 'Mario'));
    }
  });
  it("personaName 'Marta': firma come Marta in tutte le varianti, mai Mario", () => {
    for (const id of [0, 1, 2]) {
      const t = pickNudgeText(id, 'Luca', 'Marta');
      expect(t).toContain('Marta');
      expect(t).not.toContain('Mario');
      expect(t).toContain('Luca');
      expect(t).not.toMatch(/  |\{|\}|undefined|null/);
    }
  });
  it('rotazione id % 3 invariata anche con persona esplicita', () => {
    const [a, b, c] = [0, 1, 2].map((id) => pickNudgeText(id, null, 'Marta'));
    expect(new Set([a, b, c]).size).toBe(3);
    expect(pickNudgeText(3, null, 'Marta')).toBe(a);
  });
});

describe('toRomeIso', () => {
  it('estate: offset +02:00', () => {
    // 2026-07-24T10:00:00Z = 12:00 a Roma (CEST)
    const iso = toRomeIso(Date.parse('2026-07-24T10:00:00Z'));
    expect(iso).toBe('2026-07-24T12:00:00+02:00');
  });
  it('inverno: offset +01:00', () => {
    // 2026-01-15T10:00:00Z = 11:00 a Roma (CET)
    const iso = toRomeIso(Date.parse('2026-01-15T10:00:00Z'));
    expect(iso).toBe('2026-01-15T11:00:00+01:00');
  });
});
