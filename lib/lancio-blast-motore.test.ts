import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';
import {
  leggiParametriCron, eRifiutoDiPolicy, eseguiLotti, nuovoStatoRun, timbroUpdate, timbroCampi, PASSO_FRENO,
  inviaTemplateTimbrato, frenaLancio, eventoStantio, allarmeEventoStantio, TIPO_EVENTO_NEL_PASSATO,
  GIORNI_CONFIG_STANTIA, TOLLERANZA_GIORNI_EVENTO,
  type EsitoInvio,
} from './lancio-blast-motore';

// Twilio e la scrittura della fase hanno i loro test: qui interessa solo che il motore
// non perda il blocco di invii quando la costruzione del messaggio di UNO esplode.
const sendTemplate = vi.fn(async () => ({ sid: 'SMtest', status: 'queued' }));
const assertTemplateSendable = vi.fn(async () => undefined);
vi.mock('./twilio', () => ({
  sendTemplate: (...a: unknown[]) => sendTemplate(...(a as [])),
  assertTemplateSendable: (...a: unknown[]) => assertTemplateSendable(...(a as [])),
}));
vi.mock('./lancio-db', () => ({ impostaFaseLancio: async () => {} }));
// Il freno spegne `lancio_attivo`: qui serve poter far fallire quella scrittura.
const setLancioSetting = vi.fn(async (): Promise<{ ok: boolean; error?: string }> => ({ ok: true }));
vi.mock('./lancio-settings', () => ({ setLancioSetting: () => setLancioSetting() }));

type Chiamata = { table: string; op: 'insert' | 'update' | 'select'; arg: unknown; filtri: { m: string; args: unknown[] }[] };
const chiamate: Chiamata[] = [];
const eventiScritti = () =>
  chiamate.filter((c) => c.table === 'event_log' && c.op === 'insert').map((c) => c.arg as Record<string, unknown>);

/**
 * Il claim (`update` su `conversations`) deve restituire una riga, o nessun invio parte.
 * La SELECT su `event_log` e' il dedup dell'allarme: la fixture rilegge davvero le righe
 * gia' inserite, cosi' il "una volta al giorno" si prova end-to-end e non su un flag.
 */
const risultato = (rec: Chiamata) => {
  if (rec.table === 'conversations' && rec.op === 'update') return { data: [{ id: 1 }], error: null };
  if (rec.table === 'event_log' && rec.op === 'select') {
    const cerca = rec.filtri.find((f) => f.m === 'contains')?.args[1] as Record<string, unknown> | undefined;
    const trovate = eventiScritti().filter((e) => {
      const payload = (e.payload ?? {}) as Record<string, unknown>;
      return Object.entries(cerca ?? {}).every(([k, v]) => payload[k] === v);
    });
    return { data: trovate.map((_, i) => ({ id: i + 1 })), error: null };
  }
  return { data: [], error: null };
};

function builder(table: string, op: Chiamata['op'], arg: unknown) {
  const rec: Chiamata = { table, op, arg, filtri: [] };
  chiamate.push(rec);
  const q: Record<string, unknown> = {};
  for (const m of ['eq', 'is', 'in', 'not', 'select', 'order', 'range', 'contains', 'limit']) {
    q[m] = (...args: unknown[]) => { rec.filtri.push({ m, args }); return q; };
  }
  q.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) =>
    Promise.resolve().then(() => risultato(rec)).then(ok, ko);
  return q;
}
const supabase = {
  from: (table: string) => ({
    select: (r: unknown) => builder(table, 'select', r),
    insert: (r: unknown) => builder(table, 'insert', r),
    update: (r: unknown) => builder(table, 'update', r),
  }),
} as never;

const req = (qs: string) => ({ nextUrl: new URL(`https://x/api/cron/x?${qs}`), headers: new Headers() }) as unknown as NextRequest;

