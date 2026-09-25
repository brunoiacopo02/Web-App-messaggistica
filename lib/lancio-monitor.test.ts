import { describe, it, expect } from 'vitest';
import {
  calcolaAvvisi,
  calcolaConsegne,
  calcolaContatori,
  classificaTemplate,
  filtraChat,
  leggiFiltri,
  erroreTwilio,
  silenzioNotturnoPostPitch,
  PER_PAGINA,
  type ChatLancio,
  type EventoMonitor,
  type InputAvvisi,
  type MessaggioConsegna,
} from './lancio-monitor';
import { LANCIO_SETTINGS_DEFAULT, type LancioSettings } from './lancio-settings';

// La sera del webinar: lunedi' 5/10/2026, 21:00 di Roma = 19:00 UTC.
const EVENTO = '2026-10-05T21:00:00+02:00';
const alle = (hhmm: string, giorno = '2026-10-05') => new Date(`${giorno}T${hhmm}:00+02:00`);

let seq = 1;
function chat(p: Partial<ChatLancio> = {}): ChatLancio {
  return {
    id: seq++, nome: 'Mario Rossi', telefono: '+393331112233', slug: 'webdev-2026-10', fase: 'attesa',
    ingresso: 'lista', benvenutoAt: null, linkAt: null, followupAt: null, inizioAt: null,
    lastInboundAt: null, lastMessageAt: null, congedoAt: null, aiStatus: 'active', ...p,
  };
}
function ev(type: string, payload: Record<string, unknown> | null, created_at = '2026-10-05T19:00:00Z', level = 'info'): EventoMonitor {
  return { id: seq++, type, created_at, level, message: null, payload };
}
const settings = (p: Partial<LancioSettings> = {}): LancioSettings => ({
  ...LANCIO_SETTINGS_DEFAULT, attivo: true, pulsanteAttivo: true, eventoAt: EVENTO,
  zoomLink: 'https://zoom.us/j/12345678901', videoLiveLink: 'https://x/video', ...p,
});
function input(p: Partial<InputAvvisi> = {}): InputAvvisi {
  return { now: alle('18:00'), settings: settings(), chats: [], eventi: [], statiTwilio: [], ultimiRun: {}, colonnaInizio: true, ...p };
}
const ids = (xs: { id: string }[]) => xs.map((a) => a.id);

describe('classificaTemplate', () => {
  const c = chat({ benvenutoAt: '2026-10-01T10:00:00Z', linkAt: '2026-10-05T17:40:00Z' });
  it('riconosce il SID delle env', () => {
    expect(classificaTemplate({ created_at: '2026-10-02T10:00:00Z', template_sid: 'HXzoom', is_template: true }, c, { zoom: ['HXzoom'] })).toBe('zoom');
  });
  it('senza SID noto usa la vicinanza al timbro (template tradotto sul secondo account)', () => {
    expect(classificaTemplate({ created_at: '2026-10-01T10:00:03Z', template_sid: 'HXaltro', is_template: true }, c, {})).toBe('benvenuto');
    expect(classificaTemplate({ created_at: '2026-10-05T17:41:00Z', template_sid: 'HXaltro', is_template: true }, c, {})).toBe('zoom');
  });
  it('oltre 10 minuti dal timbro non e\' di nessuno, e il testo libero mai', () => {
    expect(classificaTemplate({ created_at: '2026-10-01T10:30:00Z', template_sid: 'HX', is_template: true }, c, {})).toBeNull();
    expect(classificaTemplate({ created_at: '2026-10-01T10:00:01Z', template_sid: null, is_template: false }, c, {})).toBeNull();
  });
});

describe('calcolaConsegne', () => {
  it('una chat conta una volta: fallito e poi consegnato = consegnato', () => {
    const c1 = chat({ benvenutoAt: '2026-10-01T10:00:00Z' });
    const c2 = chat({ benvenutoAt: '2026-10-01T10:00:00Z' });
    const m = (conv: number, stato: string): MessaggioConsegna => ({
      conversation_id: conv, created_at: '2026-10-01T10:00:02Z', template_sid: 'HXw', is_template: true, twilio_status: stato, twilio_error_code: null,
    });
    const mappa = new Map([[c1.id, c1], [c2.id, c2]]);
    const r = calcolaConsegne([m(c1.id, 'failed'), m(c1.id, 'delivered'), m(c2.id, 'undelivered')], mappa, { benvenuto: ['HXw'] });
    expect(r.perTipo.benvenuto).toEqual({ consegnati: 1, falliti: 1 });
    expect([...r.problemi].sort()).toEqual([c1.id, c2.id].sort());
  });
});

