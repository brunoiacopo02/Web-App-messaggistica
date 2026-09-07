import { describe, it, expect } from 'vitest';
import {
  decideFollowupAction,
  serveCronologia,
  ultimaAttivitaMs,
  ultimoMessaggioEInbound,
  type CronConvRow,
} from './bot-followups';
import type { MsgLite } from './sequence';

const H = 3600_000;
const D = 24 * H;
// 12:00 Europe/Rome (luglio, UTC+2): dentro la fascia invii — cosí i rami
// send_touch/nudge sono raggiungibili e verifichiamo che mappino su 'none'.
const NOW = Date.parse('2026-07-15T10:00:00Z');
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();

const SEQ_SIDS = ['HXseq1', 'HXseq2', 'HXseq3', 'HXseq4'];

const out = (msAgo: number, status: string | null, template_sid: string | null = null): MsgLite => ({
  direction: 'out', twilio_status: status, template_sid, created_at: at(msAgo),
});
const inb = (msAgo: number): MsgLite => ({
  direction: 'in', twilio_status: null, template_sid: null, created_at: at(msAgo),
});

const decide = (over: Partial<Parameters<typeof decideFollowupAction>[0]>) =>
  decideFollowupAction({
    nowMs: NOW,
    msgs: [],
    seqSids: SEQ_SIDS,
    hasInbound: false,
    lastInboundAtMs: null,
    sequenceEnabled: false,
    ...over,
  });

describe('decideFollowupAction — lead dei GDO (modalità postino)', () => {
  // Il lead non è nostro: l'esito lo decide il commerciale che ha in mano la trattativa.
  // Una classificazione automatica arriverebbe al CRM come esito su un lead altrui.
  it('mai NON_RISPOSTO su un lead del GDO, nemmeno a 14 giorni di silenzio', () => {
    expect(decide({ msgs: [out(14 * D, 'delivered')], gdoPostino: true })).toBe('none');
  });

  it('mai la classificazione INTERROTTO su un lead del GDO', () => {
    const msgs = [out(130 * H, 'delivered'), inb(125 * H)];
    expect(decide({ msgs, hasInbound: true, lastInboundAtMs: NOW - 125 * H, gdoPostino: true })).toBe('none');
  });

  it('mai DA_SCARTARE per numero morto su un lead del GDO', () => {
    const msgs = [out(15 * D, 'failed'), out(14 * D, 'undelivered')];
    expect(decide({ msgs, gdoPostino: true })).toBe('none');
  });

  it('senza il flag la classificazione resta quella di sempre', () => {
    expect(decide({ msgs: [out(14 * D, 'delivered')] })).toBe('non_risposto');
  });
});

describe('decideFollowupAction — APPUNTAMENTO terminale', () => {
  it('APPUNTAMENTO → none anche a 14g consegnato senza risposta', () => {
    const a = decide({ msgs: [out(14 * D, 'delivered')], botOutcome: 'APPUNTAMENTO' });
    expect(a).toBe('none');
  });

  it('APPUNTAMENTO con inbound e 120h di silenzio → none', () => {
    const a = decide({ msgs: [out(130 * H, 'delivered'), inb(125 * H)], hasInbound: true, lastInboundAtMs: NOW - 125 * H, botOutcome: 'APPUNTAMENTO' });
    expect(a).toBe('none');
  });

  // La guardia copriva solo APPUNTAMENTO. Il 07/08 c'erano 21 conversazioni 'active'
  // con un esito gia registrato (11 INTERROTTO, 8 NON_RISPOSTO, 2 RICHIAMO): ognuna,
  // alla classificazione successiva, rispediva al CRM lo stesso esito che aveva gia
  // dato. Un esito e un esito: non si riclassifica, qualunque sia.
  it('nessun esito gia dato si riclassifica, non solo APPUNTAMENTO', () => {
    for (const o of ['APPUNTAMENTO', 'INTERROTTO', 'NON_RISPOSTO', 'DA_SCARTARE', 'RICHIAMO']) {
      expect(decide({
        msgs: [out(130 * H, 'delivered'), inb(125 * H)],
        hasInbound: true,
        lastInboundAtMs: NOW - 125 * H,
        botOutcome: o,
      })).toBe('none');
      expect(decide({ msgs: [out(14 * D, 'delivered')], botOutcome: o })).toBe('none');
    }
  });

  it('senza esito la classificazione resta quella di sempre', () => {
    expect(decide({ msgs: [out(14 * D, 'delivered')], botOutcome: null })).toBe('non_risposto');
  });
});