describe('leggiParametriCron', () => {
  it('forza=1 senza solo è un errore, con solo passa', () => {
    expect(leggiParametriCron(req('forza=1'), { nowRichiedeSolo: false })).toEqual({ ok: false, errore: 'forza=1 richiede solo=<conversationId>' });
    const r = leggiParametriCron(req('forza=1&solo=7'), { nowRichiedeSolo: false });
    expect(r).toMatchObject({ ok: true, forza: true, solo: 7, dry: false });
  });
  it('now= sposta l orologio; con nowRichiedeSolo vale solo insieme a solo=', () => {
    const libero = leggiParametriCron(req('now=2026-10-06T12:10:00%2B02:00'), { nowRichiedeSolo: false });
    expect(libero.ok && libero.now.toISOString()).toBe('2026-10-06T10:10:00.000Z');
    expect(leggiParametriCron(req('now=2026-10-06T12:10:00%2B02:00'), { nowRichiedeSolo: true })).toEqual({ ok: false, errore: 'now=<iso> richiede solo=<conversationId>' });
    const conSolo = leggiParametriCron(req('now=2026-10-06T12:10:00%2B02:00&solo=3'), { nowRichiedeSolo: true });
    expect(conSolo.ok && conSolo.now.toISOString()).toBe('2026-10-06T10:10:00.000Z');
  });
  it('now illeggibile = ora vera; dry=1 letto', () => {
    const r = leggiParametriCron(req('now=ieri&dry=1'), { nowRichiedeSolo: false });
    expect(r.ok && Math.abs(r.now.getTime() - Date.now()) < 5_000).toBe(true);
    expect(r.ok && r.dry).toBe(true);
  });
});

describe('eventoStantio — due regimi, perche i cron non vivono tutti prima dell evento', () => {
  const EVENTO = new Date('2026-10-05T21:00:00+02:00');

  it('aperture e zoom girano prima o il giorno dell evento: tolleranza zero', () => {
    // Mezzanotte del 5: l'evento e' fra 21 ore, ma e' lo stesso giorno.
    expect(eventoStantio(new Date('2026-10-05T00:10:00+02:00'), EVENTO, 'lancio-zoom')).toBe(false);
    // Il blast parte 90' prima, la notte della scelta finisce alle 03:00 del 6: niente
    // deve suonare mentre il lancio sta girando davvero.
    expect(eventoStantio(new Date('2026-10-05T19:30:00+02:00'), EVENTO, 'lancio-zoom')).toBe(false);
    expect(eventoStantio(new Date('2026-10-05T23:59:00+02:00'), EVENTO, 'lancio-zoom')).toBe(false);
    // Il 6 alle 00:10 il giorno e' cambiato: per il blast la finestra e' persa.
    expect(eventoStantio(new Date('2026-10-06T00:10:00+02:00'), EVENTO, 'lancio-zoom')).toBe(true);
    expect(eventoStantio(new Date('2026-10-06T10:00:00+02:00'), EVENTO, 'lancio-aperture')).toBe(true);
  });

  it('follow-up e restituzioni girano DOPO l evento: il 6 e il 7 non suona niente', () => {
    // Questo e' il punto della correzione: il follow-up gira il 6-7 ogni 5 minuti, e con
    // la tolleranza zero avrebbe scritto un error a ogni run a lancio perfetto.
    expect(eventoStantio(new Date('2026-10-06T12:10:00+02:00'), EVENTO, 'lancio-followup')).toBe(false);
    expect(eventoStantio(new Date('2026-10-07T20:00:00+02:00'), EVENTO, 'lancio-followup')).toBe(false);
    expect(eventoStantio(new Date('2026-10-07T09:00:00+02:00'), EVENTO, 'lancio-restituzioni')).toBe(false);
    // Le restituzioni hanno coda fino al 15/11: a un mese dall'evento continuano a non
    // suonare? No — dopo 14 giorni la data e' comunque da guardare.
    expect(eventoStantio(new Date('2026-10-19T10:00:00+02:00'), EVENTO, 'lancio-restituzioni')).toBe(false);
    expect(eventoStantio(new Date('2026-10-20T10:00:00+02:00'), EVENTO, 'lancio-restituzioni')).toBe(true);
  });

  it('il caso vero: la data di un lancio precedente suona su tutti e quattro', () => {
    const vecchia = '2026-09-17T21:00:00+02:00';
    const oggi = new Date('2026-10-05T19:30:00+02:00'); // 18 giorni dopo
    for (const cron of ['lancio-aperture', 'lancio-zoom', 'lancio-followup', 'lancio-restituzioni'] as const) {
      expect(eventoStantio(oggi, vecchia, cron)).toBe(true);
    }
  });

  it('una data futura non suona mai; assente o illeggibile nemmeno (quello e config_error)', () => {
    expect(eventoStantio(new Date('2026-09-19T10:00:00+02:00'), EVENTO, 'lancio-zoom')).toBe(false);
    expect(eventoStantio(new Date('2026-10-06T10:00:00+02:00'), null, 'lancio-aperture')).toBe(false);
    expect(eventoStantio(new Date('2026-10-06T10:00:00+02:00'), 'boh', 'lancio-zoom')).toBe(false);
    expect(eventoStantio(new Date('2026-10-06T10:00:00+02:00'), new Date(NaN), 'lancio-zoom')).toBe(false);
  });

  it('le tolleranze sono quelle dichiarate e non si spostano per sbaglio', () => {
    expect(GIORNI_CONFIG_STANTIA).toBe(14);
    expect(TOLLERANZA_GIORNI_EVENTO).toEqual({
      'lancio-aperture': 0, 'lancio-zoom': 0, 'lancio-followup': 14, 'lancio-restituzioni': 14,
    });
  });
});