describe('calcolaContatori', () => {
  it('conta iscritti, benvenuti, risposte dopo il benvenuto, congedi e restituiti', () => {
    const chats = [
      chat({ benvenutoAt: '2026-10-01T10:00:00Z', lastInboundAt: '2026-10-01T11:00:00Z', fase: 'posto_bloccato' }),
      chat({ benvenutoAt: '2026-10-01T10:00:00Z', lastInboundAt: '2026-09-20T11:00:00Z' }), // ha scritto PRIMA: non conta
      chat({ benvenutoAt: '2026-10-01T10:00:00Z', congedoAt: '2026-10-02T10:00:00Z', fase: 'chiuso' }),
      chat({ fase: 'restituito', ingresso: 'pulsante_webinar', linkAt: '2026-10-05T17:40:00Z', inizioAt: '2026-10-05T18:40:00Z' }),
      chat({ slug: null, fase: null }), // fuori dal lancio: non e' un iscritto
    ];
    const k = calcolaContatori(chats, [], null, true);
    expect(k.iscritti).toBe(4);
    expect(k.perIngresso).toEqual({ lista: 3, pulsante_webinar: 1 });
    expect(k.benvenutiInviati).toBe(3);
    expect(k.benvenutiConsegnati).toBeNull();
    expect(k.risposte).toBe(1);
    expect(k.postoBloccato).toBe(1);
    expect(k.linkZoomInviati).toBe(1);
    expect(k.messaggio21Inviati).toBe(1);
    expect(k.congedi).toBe(1);
    expect(k.restituiti).toBe(1);
    expect(k.perFase.attesa).toBe(1);
  });

  it('senza la colonna del messaggio delle 21 il contatore e\' null, non zero', () => {
    expect(calcolaContatori([chat()], [], null, false).messaggio21Inviati).toBeNull();
  });

  it('pulsante, tocchi e scelte si contano per chat distinta dagli eventi', () => {
    const a = chat({ fase: 'scelta_fatta' });
    const eventi = [
      ev('lancio_pulsante', { conversationId: a.id }),
      ev('lancio_pulsante', { conversationId: a.id }), // premuto due volte
      ev('lancio_pulsante', { conversationId: 999, orfano: true, motivo: 'bot_spento' }),
      ev('lancio_scelta_pulsante_tap', { conversationId: a.id, titolo: 'Chiamami subito' }),
      ev('lancio_scelta_pulsante_tap', { conversationId: 5, titolo: 'domani mattina' }),
      ev('lancio_scelta_pulsante_tap', { conversationId: 6, titolo: 'domani mattina va bene' }), // frase, non tocco
      ev('lancio_scelta', { conversationId: a.id, tipo: 'chiama_ora' }),
      ev('lancio_scelta', { conversationId: 5, tipo: 'prenota' }),
      ev('lancio_posto_bloccato', { conversationId: a.id }), // ha bloccato, poi e' andato avanti
    ];
    const k = calcolaContatori([a], eventi, null, true);
    expect(k.pulsantePremuto).toBe(2);
    expect(k.pulsanteOrfani).toBe(1);
    expect(k.tocchi['Chiamami subito']).toBe(1);
    expect(k.tocchi['Domani mattina']).toBe(1);
    expect(k.tocchi['Fissiamo domani']).toBe(0);
    expect(k.scelteFatte).toEqual({ totale: 2, chiamaOra: 1, prenota: 1, giaPrenotato: 0 });
    expect(k.postoBloccato).toBe(1);
  });
});

