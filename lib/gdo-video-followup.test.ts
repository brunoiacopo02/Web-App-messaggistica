import { describe, it, expect } from 'vitest';
import {
  buildSollecitoHistory,
  decideGdoVideoFollowup,
  TURNO_RIPRESA_SOLLECITO,
  VIDEO_TEMPLATE_ENV_BY_LINK,
  type GdoFollowupInput,
} from './gdo-video-followup';
import { romeDaysBetween, romeDayKey } from './rome-time';

const H = 3600_000;
const ORA = Date.parse('2026-08-01T19:30:00Z'); // 21:30 italiane

/** Caso base: agenda oggi, lead che non ha mai risposto, slot serale. */
const base = (over: Partial<GdoFollowupInput> = {}): GdoFollowupInput => ({
  gdoAgendaAt: '2026-08-01T14:00:00Z',
  gdoVideoSentAt: null,
  gdoVideoWatchedAt: null,
  followupsSent: 0,
  appointmentAt: null,
  lastInboundAtMs: null,
  lastMessageIsInbound: false,
  nowMs: ORA,
  slot: 'sera',
  giorniDaAgenda: 0,
  romeHourAgenda: 16,
  ...over,
});

describe('decideGdoVideoFollowup — chi non ha mai risposto', () => {
  it('la sera dell\'agenda riceve il video via template', () => {
    expect(decideGdoVideoFollowup(base())).toBe('video-template');
  });

  it('il mattino dopo riceve il sollecito, fuori finestra quindi template', () => {
    expect(decideGdoVideoFollowup(base({
      slot: 'mattina', giorniDaAgenda: 1, followupsSent: 1,
      gdoVideoSentAt: '2026-08-01T19:30:00Z',
    }))).toBe('sollecito-template');
  });
});

describe('decideGdoVideoFollowup — chi ha risposto', () => {
  it('con finestra aperta il sollecito lo scrive il modello', () => {
    expect(decideGdoVideoFollowup(base({
      gdoVideoSentAt: '2026-08-01T15:00:00Z',
      lastInboundAtMs: ORA - 8 * H,
    }))).toBe('sollecito-libero');
  });

  it('con finestra chiusa si ricade sul template', () => {
    expect(decideGdoVideoFollowup(base({
      gdoVideoSentAt: '2026-07-31T15:00:00Z',
      lastInboundAtMs: ORA - 30 * H,
    }))).toBe('sollecito-template');
  });
});