describe('allarmeEventoStantio — urla in event_log, non ferma niente, una volta al giorno', () => {
  beforeEach(() => { chiamate.length = 0; });

  it('scrive un evento error con la data configurata, quella di oggi e i giorni di ritardo', async () => {
    const scritto = await allarmeEventoStantio(supabase, 'lancio-zoom', new Date('2026-10-05T19:30:00+02:00'), '2026-09-17T21:00:00+02:00');
    expect(scritto).toBe(true);
    const eventi = eventiScritti();
    expect(eventi).toHaveLength(1);
    expect(eventi[0].type).toBe(TIPO_EVENTO_NEL_PASSATO);
    expect(eventi[0].level).toBe('error');
    expect(eventi[0].payload).toMatchObject({
      cron: 'lancio-zoom', evento_giorno: '2026-09-17', oggi: '2026-10-05',
      giorni_indietro: 18, chiave: 'lancio-zoom:2026-10-05',
    });
    expect(String(eventi[0].message)).toContain('lancio_evento_at');
  });

  it('data giusta (o assente): nessuna riga, e torna false', async () => {
    expect(await allarmeEventoStantio(supabase, 'lancio-zoom', new Date('2026-10-05T19:30:00+02:00'), '2026-10-05T21:00:00+02:00')).toBe(false);
    expect(await allarmeEventoStantio(supabase, 'lancio-aperture', new Date('2026-10-05T19:30:00+02:00'), null)).toBe(false);
    expect(eventiScritti()).toHaveLength(0);
  });

  // `lancio-followup` gira ogni 5 minuti e `lancio-aperture` ogni 15: senza dedup un
  // allarme legittimo diventa sessanta righe al giorno, cioe' di nuovo rumore.
  it('lo stesso cron nello stesso giorno scrive una volta sola', async () => {
    const vecchia = '2026-09-17T21:00:00+02:00';
    expect(await allarmeEventoStantio(supabase, 'lancio-followup', new Date('2026-10-05T10:00:00+02:00'), vecchia)).toBe(true);
    expect(await allarmeEventoStantio(supabase, 'lancio-followup', new Date('2026-10-05T10:05:00+02:00'), vecchia)).toBe(false);
    expect(await allarmeEventoStantio(supabase, 'lancio-followup', new Date('2026-10-05T23:50:00+02:00'), vecchia)).toBe(false);
    expect(eventiScritti()).toHaveLength(1);
  });

  it('il giorno dopo torna a suonare, e ogni cron ha la sua chiave', async () => {
    const vecchia = '2026-09-17T21:00:00+02:00';
    await allarmeEventoStantio(supabase, 'lancio-followup', new Date('2026-10-05T10:00:00+02:00'), vecchia);
    await allarmeEventoStantio(supabase, 'lancio-followup', new Date('2026-10-06T10:00:00+02:00'), vecchia);
    await allarmeEventoStantio(supabase, 'lancio-zoom', new Date('2026-10-05T10:00:00+02:00'), vecchia);
    expect(eventiScritti().map((e) => (e.payload as Record<string, unknown>).chiave)).toEqual([
      'lancio-followup:2026-10-05', 'lancio-followup:2026-10-06', 'lancio-zoom:2026-10-05',
    ]);
  });
});

describe('eRifiutoDiPolicy', () => {
  it('riconosce il presidio UTILITY_ONLY, non un codice Twilio', () => {
    expect(eRifiutoDiPolicy(new Error('template HX1 bloccato: categoria MARKETING con UTILITY_ONLY attivo'))).toBe(true);
    expect(eRifiutoDiPolicy(new Error('categoria del template HX1 non verificabile (HTTP 500)'))).toBe(true);
    expect(eRifiutoDiPolicy(Object.assign(new Error('giu'), { code: 21211 }))).toBe(false);
    expect(eRifiutoDiPolicy(new Error('socket hang up'))).toBe(false);
  });
});

