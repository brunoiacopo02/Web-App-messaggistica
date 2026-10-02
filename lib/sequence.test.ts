import { describe, it, expect } from 'vitest';
import {
  TOUCH_OFFSETS_DAYS, SEQUENCE_END_DAYS, NUDGE1_MIN_H, NUDGE1_MAX_H, TRACKB_GIVEUP_H,
  inSendWindow, inOpeningWindow, anyDelivered, allOutboundDeadNoDelivery, countSequenceTouches,
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
    // 02/10/2026 (PO): i lead nuovi tornano ai GDO dopo 24 ore. Chiusura Track A da 4
    // giorni a 1, resa Track B da 96h a 24h; il nudge resta a [12,24).
    expect(SEQUENCE_END_DAYS).toBe(1);
    expect([NUDGE1_MIN_H, NUDGE1_MAX_H, TRACKB_GIVEUP_H]).toEqual([12, 24, 24]);
  });

  it("il touch di sequenza cade dentro la chiusura: non puo' partire (voluto)", () => {
    // decideTrackA controlla la chiusura PRIMA del touch: con l'offset del touch 1 non
    // inferiore alla chiusura, il touch non esce mai. Se qualcuno riabbassa l'offset o
    // rialza la chiusura, questo test lo obbliga a chiedersi se il touch deve ripartire.
    expect(TOUCH_OFFSETS_DAYS[0]).toBeGreaterThanOrEqual(SEQUENCE_END_DAYS);
  });
});