describe('decideGdoVideoFollowup — quando tacere', () => {
  it('non è un lead postino', () => {
    expect(decideGdoVideoFollowup(base({ gdoAgendaAt: null }))).toBe('none');
  });

  it('ha già confermato di aver visto il video', () => {
    expect(decideGdoVideoFollowup(base({ gdoVideoWatchedAt: '2026-08-01T18:00:00Z' }))).toBe('none');
  });

  it('ha già ricevuto i due touch previsti', () => {
    expect(decideGdoVideoFollowup(base({ followupsSent: 2 }))).toBe('none');
  });

  it('lo slot serale non appartiene al giorno dell\'agenda', () => {
    expect(decideGdoVideoFollowup(base({ giorniDaAgenda: 1 }))).toBe('none');
  });

  it('lo slot del mattino vale solo il giorno dopo l\'agenda', () => {
    expect(decideGdoVideoFollowup(base({ slot: 'mattina', giorniDaAgenda: 0 }))).toBe('none');
    expect(decideGdoVideoFollowup(base({ slot: 'mattina', giorniDaAgenda: 2 }))).toBe('none');
  });

  it('la call è già passata', () => {
    expect(decideGdoVideoFollowup(base({ appointmentAt: '2026-08-01T16:00:00Z' }))).toBe('none');
  });

  it('agenda arrivata dopo le 18 e call ignota: niente sollecito serale', () => {
    // Ripiego finché il CRM non manda appointmentAt: una call fissata a ridosso
    // potrebbe essere già avvenuta.
    expect(decideGdoVideoFollowup(base({ romeHourAgenda: 19 }))).toBe('none');
    // Con la data vera e futura, invece, si procede.
    expect(decideGdoVideoFollowup(base({
      romeHourAgenda: 19, appointmentAt: '2026-08-03T09:00:00Z',
    }))).toBe('video-template');
  });

  it('si sta parlando col lead: il promemoria lo porta la chat', () => {
    expect(decideGdoVideoFollowup(base({
      gdoVideoSentAt: '2026-08-01T15:00:00Z', lastInboundAtMs: ORA - 2 * H,
    }))).toBe('none');
  });

  it('c\'è una sua domanda senza risposta: ci pensa il re-drive', () => {
    expect(decideGdoVideoFollowup(base({
      gdoVideoSentAt: '2026-08-01T15:00:00Z',
      lastInboundAtMs: ORA - 8 * H,
      lastMessageIsInbound: true,
    }))).toBe('none');
  });

  it('una data d\'appuntamento illeggibile vale come sconosciuta: vale il ripiego', () => {
    expect(decideGdoVideoFollowup(base({ appointmentAt: 'non-una-data', romeHourAgenda: 19 }))).toBe('none');
  });

  it('una data illeggibile non blocca lo slot se l\'agenda è arrivata presto', () => {
    expect(decideGdoVideoFollowup(base({ appointmentAt: 'non-una-data', romeHourAgenda: 10 }))).toBe('video-template');
  });
});

describe('buildSollecitoHistory', () => {
  const chat = [
    { direction: 'out', body: 'ciao, ecco il link per l\'agenda' },
    { direction: 'in', body: 'ok grazie' },
    { direction: 'out', body: 'ecco il video da guardare' },
  ];

  it('chiude sempre con un turno user: un ultimo turno assistant sarebbe un 400', () => {
    // Il sollecito parte solo quando l'ultimo messaggio della chat è nostro, quindi
    // senza il turno sintetico la richiesta finirebbe SEMPRE con `assistant`, che
    // claude-sonnet-4-6 rifiuta: il ramo sarebbe inoperante al 100% dei casi.
    const history = buildSollecitoHistory(chat);
    expect(history[history.length - 1].role).toBe('user');
  });

  it('conserva la cronologia e le aggiunge in coda il turno di ripresa', () => {
    expect(buildSollecitoHistory(chat)).toEqual([
      { role: 'assistant', content: 'ciao, ecco il link per l\'agenda' },
      { role: 'user', content: 'ok grazie' },
      { role: 'assistant', content: 'ecco il video da guardare' },
      { role: 'user', content: TURNO_RIPRESA_SOLLECITO },
    ]);
  });

  it('il turno di ripresa non si spaccia per un messaggio del lead', () => {
    expect(TURNO_RIPRESA_SOLLECITO).toMatch(/non è un messaggio del lead/i);
  });

  it('cronologia vuota: resta vuota, l\'apertura la mette generateMarioReply', () => {
    expect(buildSollecitoHistory([])).toEqual([]);
  });
});

describe('mappa dei template video', () => {
  it('copre tutte e cinque le varianti', () => {
    expect(Object.keys(VIDEO_TEMPLATE_ENV_BY_LINK)).toHaveLength(5);
    expect(Object.values(VIDEO_TEMPLATE_ENV_BY_LINK)).toContain('VIDEO_GDO_OFFERTA_SID');
  });
});

describe('romeDaysBetween', () => {
  it('conta i giorni di calendario, non le 24 ore', () => {
    // 23:30 e 00:30 italiane distano un'ora ma sono due giorni diversi.
    const sera = new Date('2026-08-01T21:30:00Z');
    const notte = new Date('2026-08-01T22:30:00Z');
    expect(romeDaysBetween(sera, notte)).toBe(1);
    expect(romeDayKey(sera)).toBe('2026-08-01');
  });
});