describe('calcolaAvvisi', () => {
  it('niente da segnalare in un pomeriggio tranquillo', () => {
    expect(calcolaAvvisi(input())).toEqual([]);
  });

  it('il freno e\' critico finche\' il lancio resta spento, e non duplica "lancio spento"', () => {
    const a = calcolaAvvisi(input({
      settings: settings({ attivo: false }),
      eventi: [ev('lancio_zoom_freno', { codici: [63018] }, '2026-10-05T17:50:00Z', 'error')],
    }));
    expect(ids(a)).toEqual(['freno_zoom']);
    expect(a[0].gravita).toBe('critico');
    expect(a[0].significato).toContain('63018');
  });

  it('lancio spento senza freno: critico', () => {
    expect(ids(calcolaAvvisi(input({ settings: settings({ attivo: false }) })))).toEqual(['lancio_spento']);
  });

  it('config error e template bloccato solo se recenti (ultime 2 ore)', () => {
    const a = calcolaAvvisi(input({
      eventi: [
        ev('lancio_zoom_config_error', { missing: ['LANCIO_ZOOM_TEMPLATE_SID'] }, '2026-10-05T15:55:00Z'),
        ev('lancio_aperture_config_error', { conversationId: 7, templateSid: 'HX1', error: 'bloccato: categoria' }, '2026-10-05T15:50:00Z'),
        ev('lancio_followup_config_error', { missing: ['x'] }, '2026-10-05T10:00:00Z'), // vecchio
      ],
    }));
    expect(ids(a).sort()).toEqual(['config_aperture', 'config_zoom']);
    expect(a.find((x) => x.id === 'config_aperture')!.titolo).toContain('Template bloccato');
    expect(a.find((x) => x.id === 'config_zoom')!.significato).toContain('LANCIO_ZOOM_TEMPLATE_SID');
  });

  it('pulsanti partiti come testo, con le chat coinvolte', () => {
    const a = calcolaAvvisi(input({
      eventi: [
        ev('lancio_scelta_pulsanti', { conversationId: 11, inviato: false, motivo: 'sid_mancante' }),
        ev('lancio_scelta_pulsanti', { conversationId: 12, inviato: true }),
      ],
    }));
    expect(ids(a)).toEqual(['pulsanti_testo']);
    expect(a[0].chat).toEqual([11]);
    expect(a[0].significato).toContain('sid_mancante');
  });

  it('errori Twilio dell\'ultima ora raggruppati per codice, gravita\' dal codice', () => {
    const c = chat({ telefono: '+393331112233' });
    const a = calcolaAvvisi(input({
      chats: [c],
      statiTwilio: [
        ev('twilio_status', { ErrorCode: '63016', To: 'whatsapp:+393331112233' }, '2026-10-05T15:30:00Z', 'warn'),
        ev('twilio_status', { ErrorCode: '63016', To: 'whatsapp:+390000000000' }, '2026-10-05T15:40:00Z', 'warn'),
        ev('twilio_status', { ErrorCode: '63024', To: 'whatsapp:+390000000001' }, '2026-10-05T14:00:00Z', 'warn'), // oltre l'ora
      ],
      eventi: [ev('send_error', { conversationId: 44, code: 63018 }, '2026-10-05T15:59:00Z', 'error')],
    }));
    expect(ids(a)).toEqual(['twilio_63018', 'twilio_63016']);
    expect(a[1].conteggio).toBe(2);
    expect(a[1].chat).toEqual([c.id]);
  });

  it('dopo la finestra del blast: iscritti senza link (non i congedati, non chi ha gia\' il link)', () => {
    const senza = chat({ fase: 'attesa' });
    const congedato = chat({ fase: 'attesa', congedoAt: '2026-10-03T10:00:00Z' });
    const servito = chat({ fase: 'link_inviato', linkAt: '2026-10-05T17:35:00Z' });
    const a = calcolaAvvisi(input({ now: alle('20:50'), chats: [senza, congedato, servito], ultimiRun: { zoom: ev('lancio_zoom_run', { residui: 1 }, '2026-10-05T18:45:00Z') } }));
    const r = a.find((x) => x.id === 'zoom_residui')!;
    expect(r.conteggio).toBe(1);
    expect(r.chat).toEqual([senza.id]);
  });

  it('nella finestra del blast, un run vecchio di oltre 10 minuti e\' un cron fermo', () => {
    const vecchio = ev('lancio_zoom_run', { residui: 400 }, '2026-10-05T17:45:00Z');
    expect(ids(calcolaAvvisi(input({ now: alle('20:00'), ultimiRun: { zoom: vecchio } })))).toContain('zoom_cron_fermo');
    const fresco = ev('lancio_zoom_run', { residui: 400 }, '2026-10-05T17:57:00Z');
    expect(ids(calcolaAvvisi(input({ now: alle('20:00'), ultimiRun: { zoom: fresco } })))).not.toContain('zoom_cron_fermo');
  });

  it('pulsante ancora spento dopo le 21:10 del 5/10, e solo quella notte', () => {
    const s = settings({ pulsanteAttivo: false });
    expect(ids(calcolaAvvisi(input({ now: alle('21:05'), settings: s })))).not.toContain('pulsante_spento');
    expect(ids(calcolaAvvisi(input({ now: alle('21:15'), settings: s })))).toContain('pulsante_spento');
    expect(ids(calcolaAvvisi(input({ now: alle('10:00', '2026-10-06'), settings: s })))).not.toContain('pulsante_spento');
  });

  it('video della live vuoto a live finita', () => {
    const s = settings({ videoLiveLink: null });
    expect(ids(calcolaAvvisi(input({ now: alle('22:00'), settings: s })))).not.toContain('video_live');
    expect(ids(calcolaAvvisi(input({ now: alle('23:30'), settings: s })))).toContain('video_live');
  });

  it('post_pitch senza risposta: ultimo messaggio del lead da oltre 5 minuti, fuori dalla pausa notturna', () => {
    const muto = chat({ fase: 'post_pitch', lastInboundAt: '2026-10-05T19:20:00Z', lastMessageAt: '2026-10-05T19:20:00Z' });
    const risposto = chat({ fase: 'post_pitch', lastInboundAt: '2026-10-05T19:20:00Z', lastMessageAt: '2026-10-05T19:20:30Z' });
    const recente = chat({ fase: 'post_pitch', lastInboundAt: '2026-10-05T19:28:00Z', lastMessageAt: '2026-10-05T19:28:00Z' });
    const a = calcolaAvvisi(input({ now: alle('21:30'), chats: [muto, risposto, recente] }));
    const m = a.find((x) => x.id === 'post_pitch_muti')!;
    expect(m.chat).toEqual([muto.id]);
    expect(m.gravita).toBe('attenzione');
    // alle 04:00 il bot tace apposta
    const notte = calcolaAvvisi(input({ now: alle('04:00', '2026-10-06'), chats: [muto] }));
    expect(ids(notte)).not.toContain('post_pitch_muti');
  });

  it('errori CRM: solo quelli sulle chat del lancio', () => {
    const c = chat();
    const a = calcolaAvvisi(input({
      chats: [c],
      eventi: [
        ev('bot_outcome_error', { conversationId: c.id, status: 500 }),
        ev('bot_outcome_error', { conversationId: 424242, status: 500 }), // chat di Mario, non del lancio
        ev('lancio_crm_errore', { conversationId: 77, tag: 'PRENOTA' }),
      ],
      now: alle('21:30'),
    }));
    const crm = a.find((x) => x.id === 'crm')!;
    expect(crm.conteggio).toBe(2);
    expect(crm.chat.sort()).toEqual([77, c.id].sort());
  });

  it('messaggio delle 21: colonna assente nei giorni del lancio, rimanenti dopo le 21:30', () => {
    expect(ids(calcolaAvvisi(input({ colonnaInizio: false })))).toContain('inizio_colonna');
    expect(ids(calcolaAvvisi(input({ colonnaInizio: false, now: alle('10:00', '2026-09-26') })))).not.toContain('inizio_colonna');
    const run = ev('lancio_inizio_run', { rimanenti: 12 }, '2026-10-05T19:30:00Z');
    expect(ids(calcolaAvvisi(input({ now: alle('21:40'), ultimiRun: { inizio: run } })))).toContain('inizio_rimanenti');
  });

  it('turni venditori e CRM che non risponde sulle ore', () => {
    const a = calcolaAvvisi(input({
      now: alle('21:30'),
      eventi: [ev('lancio_slots_vuoti', { conversationId: 3 }, '2026-10-05T19:20:00Z'), ev('lancio_slots_non_letti', { conversationId: 4 }, '2026-10-05T19:21:00Z')],
    }));
    expect(ids(a).sort()).toEqual(['slot_non_letti', 'slot_vuoti']);
  });

  it('ordinati per gravita\', poi per numero', () => {
    const a = calcolaAvvisi(input({
      settings: settings({ attivo: false }),
      eventi: [ev('lancio_scelta_pulsanti', { conversationId: 1, inviato: false })],
      statiTwilio: [ev('twilio_status', { ErrorCode: '63024', To: 'x' }, '2026-10-05T15:59:00Z', 'warn')],
    }));
    expect(a.map((x) => x.gravita)).toEqual(['critico', 'attenzione', 'info']);
  });
});