describe('decideFollowupAction — Track A (mai risposto)', () => {
  it('25h con 1 out consegnato → none (niente piu NON_RISPOSTO a 24h)', () => {
    const a = decide({ msgs: [out(25 * H, 'delivered')] });
    expect(a).toBe('none');
  });

  it('14g con consegne → non_risposto', () => {
    const a = decide({ msgs: [out(14 * D, 'delivered'), out(13 * D, 'read', 'HXseq1')] });
    expect(a).toBe('non_risposto');
  });

  it('14g mai consegnato nulla → discard_dead', () => {
    const a = decide({ msgs: [out(14 * D, 'failed'), out(13 * D, 'undelivered', 'HXseq1')] });
    expect(a).toBe('discard_dead');
  });

  it('fast-fail: touch inviato, tutto undelivered/failed a 50h → discard_dead', () => {
    const a = decide({ msgs: [out(50 * H, 'failed'), out(26 * H, 'undelivered', 'HXseq1')] });
    expect(a).toBe('discard_dead');
  });

  it('touch dovuto (sequenceEnabled, in fascia) → none: gli invii non sono compito del cron classificatore', () => {
    // 1 out consegnato 30h fa, 0 touch sequenza → decideTrackA direbbe send_touch(1).
    const a = decide({ msgs: [out(30 * H, 'delivered')], sequenceEnabled: true });
    expect(a).toBe('none');
  });

  it('nessun outbound → none (apertura la fa sequence-touches)', () => {
    const a = decide({ msgs: [], sequenceEnabled: true });
    expect(a).toBe('none');
  });
});

describe('decideFollowupAction — Track B (risposto poi silente)', () => {
  it('24h di silenzio → none (niente piu INTERROTTO a 24h)', () => {
    const a = decide({ msgs: [out(30 * H, 'delivered'), inb(24 * H)], hasInbound: true, lastInboundAtMs: NOW - 24 * H });
    expect(a).toBe('none');
  });

  // La resa e scesa da 288h (12gg) a 96h (4gg) il 24/08: oltre le 96h di silenzio,
  // su 55 lead tornati a scrivere, ZERO hanno poi fissato. Tenerli fermi altri otto
  // giorni non recuperava niente e ritardava la restituzione ai GDO.
  it('95h di silenzio → none: il lead e ancora nostro', () => {
    const a = decide({ msgs: [out(105 * H, 'delivered'), inb(95 * H)], hasInbound: true, lastInboundAtMs: NOW - 95 * H });
    expect(a).toBe('none');
  });

  it('96h di silenzio → interrotto_classify', () => {
    const a = decide({ msgs: [out(110 * H, 'delivered'), inb(96 * H)], hasInbound: true, lastInboundAtMs: NOW - 96 * H });
    expect(a).toBe('interrotto_classify');
  });

  it('120h di silenzio → interrotto_classify', () => {
    const a = decide({ msgs: [out(130 * H, 'delivered'), inb(120 * H)], hasInbound: true, lastInboundAtMs: NOW - 120 * H });
    expect(a).toBe('interrotto_classify');
  });

  it('oltre la resa → interrotto_classify anche a kill-switch spento', () => {
    const a = decide({ msgs: [inb(290 * H)], hasInbound: true, lastInboundAtMs: NOW - 290 * H, sequenceEnabled: false });
    expect(a).toBe('interrotto_classify');
  });

  it('nudge dovuto (20h, in fascia, sequenceEnabled) → none: il nudge lo invia sequence-touches', () => {
    const a = decide({ msgs: [inb(20 * H)], hasInbound: true, lastInboundAtMs: NOW - 20 * H, sequenceEnabled: true, nudgesSent: 0 });
    expect(a).toBe('none');
  });

  // Rovesciato il 07/08. Prima un lead gia restituito come NON_RISPOSTO poteva essere
  // riclassificato INTERROTTO se rispondeva e poi taceva. Ma per il CRM ogni
  // classificazione e una restituzione ("ho chiuso, riprendetevelo"): la seconda arriva
  // su un lead che gli abbiamo gia ridato, e nel frattempo un GDO ci sta lavorando.
  // Un lead restituito che riscrive si segnala con la nota "il bot ha ripreso la chat",
  // non con un secondo esito.
  it('un lead gia restituito non si restituisce una seconda volta', () => {
    const a = decide({ msgs: [inb(125 * H)], hasInbound: true, lastInboundAtMs: NOW - 125 * H, botOutcome: 'NON_RISPOSTO' });
    expect(a).toBe('none');
  });
});