describe('timbroUpdate', () => {
  it('produce l oggetto con la sola colonna chiesta', () => {
    expect(timbroUpdate('lancio_link_inviato_at', 'T')).toEqual({ lancio_link_inviato_at: 'T' });
    expect(timbroUpdate('lancio_followup_inviato_at', null)).toEqual({ lancio_followup_inviato_at: null });
    expect(timbroCampi('lancio_followup_inviato_at', 'T')).toEqual({ lancio_followup_inviato_at: 'T' });
  });
});

describe('eseguiLotti', () => {
  afterEach(() => vi.useRealTimers());
  const lotto = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

  it('conta gli esiti e non chiama il freno se va tutto bene', async () => {
    const stato = nuovoStatoRun();
    const suFreno = vi.fn();
    const conti = await eseguiLotti(lotto(30), stato, {
      concorrenza: 5, t0: Date.now(), suFreno,
      inviaUno: async (id): Promise<EsitoInvio> => { stato.tentati++; return id % 10 === 0 ? 'capped' : 'sent'; },
    });
    expect(conti).toMatchObject({ inviati: 27, capped: 3, falliti: 0, incerti: 0, saltati: 0, errori: 0, riparati: 0 });
    expect(conti.report).toHaveLength(30);
    expect(suFreno).not.toHaveBeenCalled();
    expect(stato.fermo).toBeNull();
  });

  it('si ferma al primo blocco se non arriva niente: il denominatore sono i tentativi', async () => {
    const stato = nuovoStatoRun();
    const suFreno = vi.fn(async () => {});
    const conti = await eseguiLotti(lotto(60), stato, {
      concorrenza: 5, t0: Date.now(), suFreno,
      inviaUno: async (): Promise<EsitoInvio> => { stato.tentati++; stato.codici.push(21211); return 'failed'; },
    });
    expect(conti.falliti).toBe(PASSO_FRENO);
    expect(conti.report).toHaveLength(PASSO_FRENO);
    expect(stato.fermo).toBe('freno');
    expect(suFreno).toHaveBeenCalledTimes(1);
  });

  it('gli incerti pesano come falliti nel freno', async () => {
    const stato = nuovoStatoRun();
    const conti = await eseguiLotti(lotto(60), stato, {
      concorrenza: 5, t0: Date.now(), suFreno: async () => {},
      inviaUno: async (): Promise<EsitoInvio> => { stato.tentati++; return 'incerto'; },
    });
    expect(conti.incerti).toBe(PASSO_FRENO);
    expect(stato.fermo).toBe('freno');
  });

  it('un fermo messo dal worker (template bloccato) interrompe il ciclo senza freno', async () => {
    const stato = nuovoStatoRun();
    const suFreno = vi.fn();
    const conti = await eseguiLotti(lotto(60), stato, {
      concorrenza: 1, t0: Date.now(), suFreno,
      inviaUno: async (): Promise<EsitoInvio> => { if (stato.fermo) return 'skip'; stato.fermo = 'template_bloccato'; return 'bloccato'; },
    });
    expect(conti.report.length).toBe(PASSO_FRENO);
    // `bloccato` finisce fra i saltati come nel cron Zoom di oggi (e' il ramo `else` dei
    // conti): il blocco e' 1 bloccato + 24 skip, e i conti del riepilogo devono tornare
    // (candidati = inviati + riparati + falliti + cap + saltati + residui).
    expect(conti.report[0]).toBe('bloccato');
    expect(conti.saltati).toBe(PASSO_FRENO);
    expect(stato.fermo).toBe('template_bloccato');
    expect(suFreno).not.toHaveBeenCalled();
  });

  it('la sveglia dei 240s ferma il ciclo con fermo=tempo', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-06T10:00:00Z'));
    const stato = nuovoStatoRun();
    const t0 = Date.now();
    const conti = await eseguiLotti(lotto(60), stato, {
      concorrenza: 5, t0, suFreno: async () => {},
      inviaUno: async (): Promise<EsitoInvio> => { vi.setSystemTime(Date.now() + 20_000); stato.tentati++; return 'sent'; },
    });
    expect(stato.fermo).toBe('tempo');
    expect(conti.inviati).toBe(PASSO_FRENO);
  });
});