describe('erroreTwilio', () => {
  it('63018 e 63051 sono critici, 63024 e\' informativo', () => {
    expect(erroreTwilio(63018).gravita).toBe('critico');
    expect(erroreTwilio('63051').gravita).toBe('critico');
    expect(erroreTwilio(63024).gravita).toBe('info');
    expect(erroreTwilio(99999).nome).toContain('99999');
  });
});

describe('silenzioNotturnoPostPitch', () => {
  it('dalle 03:00 alle 08:30 di Roma', () => {
    expect(silenzioNotturnoPostPitch(alle('02:59', '2026-10-06'))).toBe(false);
    expect(silenzioNotturnoPostPitch(alle('03:00', '2026-10-06'))).toBe(true);
    expect(silenzioNotturnoPostPitch(alle('08:29', '2026-10-06'))).toBe(true);
    expect(silenzioNotturnoPostPitch(alle('08:30', '2026-10-06'))).toBe(false);
  });
});

describe('filtraChat e leggiFiltri', () => {
  const a = chat({ nome: 'Giulia Bianchi', telefono: '+393401234567', fase: 'post_pitch', lastMessageAt: '2026-10-05T19:10:00Z' });
  const b = chat({ nome: 'Luca Verdi', telefono: '+393479999999', fase: 'attesa', lastMessageAt: '2026-10-05T19:20:00Z' });
  const c = chat({ nome: 'Anna', fase: 'chiuso', congedoAt: '2026-10-02T10:00:00Z', lastMessageAt: '2026-10-01T10:00:00Z' });
  const d = chat({ nome: 'Orfano', slug: null, fase: null, lastMessageAt: '2026-10-05T19:30:00Z' });
  const tutte = [a, b, c, d];
  const vuoti = { pulsante: new Set<number>(), problemi: new Set<number>() };
  const f = (p: string) => leggiFiltri(new URLSearchParams(p));

  it('ordina per ultimo messaggio', () => {
    expect(filtraChat(tutte, f(''), vuoti).righe.map((x) => x.id)).toEqual([d.id, b.id, a.id, c.id]);
  });
  it('filtra per fase, congedo e fuori lancio', () => {
    expect(filtraChat(tutte, f('fase=post_pitch'), vuoti).righe).toEqual([a]);
    expect(filtraChat(tutte, f('fase=congedo'), vuoti).righe).toEqual([c]);
    expect(filtraChat(tutte, f('fase=fuori_lancio'), vuoti).righe).toEqual([d]);
    expect(filtraChat(tutte, f('fase=tutte'), vuoti).totale).toBe(4);
  });
  it('pulsante e problemi', () => {
    expect(filtraChat(tutte, f('pulsante=1'), { pulsante: new Set([b.id]), problemi: new Set() }).righe).toEqual([b]);
    expect(filtraChat(tutte, f('problemi=1'), { pulsante: new Set(), problemi: new Set([c.id]) }).righe).toEqual([c]);
  });
  it('cerca per nome e per telefono (anche con spazi)', () => {
    expect(filtraChat(tutte, f('q=giulia'), vuoti).righe).toEqual([a]);
    expect(filtraChat(tutte, f('q=347 999'), vuoti).righe).toEqual([b]);
  });
  it('gli id di un avviso vincono sugli altri filtri', () => {
    expect(filtraChat(tutte, f(`fase=attesa&ids=${a.id},${c.id}`), vuoti).totale).toBe(2);
  });
  it('pagina a 50', () => {
    const tante = Array.from({ length: 120 }, () => chat());
    expect(filtraChat(tante, f('pagina=3'), vuoti).righe).toHaveLength(120 - 2 * PER_PAGINA);
    expect(f('pagina=abc').pagina).toBe(1);
  });
});