// ---------------------------------------------------------------------------
// Pre-filtro: chi ha davvero bisogno della cronologia messaggi.
//
// Il 02/09/2026 alle 04:06 UTC il cron ha smesso di arrivare in fondo: da lì in poi,
// per cinque giorni, ogni giro orario è morto a 300s (504 su Vercel). Il motivo è che
// caricava la cronologia di TUTTE le conversazioni del giro — 2.310, di cui 1.471 lead
// dei GDO che il codice scartava subito dopo averle lette. Con questo filtro le fetch
// scendono a ~180: si legge solo per chi può davvero produrre un'azione.
// ---------------------------------------------------------------------------

const conv = (over: Partial<CronConvRow> = {}): CronConvRow => ({
  ai_status: 'active',
  ai_started_at: at(10 * D),
  created_at: at(10 * D),
  last_message_at: at(1 * H),
  last_inbound_at: null,
  bot_outcome: null,
  gdo_agenda_at: null,
  ...over,
});

describe('ultimoMessaggioEInbound', () => {
  it('vero quando l ultimo messaggio è l inbound del lead', () => {
    expect(ultimoMessaggioEInbound(conv({ last_message_at: at(H), last_inbound_at: at(H) }))).toBe(true);
  });

  it('falso quando dopo l inbound abbiamo già risposto', () => {
    expect(ultimoMessaggioEInbound(conv({ last_message_at: at(H), last_inbound_at: at(2 * H) }))).toBe(false);
  });

  it('falso quando il lead non ha mai scritto', () => {
    expect(ultimoMessaggioEInbound(conv({ last_inbound_at: null }))).toBe(false);
  });
});

describe('serveCronologia — il re-drive viene prima di tutto', () => {
  // Il re-drive è la rete di sicurezza sul drain: vale anche per i lead dei GDO,
  // perché anche lì il bot resta il canale della chat.
  it('inbound senza risposta su un lead GDO → si carica lo stesso', () => {
    const c = conv({ gdo_agenda_at: at(2 * D), last_message_at: at(H), last_inbound_at: at(H) });
    expect(serveCronologia(c, NOW)).toBe(true);
  });

  it('inbound senza risposta su una conv già esitata → si carica lo stesso', () => {
    const c = conv({ bot_outcome: 'INTERROTTO', last_message_at: at(H), last_inbound_at: at(H) });
    expect(serveCronologia(c, NOW)).toBe(true);
  });

  // handed_off/booked: risponde una persona, il bot non deve re-drivare.
  it('inbound senza risposta ma passata all umano → niente cronologia', () => {
    const c = conv({ ai_status: 'handed_off', last_message_at: at(H), last_inbound_at: at(H) });
    expect(serveCronologia(c, NOW)).toBe(false);
  });
});