describe('inviaTemplateTimbrato: la costruzione del messaggio sta DENTRO il try/catch', () => {
  beforeEach(() => {
    chiamate.length = 0;
    sendTemplate.mockClear();
  });

  it('un costruisci che esplode e di un destinatario solo: gli altri 24 partono lo stesso', async () => {
    // Prima la `costruisci` la chiamava il cron, fuori dal motore: un'eccezione li'
    // rifiutava il `Promise.all` di `runPool` e portava via l'intero blocco di 25 —
    // compresi gli invii gia' partiti su WhatsApp, che nessuno avrebbe piu' registrato.
    const stato = nuovoStatoRun();
    const conti = await eseguiLotti(Array.from({ length: PASSO_FRENO }, (_, i) => i + 1), stato, {
      concorrenza: 5,
      t0: Date.now(),
      suFreno: async () => {},
      inviaUno: (n) =>
        inviaTemplateTimbrato(supabase, stato, {
          conv: { id: n, crm_lead_id: `crm-${n}`, phone: `+3933300000${n}`, nome: 'mario rossi' },
          colonna: 'lancio_link_inviato_at',
          faseDopo: 'link_inviato',
          sid: 'HX1',
          from: 'whatsapp:+390000000000',
          costruisci: () => {
            if (n === 7) throw new Error('nome illeggibile');
            return { vars: { '1': 'Mario', '2': 'https://zoom' }, body: 'Ciao Mario' };
          },
          giaSpedito: false,
          soloDaFasi: ['attesa', 'posto_bloccato'],
          prefisso: 'lancio_zoom',
          etichetta: 'link Zoom',
        }),
    });

    expect(conti.inviati).toBe(PASSO_FRENO - 1);
    expect(conti.saltati).toBe(1);
    expect(conti.report).toHaveLength(PASSO_FRENO);
    expect(stato.fermo).toBeNull();
    expect(sendTemplate).toHaveBeenCalledTimes(PASSO_FRENO - 1);
    // Il timbro non e' stato nemmeno preso per chi e' saltato: si riprova al run dopo.
    const claim = chiamate.filter(
      (c) => c.table === 'conversations' && c.op === 'update' && (c.arg as Record<string, unknown>).lancio_link_inviato_at !== undefined,
    );
    expect(claim).toHaveLength(PASSO_FRENO - 1);
    const eventi = chiamate.filter((c) => c.table === 'event_log').map((c) => (c.arg as { type: string }).type);
    expect(eventi).toContain('lancio_zoom_messaggio_non_costruito');
  });
});

describe('frenaLancio — quando nemmeno lo spegnimento riesce', () => {
  beforeEach(() => {
    chiamate.length = 0;
    setLancioSetting.mockReset();
  });

  const conti = {
    inviati: 3, riparati: 0, capped: 1, falliti: 9, incerti: 2, saltati: 0, errori: 0, report: [] as EsitoInvio[],
  };
  const stato = { fermo: 'freno', tentati: 14, codici: [63018, 63018, 'senza_codice'] };

  it('un upsert fallito produce l evento <prefisso>_freno_non_applicato di livello error', async () => {
    setLancioSetting.mockResolvedValueOnce({ ok: false, error: 'permission denied for table app_settings' });

    await frenaLancio(supabase, { ...stato }, conti, {
      prefisso: 'lancio_followup', etichetta: 'follow-up', candidati: 120, lotto: 25,
    });

    const eventi = chiamate
      .filter((c) => c.table === 'event_log')
      .map((c) => c.arg as { type: string; payload: Record<string, unknown>; message: string; level: string });
    // Prima il freno (coi numeri del run), poi l'allarme che NON e' stato applicato.
    expect(eventi.map((e) => e.type)).toEqual(['lancio_followup_freno', 'lancio_followup_freno_non_applicato']);
    expect(eventi[0].level).toBe('error');
    expect(eventi[0].payload).toMatchObject({ tentati: 14, inviati: 3, falliti: 9, incerti: 2, capped: 1, candidati: 120, lotto: 25 });

    const allarme = eventi[1];
    expect(allarme.level).toBe('error');
    expect(allarme.payload).toEqual({ errore: 'permission denied for table app_settings' });
    expect(allarme.message).toContain("lancio_attivo NON e' stato spento");
    expect(allarme.message).toContain('permission denied for table app_settings');
    expect(allarme.message).toContain('Spegnerlo a mano dal pannello');
  });

  it('se lo spegnimento riesce resta solo l evento del freno', async () => {
    setLancioSetting.mockResolvedValueOnce({ ok: true });

    await frenaLancio(supabase, { ...stato }, conti, {
      prefisso: 'lancio_zoom', etichetta: 'link Zoom', candidati: 3000, lotto: 200,
    });

    const eventi = chiamate.filter((c) => c.table === 'event_log').map((c) => (c.arg as { type: string }).type);
    expect(eventi).toEqual(['lancio_zoom_freno']);
  });
});


