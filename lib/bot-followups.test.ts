import { describe, it, expect } from 'vitest';
import { decideFollowupAction } from './bot-followups';
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

  it('120h di silenzio → interrotto_classify', () => {
    const a = decide({ msgs: [out(130 * H, 'delivered'), inb(120 * H)], hasInbound: true, lastInboundAtMs: NOW - 120 * H });
    expect(a).toBe('interrotto_classify');
  });

  it('120h → interrotto_classify anche a kill-switch spento', () => {
    const a = decide({ msgs: [inb(121 * H)], hasInbound: true, lastInboundAtMs: NOW - 121 * H, sequenceEnabled: false });
    expect(a).toBe('interrotto_classify');
  });

  it('nudge dovuto (20h, in fascia, sequenceEnabled) → none: il nudge lo invia sequence-touches', () => {
    const a = decide({ msgs: [inb(20 * H)], hasInbound: true, lastInboundAtMs: NOW - 20 * H, sequenceEnabled: true, nudgesSent: 0 });
    expect(a).toBe('none');
  });

  it('esito non terminale (NON_RISPOSTO) non blocca la classificazione', () => {
    const a = decide({ msgs: [inb(125 * H)], hasInbound: true, lastInboundAtMs: NOW - 125 * H, botOutcome: 'NON_RISPOSTO' });
    expect(a).toBe('interrotto_classify');
  });
});