describe('serveCronologia — chi si salta a costo zero', () => {
  it('lead GDO postino senza inbound in attesa', () => {
    expect(serveCronologia(conv({ gdo_agenda_at: at(2 * D) }), NOW)).toBe(false);
  });

  it('conversazione già esitata: va solo richiusa, la cronologia non serve', () => {
    expect(serveCronologia(conv({ bot_outcome: 'NON_RISPOSTO' }), NOW)).toBe(false);
  });

  it('handed_off: il watchdog guarda solo l ultima attività', () => {
    expect(serveCronologia(conv({ ai_status: 'handed_off' }), NOW)).toBe(false);
  });

  it('booked: idem', () => {
    expect(serveCronologia(conv({ ai_status: 'booked' }), NOW)).toBe(false);
  });
});

describe('serveCronologia — Track A (il lead non ha mai risposto)', () => {
  it('arruolato da meno di 48h: nessun esito può ancora scattare', () => {
    expect(serveCronologia(conv({ ai_started_at: at(47 * H) }), NOW)).toBe(false);
  });

  // 48h è la soglia più bassa che classifica (numero morto di decideTrackA).
  it('arruolato da 48h: si carica', () => {
    expect(serveCronologia(conv({ ai_started_at: at(48 * H) }), NOW)).toBe(true);
  });

  it('senza ai_started_at si ripiega su created_at', () => {
    expect(serveCronologia(conv({ ai_started_at: null, created_at: at(50 * H) }), NOW)).toBe(true);
    expect(serveCronologia(conv({ ai_started_at: null, created_at: at(2 * H) }), NOW)).toBe(false);
  });

  // Nel dubbio si carica: un giro sprecato costa una query, un esito mancato costa un lead.
  it('senza nessuna data si carica', () => {
    expect(serveCronologia(conv({ ai_started_at: null, created_at: null }), NOW)).toBe(true);
  });
});

describe('serveCronologia — Track B (il lead ha risposto, poi silenzio)', () => {
  it('silenzio sotto la resa (95h): non c è niente da restituire', () => {
    const c = conv({ last_inbound_at: at(95 * H), last_message_at: at(94 * H) });
    expect(serveCronologia(c, NOW)).toBe(false);
  });

  it('silenzio oltre la resa (96h): si carica per classificare', () => {
    const c = conv({ last_inbound_at: at(96 * H), last_message_at: at(95 * H) });
    expect(serveCronologia(c, NOW)).toBe(true);
  });

  // Un inbound arrivato PRIMA dell'arruolamento non è nella finestra che legge il cron:
  // per la classificazione quel lead è Track A, e la sua soglia è 48h, non 96h.
  // Senza questa distinzione il suo esito slitterebbe di due giorni.
  it('inbound precedente all arruolamento → vale la soglia Track A', () => {
    const c = conv({ ai_started_at: at(50 * H), last_inbound_at: at(60 * H), last_message_at: at(H) });
    expect(serveCronologia(c, NOW)).toBe(true);
  });
});

describe('ultimaAttivitaMs', () => {
  it('è l ultimo messaggio quando c è', () => {
    expect(ultimaAttivitaMs(conv({ last_message_at: at(3 * H) }), NOW)).toBe(NOW - 3 * H);
  });

  // Conversazione con soli messaggi anteriori all'arruolamento: il cron non li legge,
  // e il suo riferimento di attività resta ai_started_at.
  it('è ai_started_at quando l ultimo messaggio lo precede', () => {
    const c = conv({ ai_started_at: at(2 * H), last_message_at: at(9 * H) });
    expect(ultimaAttivitaMs(c, NOW)).toBe(NOW - 2 * H);
  });

  it('senza date è adesso: nessun watchdog scatta su una riga vuota', () => {
    const c = conv({ ai_started_at: null, created_at: null, last_message_at: null });
    expect(ultimaAttivitaMs(c, NOW)).toBe(NOW);
  });
});