// La verifica del mittente vive nel MOTORE, quindi vale identica per il blast Zoom e per
// il follow-up del giorno dopo: stessa guardia, stesso ripiego, stesso evento — cambia
// solo `origine`, che dice quale dei due cron l'ha scritto.
describe('inviaTemplateTimbrato: il mittente si verifica prima di Twilio', () => {
  const PRIMARIO = 'whatsapp:+390000000000';
  const SECONDO = 'whatsapp:+393522070047';

  const manda = (from: string, prefisso = 'lancio_followup', etichetta = 'follow-up') => {
    const stato = nuovoStatoRun();
    return inviaTemplateTimbrato(supabase, stato, {
      conv: { id: 42, crm_lead_id: 'crm-42', phone: '+393331234567', nome: 'mario rossi' },
      colonna: 'lancio_followup_inviato_at',
      faseDopo: 'followup_inviato',
      sid: 'HX_FOLLOWUP',
      from,
      costruisci: () => ({ vars: { '1': 'Mario' }, body: 'Ciao Mario' }),
      giaSpedito: false,
      soloDaFasi: ['link_inviato'],
      prefisso,
      etichetta,
    }).then((esito) => ({ esito, stato }));
  };
  const ripiego = () => eventiScritti().find((e) => e.type === 'lancio_mittente_ripiego');
  /** Il mittente con cui e' partito l'invio: il mock e' tipato senza argomenti. */
  const mittenteUsato = () =>
    ((sendTemplate.mock.calls[0] ?? []) as unknown[])[0] as { from?: string } | undefined;

  beforeEach(() => {
    chiamate.length = 0;
    sendTemplate.mockClear();
    assertTemplateSendable.mockReset().mockResolvedValue(undefined);
    vi.stubEnv('TWILIO_WHATSAPP_NUMBER_FENICE', PRIMARIO);
    vi.stubEnv('TWILIO_WHATSAPP_NUMBER_FENICE_2', SECONDO);
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('numero storico: nessuna verifica in piu, si manda e basta', async () => {
    const { esito } = await manda(PRIMARIO);
    expect(esito).toBe('sent');
    expect(assertTemplateSendable).not.toHaveBeenCalled();
    expect(mittenteUsato()).toMatchObject({ from: PRIMARIO });
  });

  it('numero nuovo con template spedibile: si manda di li', async () => {
    const { esito } = await manda(SECONDO);
    expect(esito).toBe('sent');
    expect(mittenteUsato()).toMatchObject({ from: SECONDO });
    expect(ripiego()).toBeUndefined();
  });

  it('numero nuovo con template bloccato: si manda dal numero storico, e il run NON si ferma', async () => {
    assertTemplateSendable.mockRejectedValue(new Error('categoria MARKETING con UTILITY_ONLY attivo'));
    const { esito, stato } = await manda(SECONDO);
    expect(esito).toBe('sent');
    expect(stato.fermo).toBeNull();
    expect(mittenteUsato()).toMatchObject({ from: PRIMARIO });
    // Quale cron, quale conversazione, quale SID.
    expect(ripiego()).toMatchObject({ type: 'lancio_mittente_ripiego', level: 'warn' });
    expect(ripiego()!.payload).toMatchObject({
      origine: 'lancio_followup', conversationId: 42, numero: SECONDO,
      templateSid: 'HX_FOLLOWUP', motivo: 'template_bloccato',
    });
  });

  it("l'evento porta il nome del cron che l'ha scritto", async () => {
    assertTemplateSendable.mockRejectedValue(new Error('bloccato'));
    await manda(SECONDO, 'lancio_zoom', 'link Zoom');
    expect(ripiego()!.payload).toMatchObject({ origine: 'lancio_zoom' });
  });
});