// 02/10/2026 — decisione PO: "dopo 24 ore che la persona non risponde torna ai GDO".
// La resa del Track B scende da 96h a 24h; il nudge free-text a 12-24h resta.
describe('decideTrackB — la resa a 24 ore', () => {
  const base = { nudgesSent: 1, sequenceEnabled: true };
  // Mezzogiorno di Roma: dentro la fascia d'invio, così il ramo nudge non interferisce.
  const ORA = Date.parse('2026-08-26T10:00:00Z');
  const silenzioDa = (ore: number) => ({ nowMs: ORA, lastInboundAtMs: ORA - ore * 3600_000, ...base });

  it('a 23 ore il lead è ancora nostro: non si restituisce', () => {
    expect(decideTrackB(silenzioDa(23))).toEqual({ kind: 'wait' });
    expect(decideTrackB(silenzioDa(23.99))).toEqual({ kind: 'wait' });
  });

  it('a 24 ore tonde si restituisce', () => {
    expect(decideTrackB(silenzioDa(24))).toEqual({ kind: 'classify' });
  });

  it('non aspetta piu' + ' le 96h di prima', () => {
    expect(decideTrackB(silenzioDa(48))).toEqual({ kind: 'classify' });
    expect(decideTrackB(silenzioDa(95))).toEqual({ kind: 'classify' });
  });

  it('la resa classifica anche a sequenza spenta e fuori fascia: non è un invio', () => {
    const notte = Date.parse('2026-08-26T01:00:00Z');
    expect(
      decideTrackB({ nowMs: notte, lastInboundAtMs: notte - 24 * 3600_000, nudgesSent: 1, sequenceEnabled: false })
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

// 11/09/2026. Misurato su 3.814 conversazioni in 14 giorni: di giorno il primo
// messaggio parte a 0 minuti, ma chi arriva alle 21 aspetta 13 ORE e chi arriva
// alle 07 ne aspetta 2,6. Il 16% di tutti i lead sta in quelle due code (21-23 e
// 07-08). La PRIMA apertura si allarga a 07:00-23:00; i touch e i nudge restano
// nella fascia stretta, perche' quelli nessuno li sta aspettando.
describe('inOpeningWindow (Europe/Rome, 07:00-23:00)', () => {
  it('07:00 Rome (estate) → true', () => expect(inOpeningWindow(Date.parse('2026-07-15T05:00:00Z'))).toBe(true));
  it('06:59 Rome (estate) → false', () => expect(inOpeningWindow(Date.parse('2026-07-15T04:59:00Z'))).toBe(false));
  it('22:59 Rome (estate) → true', () => expect(inOpeningWindow(Date.parse('2026-07-15T20:59:00Z'))).toBe(true));
  it('23:00 Rome (estate) → false', () => expect(inOpeningWindow(Date.parse('2026-07-15T21:00:00Z'))).toBe(false));
  it('03:00 Rome, cuore della notte → false', () => expect(inOpeningWindow(Date.parse('2026-07-15T01:00:00Z'))).toBe(false));
  // Inverno: Rome = UTC+1. Il cron di vercel.json e' in UTC e scivola di un'ora al
  // cambio d'ora: la fascia vera la decide questa funzione, non il cron.
  it('07:00 Rome (inverno, 06:00Z) → true', () => expect(inOpeningWindow(Date.parse('2026-01-15T06:00:00Z'))).toBe(true));
  it('06:00 Rome (inverno, 05:00Z) → false', () => expect(inOpeningWindow(Date.parse('2026-01-15T05:00:00Z'))).toBe(false));
  it('22:30 Rome (inverno, 21:30Z) → true', () => expect(inOpeningWindow(Date.parse('2026-01-15T21:30:00Z'))).toBe(true));
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
  it('nessun outbound alle 22 di sera → si apre lo stesso: chi ha appena lasciato il numero e sveglio e aspetta', () => {
    expect(decideTrackA({ nowMs: NOW_NIGHT, msgs: [], seqSids: SEQ, sequenceEnabled: true })).toEqual({ kind: 'send_opening' });
  });
  it('nessun outbound alle 03 di notte → wait: nel cuore della notte non si scrive', () => {
    const notteFonda = Date.parse('2026-07-15T01:00:00Z');
    expect(decideTrackA({ nowMs: notteFonda, msgs: [], seqSids: SEQ, sequenceEnabled: true })).toEqual({ kind: 'wait' });
  });
  it('nessun outbound, kill-switch off → wait', () => {
    expect(decideTrackA({ nowMs: NOW, msgs: [], seqSids: SEQ, sequenceEnabled: false })).toEqual({ kind: 'wait' });
  });
});

// 02/10/2026: la chiusura scende a 24h, e 24h e' anche l'offset del touch 1. In
// decideTrackA la chiusura viene controllata prima del touch, quindi il touch non parte
// MAI, a nessuna ora, con qualunque combinazione di flag: e' voluto (il touch e' anche
// sospeso da env dal 24/09). Questi test sostituiscono quelli che verificavano fascia,
// anti-doppione e kill-switch del touch: con il touch irraggiungibile erano ridondanti.
describe('decideTrackA — il touch di sequenza non parte mai prima della chiusura', () => {
  const tutteLeCombinazioni = (ore: number, status: string, from: number) =>
    [true, false].flatMap((sequenceEnabled) => [true, false].map((touchEnabled) =>
      decideTrackA({ nowMs: from, msgs: [out(ore, status, 'HXopening', from)], seqSids: SEQ, sequenceEnabled, touchEnabled })));

  it('a mezzogiorno e alle 22, da 0 a 14 giorni, con qualunque flag: mai send_touch', () => {
    for (const from of [NOW, NOW_NIGHT]) {
      for (let ore = 0; ore <= 14 * 24; ore += 0.5) {
        for (const status of ['delivered', 'read', 'sent', 'undelivered']) {
          for (const a of tutteLeCombinazioni(ore, status, from)) expect(a.kind).not.toBe('send_touch');
        }
      }
    }
  });

  it('sotto le 24h si aspetta, da 24h si chiude: niente in mezzo', () => {
    const decidi = (ore: number) =>
      decideTrackA({ nowMs: NOW, msgs: [out(ore, 'delivered', 'HXopening')], seqSids: SEQ, sequenceEnabled: true, touchEnabled: true });
    for (let ore = 1; ore < 24; ore += 0.5) expect(decidi(ore)).toEqual({ kind: 'wait' });
    expect(decidi(23.99)).toEqual({ kind: 'wait' });
    for (const ore of [24, 24.5, 26, 30, 48]) expect(decidi(ore)).toEqual({ kind: 'non_risposto' });
  });

  it('conversazione della vecchia sequenza (più touch già presi) → mai un altro touch, si chiude', () => {
    // Chi era già a metà sequenza quando i tagli sono entrati in vigore: i touch storici
    // restano contati, e si va dritti alla classificazione.
    const msgs = [
      out(80, 'delivered'),
      out(60, 'delivered', 'HX1'), out(40, 'delivered', 'HX2'), out(21, 'delivered', 'HX3'),
    ];
    expect(decideTrackA({ nowMs: NOW, msgs, seqSids: SEQ, sequenceEnabled: true })).toEqual({ kind: 'non_risposto' });
  });

  it('offset del touch non ancora raggiunto (12h dal primo out) → wait', () => {
    const msgs = [out(12, 'delivered')];
    expect(decideTrackA({ nowMs: NOW, msgs, seqSids: SEQ, sequenceEnabled: true })).toEqual({ kind: 'wait' });
  });
});

// 24/09/2026: il touch "Ti ho scritto ieri" (MARKETING a chi non ha mai risposto) e'
// sospeso per la qualita' dei numeri. Le aperture differite e la chiusura a fine
// sequenza non dipendono da lui e devono continuare.
describe('decideTrackA — touch sospeso', () => {
  it('touch sospeso, prima della chiusura → wait', () => {
    const msgs = [out(23, 'delivered', 'HXopening')];
    expect(decideTrackA({ nowMs: NOW, msgs, seqSids: SEQ, sequenceEnabled: true, touchEnabled: false })).toEqual({ kind: 'wait' });
  });
  it("con il touch sospeso l'apertura differita parte lo stesso", () => {
    expect(decideTrackA({ nowMs: NOW, msgs: [], seqSids: SEQ, sequenceEnabled: true, touchEnabled: false })).toEqual({ kind: 'send_opening' });
  });
  it('con il touch sospeso la chiusura a fine sequenza arriva lo stesso, a 24h', () => {
    const msgs = [out(24, 'delivered', 'HXopening')];
    expect(decideTrackA({ nowMs: NOW, msgs, seqSids: SEQ, sequenceEnabled: true, touchEnabled: false })).toEqual({ kind: 'non_risposto' });
  });
});

// Il fast-fail (48h, serve un touch gia' partito) dal 02/10/2026 non arriva mai prima
// della chiusura a 24h: un numero mai consegnato esce a 24h come discard_dead dalla
// chiusura, con lo stesso esito che gli avrebbe dato il fast-fail. Questi test
// verificano che i due rami non si contraddicano.
describe('decideTrackA — numero morto: la chiusura a 24h arriva prima del fast-fail', () => {
  it('1 touch, tutto undelivered/failed, 49h da t0 → discard_dead', () => {
    const msgs = [out(49, 'undelivered'), out(25, 'failed', 'HX1')];
    expect(decideTrackA({ nowMs: NOW, msgs, seqSids: SEQ, sequenceEnabled: true })).toEqual({ kind: 'discard_dead' });
  });
  it('fast-fail attivo anche con kill-switch off (non è un invio)', () => {
    const msgs = [out(49, 'undelivered'), out(25, 'failed', 'HX1')];
    expect(decideTrackA({ nowMs: NOW, msgs, seqSids: SEQ, sequenceEnabled: false })).toEqual({ kind: 'discard_dead' });
  });
  it('solo apertura morta (0 touch): a 23h wait, a 24h discard_dead senza aspettare le 48h', () => {
    expect(decideTrackA({ nowMs: NOW, msgs: [out(23, 'undelivered')], seqSids: SEQ, sequenceEnabled: true })).toEqual({ kind: 'wait' });
    expect(decideTrackA({ nowMs: NOW, msgs: [out(24, 'undelivered')], seqSids: SEQ, sequenceEnabled: true })).toEqual({ kind: 'discard_dead' });
  });
  it('touch morto a 40h: il fast-fail non è ancora scattato, la chiusura sì → discard_dead', () => {
    const msgs = [out(40, 'undelivered'), out(21, 'failed', 'HX1')];
    expect(decideTrackA({ nowMs: NOW, msgs, seqSids: SEQ, sequenceEnabled: true })).toEqual({ kind: 'discard_dead' });
  });
  it('fra le 24 e le 60h un numero morto ha sempre lo stesso esito, con o senza touch', () => {
    for (let ore = 24; ore <= 60; ore++) {
      const senzaTouch = [out(ore, 'failed')];
      const conTouch = [out(ore, 'failed'), out(ore / 2, 'undelivered', 'HX1')];
      for (const msgs of [senzaTouch, conTouch]) {
        expect(decideTrackA({ nowMs: NOW, msgs, seqSids: SEQ, sequenceEnabled: true })).toEqual({ kind: 'discard_dead' });
      }
    }
  });
});

describe('decideTrackA — classificazione finale a 24 ore', () => {
  it('24h, almeno un delivered → non_risposto', () => {
    const msgs = [out(24, 'delivered')];
    expect(decideTrackA({ nowMs: NOW, msgs, seqSids: SEQ, sequenceEnabled: true })).toEqual({ kind: 'non_risposto' });
  });
  it('23h, consegnato → wait (non ancora chiusa: il lead è ancora nostro)', () => {
    const msgs = [out(23, 'delivered')];
    expect(decideTrackA({ nowMs: NOW, msgs, seqSids: SEQ, sequenceEnabled: true })).toEqual({ kind: 'wait' });
  });
  it('24h, mai consegnato nulla → discard_dead', () => {
    const msgs = [out(24, 'sent')];
    expect(decideTrackA({ nowMs: NOW, msgs, seqSids: SEQ, sequenceEnabled: true })).toEqual({ kind: 'discard_dead' });
  });
  it('23h, mai consegnato nulla → wait', () => {
    const msgs = [out(23, 'sent')];
    expect(decideTrackA({ nowMs: NOW, msgs, seqSids: SEQ, sequenceEnabled: true })).toEqual({ kind: 'wait' });
  });
  it('classificazione finale ATTIVA con kill-switch off', () => {
    const msgs = [out(24, 'delivered')];
    expect(decideTrackA({ nowMs: NOW, msgs, seqSids: SEQ, sequenceEnabled: false })).toEqual({ kind: 'non_risposto' });
  });
  it('classificazione finale anche fuori fascia', () => {
    const msgs = [out(24, 'delivered', null, NOW_NIGHT)];
    expect(decideTrackA({ nowMs: NOW_NIGHT, msgs, seqSids: SEQ, sequenceEnabled: true })).toEqual({ kind: 'non_risposto' });
  });
  it('vecchia conversazione a 14g resta classificabile', () => {
    const msgs = [out(14 * 24, 'delivered'), out(13 * 24, 'sent', 'HX1')];
    expect(decideTrackA({ nowMs: NOW, msgs, seqSids: SEQ, sequenceEnabled: true })).toEqual({ kind: 'non_risposto' });
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
  // La resa a 24h non ruba la finestra del nudge: fino a 23h59 il nudge e' ancora dovuto.
  it('23h, in fascia, 0 nudge → nudge_free (l ultima ora utile della finestra)', () => expect(dec(23, 0)).toEqual({ kind: 'nudge_free' }));
  it('24h esatte, 0 nudge → classify (finestra [12,24) chiusa, ed e la resa)', () => expect(dec(24, 0)).toEqual({ kind: 'classify' }));
  it('nudge già speso: nessun secondo richiamo finche non scatta la resa', () => {
    for (const h of [12, 20, 23, 23.99]) expect(dec(h, 1)).toEqual({ kind: 'wait' });
    expect(dec(24, 1)).toEqual({ kind: 'classify' });
  });
  it('50h con nudgesSent=0 → classify, mai un template fuori finestra', () =>
    expect(dec(50, 0)).toEqual({ kind: 'classify' }));
  // 02/10/2026: la resa scende da 96h a 24h (PO: dopo 24 ore di silenzio il lead torna
  // ai GDO). Era 96h dal 24/08, 288h prima ancora.
  it('a 120h si classifica: ben oltre la resa', () => {
    expect(dec(120, 1)).toEqual({ kind: 'classify' });
    expect(dec(200, 1, { now: NOW_NIGHT, enabled: false })).toEqual({ kind: 'classify' });
  });

  it('la resa classifica anche fuori fascia e con kill-switch off', () => {
    expect(dec(24, 0, { now: NOW_NIGHT, enabled: false })).toEqual({ kind: 'classify' });
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
    expect(dec(23, 0, { now: NOW_NIGHT })).toEqual({ kind: 'wait' });
    // Resta solo la resa, ora a 24h: nessun invio fra la finestra persa e la restituzione.
    expect(dec(24, 0)).toEqual({ kind: 'classify' });
    expect(dec(24, 0, { now: NOW_NIGHT })).toEqual({ kind: 'classify' });
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
