import { describe, it, expect } from 'vitest';
import {
  buildSollecitoHistory,
  decideGdoVideoFollowup,
  inviaBolleSollecito,
  TURNO_RIPRESA_SOLLECITO,
  VIDEO_TEMPLATE_ENV_BY_LINK,
  type BolleDeps,
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
  haRispostoDopoVideo: false,
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
      haRispostoDopoVideo: false,
    }))).toBe('sollecito-libero');
  });

  it('con finestra chiusa si ricade sul template', () => {
    expect(decideGdoVideoFollowup(base({
      gdoVideoSentAt: '2026-07-31T15:00:00Z',
      lastInboundAtMs: ORA - 30 * H,
      haRispostoDopoVideo: false,
    }))).toBe('sollecito-template');
  });
});

describe('decideGdoVideoFollowup — chi ha risposto non è più un lead freddo', () => {
  const basePost = {
    gdoAgendaAt: '2026-08-06T09:00:00+02:00',
    gdoVideoSentAt: '2026-08-06T09:30:00+02:00',
    gdoVideoWatchedAt: null,
    followupsSent: 0,
    appointmentAt: null,
    lastInboundAtMs: Date.parse('2026-08-06T09:20:00+02:00'), // vecchio: fuori dalle 6h
    lastMessageIsInbound: false,
    nowMs: Date.parse('2026-08-06T21:35:00+02:00'),
    slot: 'sera' as const,
    giorniDaAgenda: 0,
    romeHourAgenda: 9,
    haRispostoDopoVideo: false,
  };

  it('senza risposta dopo il video il sollecito parte come oggi', () => {
    expect(decideGdoVideoFollowup(basePost)).not.toBe('none');
  });

  it('se ha risposto dopo il video, nessun sollecito automatico', () => {
    expect(decideGdoVideoFollowup({ ...basePost, haRispostoDopoVideo: true })).toBe('none');
  });

  it('vale anche per il secondo slot, quello del mattino', () => {
    expect(decideGdoVideoFollowup({
      ...basePost,
      haRispostoDopoVideo: true,
      followupsSent: 1,
      slot: 'mattina',
      giorniDaAgenda: 1,
      nowMs: Date.parse('2026-08-07T10:05:00+02:00'),
    })).toBe('none');
  });

  it('chi non ha MAI ricevuto il video lo riceve comunque', () => {
    expect(decideGdoVideoFollowup({
      ...basePost,
      gdoVideoSentAt: null,
      haRispostoDopoVideo: false,
    })).toBe('video-template');
  });

  it('il tetto storico dei due touch resta', () => {
    expect(decideGdoVideoFollowup({ ...basePost, followupsSent: 2 })).toBe('none');
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

/**
 * Banco di prova che rifà la contabilità del cron attorno a `inviaBolleSollecito`:
 * touch idempotente segnato dalla prima bolla, una riga `messages` per bolla, errore
 * registrato. Serve a verificare il vincolo vero — mai un terzo messaggio al lead —
 * non solo il valore di ritorno.
 */
function banco(opts: { esplodeAllaBolla?: number; dopoInvioEsplode?: number } = {}) {
  const inviate: string[] = [];
  const messaggi: string[] = [];
  const errori: { indice: number; previste: number; errore: string }[] = [];
  const pause: number[] = [];
  const conto = { touch: 0 };
  let touchSegnato = false;

  const deps: BolleDeps = {
    invia: async (body) => {
      if (opts.esplodeAllaBolla === inviate.length) throw new Error('twilio 63016');
      inviate.push(body);
      return { sid: `SM${inviate.length}`, status: 'queued' };
    },
    dopoInvio: async (b) => {
      // Come nel cron: il contatore dei due touch si muove una volta sola.
      if (!touchSegnato) { touchSegnato = true; conto.touch++; }
      if (opts.dopoInvioEsplode === b.indice) throw new Error('insert fallita');
      messaggi.push(b.body);
    },
    suErrore: async (info) => { errori.push(info); },
    sleep: async (ms) => { pause.push(ms); },
  };

  return { deps, inviate, messaggi, errori, pause, conto };
}

const NOEMI = /\bNoemi\b/i;

describe('inviaBolleSollecito', () => {
  const TRE = ['Ciao!', 'Ti ricordo il video', 'Prima della call ti chiama Noemi'];

  it('tutte le bolle partono: un solo touch, una riga messaggio per bolla', async () => {
    const b = banco();

    const spedite = await inviaBolleSollecito(TRE, b.deps);

    expect(spedite).toEqual(TRE);
    expect(b.messaggi).toEqual(TRE);
    // Le bolle sono UN sollecito, non uno a testa: il tetto dei due touch tiene.
    expect(b.conto.touch).toBe(1);
    expect(b.errori).toEqual([]);
  });

  it('la seconda bolla esplode: il touch è già segnato, il lead non ne riceve un terzo allo slot dopo', async () => {
    const b = banco({ esplodeAllaBolla: 1 });

    const spedite = await inviaBolleSollecito(TRE, b.deps);

    expect(spedite).toEqual([TRE[0]]);
    expect(b.messaggi).toEqual([TRE[0]]);
    // Il punto del fix: il contatore si muove comunque, l'invio troncato costa un
    // touch. Se restasse a zero, i due slot manderebbero fino a tre messaggi.
    expect(b.conto.touch).toBe(1);
    expect(b.errori).toEqual([{ indice: 1, previste: 3, errore: 'twilio 63016' }]);
  });

  it('la bolla con Noemi non è uscita: il testo davvero inviato non la nomina', async () => {
    const b = banco({ esplodeAllaBolla: 2 });

    const spedite = await inviaBolleSollecito(TRE, b.deps);

    // Il criterio del cron applicato alle bolle spedite, non a quelle previste.
    expect(spedite.some((p) => NOEMI.test(p))).toBe(false);
    expect(TRE.some((p) => NOEMI.test(p))).toBe(true);
  });

  it('la prima bolla esplode: niente touch, niente messaggi, errore registrato', async () => {
    const b = banco({ esplodeAllaBolla: 0 });

    const spedite = await inviaBolleSollecito(TRE, b.deps);

    expect(spedite).toEqual([]);
    expect(b.conto.touch).toBe(0);
    expect(b.messaggi).toEqual([]);
    expect(b.errori[0]).toMatchObject({ indice: 0, previste: 3 });
  });

  it('la registrazione a valle fallisce: la bolla conta come uscita, il lead l\'ha ricevuta', async () => {
    const b = banco({ dopoInvioEsplode: 0 });

    const spedite = await inviaBolleSollecito(TRE, b.deps);

    expect(spedite).toEqual([TRE[0]]);
    expect(b.inviate).toEqual([TRE[0]]);
    expect(b.errori[0].errore).toBe('insert fallita');
  });

  it('la prima bolla non aspetta, le altre sì', async () => {
    const b = banco();

    await inviaBolleSollecito(TRE, b.deps);

    expect(b.pause).toHaveLength(2);
    expect(b.pause.every((ms) => ms >= 800 && ms <= 3000)).toBe(true);
  });

  it('nessuna bolla: nessun invio, nessun errore', async () => {
    const b = banco();
    expect(await inviaBolleSollecito([], b.deps)).toEqual([]);
    expect(b.conto.touch).toBe(0);
    expect(b.errori).toEqual([]);
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
