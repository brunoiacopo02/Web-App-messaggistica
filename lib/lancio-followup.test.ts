import { describe, it, expect } from 'vitest';
import {
  FASI_FOLLOWUP, inFinestraFollowup, finestraFollowupChiusa, ancoraLancio, inboundDopo, haInteragito,
  ultimoTestoInbound, haDettoNo, decideFollowup, lancioFollowupText, lancioStandardContextNote,
  lancioStandardDrain, NOTA_CONGEDO_FOLLOWUP, type CandidataFollowup, linkSviluppatoreContextNote, eventoLancioPassato,
  bloccaPassaggioLancio, NOTA_LANCIO_NIENTE_PASSAGGIO, TESTO_LANCIO_NIENTE_PASSAGGIO, lancioRegistrazioneText,
} from './lancio-followup';
import { fineNotteLancio } from './lancio-scelta';
import { registrazionePromessa, type RigaLancio } from './lancio-fase';

const EVENTO = new Date('2026-10-05T21:00:00+02:00');
const t = (iso: string) => new Date(iso);
const WELCOME = 'HX_WELCOME';
const out = (body: string, created_at: string, template_sid: string | null = null): RigaLancio => ({ direction: 'out', body, template_sid, created_at });
const inb = (body: string, created_at: string): RigaLancio => ({ direction: 'in', body, template_sid: null, created_at });

describe('inFinestraFollowup — 09:00-18:30 di Roma, dal giorno dopo per 4 giorni (PO 06/10)', () => {
  it('dentro: 09:00, 13:59, 18:29 dal 6 al 9', () => {
    for (const iso of ['2026-10-06T09:00:00+02:00', '2026-10-06T13:59:00+02:00', '2026-10-06T18:29:00+02:00', '2026-10-07T12:05:00+02:00', '2026-10-08T18:00:00+02:00', '2026-10-09T09:30:00+02:00']) {
      expect(inFinestraFollowup(t(iso), EVENTO), iso).toBe(true);
    }
  });
  it('fuori: 08:59, 18:30, 21:00', () => {
    for (const iso of ['2026-10-06T08:59:00+02:00', '2026-10-06T18:30:00+02:00', '2026-10-06T21:00:00+02:00']) {
      expect(inFinestraFollowup(t(iso), EVENTO), iso).toBe(false);
    }
  });
  it('vale dal 6 al 9, non il 5 ne il 10, e segue l evento se si sposta', () => {
    expect(inFinestraFollowup(t('2026-10-05T12:30:00+02:00'), EVENTO)).toBe(false);
    expect(inFinestraFollowup(t('2026-10-10T12:30:00+02:00'), EVENTO)).toBe(false);
    expect(inFinestraFollowup(t('2026-10-13T12:30:00+02:00'), new Date('2026-10-12T21:00:00+02:00'))).toBe(true);
  });
  it('la finestra e chiusa solo dopo le 18:30 dell ultimo giorno (il 9)', () => {
    expect(finestraFollowupChiusa(t('2026-10-07T20:00:00+02:00'), EVENTO)).toBe(false);
    expect(finestraFollowupChiusa(t('2026-10-09T18:29:00+02:00'), EVENTO)).toBe(false);
    expect(finestraFollowupChiusa(t('2026-10-09T18:30:00+02:00'), EVENTO)).toBe(true);
    expect(finestraFollowupChiusa(t('2026-10-10T09:00:00+02:00'), EVENTO)).toBe(true);
  });
});

describe('ancoraLancio — da quando un inbound conta', () => {
  const rows = [out('vecchio giro di Mario', '2026-08-01T10:00:00Z'), out('benvenuto', '2026-09-20T10:00:00Z', WELCOME)];
  it('la colonna lancio_benvenuto_at vince su tutto', () => {
    expect(ancoraLancio({ rows, welcomeSid: WELCOME, benvenutoAt: '2026-09-20T10:00:05Z', ingressoAt: '2026-09-19T00:00:00Z' })).toBe('2026-09-20T10:00:05Z');
  });
  it('poi la riga del benvenuto in cronologia (l ultima), poi l istante dell intake', () => {
    expect(ancoraLancio({ rows, welcomeSid: WELCOME, benvenutoAt: null, ingressoAt: null })).toBe('2026-09-20T10:00:00Z');
    expect(ancoraLancio({ rows: [rows[0]], welcomeSid: WELCOME, benvenutoAt: null, ingressoAt: '2026-09-19T00:00:00Z' })).toBe('2026-09-19T00:00:00Z');
  });
  it('senza nessuno dei quattro e null: ancora ignota', () => {
    expect(ancoraLancio({ rows: [rows[0]], welcomeSid: null, benvenutoAt: null, ingressoAt: null })).toBeNull();
  });
});

// Chi entra col pulsante la sera della live il benvenuto non ce l'ha: l'unica cosa che
// dice "da qui e' lancio" e' la pressione stessa. L'evento `lancio_intake` e' scritto DOPO
// quella riga (il webhook salva il messaggio e poi arruola), quindi prendendo l'intake
// come ancora la pressione restava fuori e la chat risultava "non ha mai scritto".
describe('ancoraLancio — le chat entrate col pulsante del webinar', () => {
  const PULSANTE = 'Ho visto la live Web Developer AI e voglio saperne di piu';
  const pressione = (created_at: string) => inb(PULSANTE, created_at);

  it('senza benvenuto l ancora e l ULTIMA pressione del pulsante, e vince sull intake', () => {
    const rows = [out('vecchio giro di Mario', '2026-08-01T10:00:00Z'), pressione('2026-10-05T21:40:00+02:00')];
    expect(ancoraLancio({ rows, welcomeSid: WELCOME, benvenutoAt: null, ingressoAt: '2026-10-05T21:40:05+02:00' }))
      .toBe('2026-10-05T21:40:00+02:00');
    const due = [...rows, inb('ci sono', '2026-10-05T21:45:00+02:00'), pressione('2026-10-07T09:00:00+02:00')];
    expect(ancoraLancio({ rows: due, welcomeSid: WELCOME, benvenutoAt: null, ingressoAt: null }))
      .toBe('2026-10-07T09:00:00+02:00');
  });

  it('chi e entrato dalla lista non cambia: il benvenuto viene prima del pulsante', () => {
    const rows = [out('benvenuto', '2026-09-20T10:00:00Z', WELCOME), pressione('2026-10-05T21:40:00+02:00')];
    expect(ancoraLancio({ rows, welcomeSid: WELCOME, benvenutoAt: '2026-09-20T10:00:05Z', ingressoAt: null })).toBe('2026-09-20T10:00:05Z');
    expect(ancoraLancio({ rows, welcomeSid: WELCOME, benvenutoAt: null, ingressoAt: null })).toBe('2026-09-20T10:00:00Z');
  });

  it('la pressione conta come interazione: l ancora e inclusa', () => {
    const rows = [pressione('2026-10-05T21:40:00+02:00')];
    const ancoraPulsante = ancoraLancio({ rows, welcomeSid: WELCOME, benvenutoAt: null, ingressoAt: null }) as string;
    expect(haInteragito(rows, ancoraPulsante)).toBe(true);
  });
});

describe('haInteragito / ultimoTestoInbound', () => {
  const ancora = '2026-09-20T10:00:00Z';
  it('un inbound prima dell ancora non conta, uno dopo si', () => {
    expect(haInteragito([inb('ciao', '2026-09-01T10:00:00Z')], ancora)).toBe(false);
    expect(haInteragito([inb('ciao', '2026-09-01T10:00:00Z'), inb('ok', '2026-09-20T10:30:00Z')], ancora)).toBe(true);
    expect(inboundDopo([inb('ciao', '2026-09-01T10:00:00Z'), inb('ok', '2026-09-20T10:30:00Z')], ancora)).toHaveLength(1);
  });
  it('ancora ignota: mai interagito (si sbaglia verso il silenzio)', () => {
    expect(haInteragito([inb('ok', '2026-09-20T10:30:00Z')], null)).toBe(false);
  });
  it('l ultimo testo e l ultimo inbound leggibile dopo l ancora: i media si saltano', () => {
    const rows = [inb('si', '2026-09-20T10:30:00Z'), out('perfetto', '2026-09-20T10:31:00Z'), inb('no grazie', '2026-10-06T00:30:00Z'), inb('', '2026-10-06T00:31:00Z')];
    expect(ultimoTestoInbound(rows, ancora)).toBe('no grazie');
    expect(ultimoTestoInbound([inb('', '2026-09-20T10:30:00Z')], ancora)).toBe('');
  });
});

describe('haDettoNo — solo il rifiuto esplicito (congedoEsplicito), mai il no secco', () => {
  it('le frasi di rifiuto sono un no', () => {
    for (const s of ['No grazie', 'non mi interessa', 'toglimi dalla lista', 'non scrivetemi più', 'basta messaggi', 'numero sbagliato']) expect(haDettoNo(s), s).toBe(true);
  });
  it('un no secco, "certo che no" e tutto il resto NON sono un congedo: in assistenza il no risponde a una domanda del bot', () => {
    for (const s of ['no', 'certo che no', 'si', 'ok', 'quanto costa?', 'no ma sono interessato', 'nessun problema, ci sono', '']) expect(haDettoNo(s), s).toBe(false);
  });
});

describe('decideFollowup', () => {
  const ancora = '2026-09-20T10:00:00Z';
  const c = (over: Partial<CandidataFollowup> = {}): CandidataFollowup => ({
    lancio_fase: 'attesa',
    lancio_followup_inviato_at: null,
    lancio_info: null,
    rows: [out('benvenuto', ancora, WELCOME), inb('si', '2026-09-20T10:30:00Z')],
    ancora,
    fineNotte: fineNotteLancio(EVENTO),
    ...over,
  });
  it('le quattro fasi del perimetro con un inbound dopo l ancora (e la chat ferma): si manda', () => {
    for (const f of FASI_FOLLOWUP) expect(decideFollowup(c({ lancio_fase: f })), f).toEqual({ kind: 'invia', tipo: 'followup' });
    expect([...FASI_FOLLOWUP]).toEqual(['attesa', 'posto_bloccato', 'link_inviato', 'post_pitch']);
  });
  it('fasi fuori perimetro: scelta_fatta, followup_inviato, chiuso, restituito, null', () => {
    for (const f of ['scelta_fatta', 'followup_inviato', 'chiuso', 'restituito', null]) {
      expect(decideFollowup(c({ lancio_fase: f }))).toEqual({ kind: 'salta', motivo: 'fase' });
    }
  });
  // Il buco che questo blocco chiude: chi ha premuto il pulsante la sera del 5, ha magari
  // risposto a una domanda di riscaldamento e poi e' sparito restava in `post_pitch` per
  // sempre — fuori dal follow-up, fuori dalle restituzioni, e fuori dal re-drive di Mario.
  it('post_pitch fermo dalla sera del pitch (ultimo inbound prima delle 03:00 del 6): si manda', () => {
    const rows = [out('benvenuto', ancora, WELCOME), inb('premuto il pulsante', '2026-10-05T21:40:00+02:00'), inb('si, lavoro', '2026-10-05T22:10:00+02:00')];
    expect(decideFollowup(c({ lancio_fase: 'post_pitch', rows }))).toEqual({ kind: 'invia', tipo: 'followup' });
  });
  it('post_pitch ancora vivo il 6 (un inbound dalle 03:00 in poi): salta, e in scelta non si interrompe', () => {
    const attivo = (quando: string) => c({
      lancio_fase: 'post_pitch',
      rows: [out('benvenuto', ancora, WELCOME), inb('premuto il pulsante', '2026-10-05T21:40:00+02:00'), inb('eccomi', quando)],
    });
    expect(decideFollowup(attivo('2026-10-06T03:00:00+02:00'))).toEqual({ kind: 'salta', motivo: 'in_scelta' });
    expect(decideFollowup(attivo('2026-10-06T11:30:00+02:00'))).toEqual({ kind: 'salta', motivo: 'in_scelta' });
    // Il confine e' stretto: alle 02:59 la notte non e' finita e la chat e' ferma.
    expect(decideFollowup(attivo('2026-10-06T02:59:00+02:00'))).toEqual({ kind: 'invia', tipo: 'followup' });
  });
  it('entrata col pulsante e muta da allora: il follow-up ci va (non e "mai scritto")', () => {
    const rows = [inb('Ho visto la live Web Developer AI e voglio saperne di piu', '2026-10-05T21:40:00+02:00')];
    const ancoraPulsante = '2026-10-05T21:40:00+02:00';
    expect(decideFollowup(c({ lancio_fase: 'post_pitch', rows, ancora: ancoraPulsante }))).toEqual({ kind: 'invia', tipo: 'followup' });
  });

  it('in_scelta vale solo per post_pitch: nelle altre fasi un inbound del 6 non ferma il follow-up', () => {
    const rows = [out('benvenuto', ancora, WELCOME), inb('eccomi', '2026-10-06T11:30:00+02:00')];
    for (const f of ['attesa', 'posto_bloccato', 'link_inviato']) {
      expect(decideFollowup(c({ lancio_fase: f, rows })), f).toEqual({ kind: 'invia', tipo: 'followup' });
    }
  });
  it('post_pitch: un no esplicito si congeda anche se la chat e viva (il no vince su in_scelta)', () => {
    const rows = [out('benvenuto', ancora, WELCOME), inb('non mi interessa piu', '2026-10-06T11:30:00+02:00')];
    expect(decideFollowup(c({ lancio_fase: 'post_pitch', rows }))).toEqual({ kind: 'congeda', leadWords: 'non mi interessa piu' });
  });
  it('gia inviato (timbro presente, anche con fase indietro = esito incerto): non si rimanda', () => {
    expect(decideFollowup(c({ lancio_followup_inviato_at: '2026-10-06T10:00:00Z' }))).toEqual({ kind: 'salta', motivo: 'gia_inviato' });
  });
  it('congedato (lancio_info.congedo_at) vince su tutto, in qualunque fase', () => {
    expect(decideFollowup(c({ lancio_info: { congedo_at: '2026-10-05T23:00:00Z' } }))).toEqual({ kind: 'salta', motivo: 'congedato' });
  });
  it('ancora ignota o nessun inbound dopo l ancora: mai scritto', () => {
    expect(decideFollowup(c({ ancora: null }))).toEqual({ kind: 'salta', motivo: 'ancora_ignota' });
    expect(decideFollowup(c({ rows: [out('benvenuto', ancora, WELCOME), inb('ciao', '2026-08-01T10:00:00Z')] }))).toEqual({ kind: 'salta', motivo: 'mai_scritto' });
  });
  it('l ultimo inbound e un no netto: si congeda con le sue parole, non si manda', () => {
    const rows = [out('benvenuto', ancora, WELCOME), inb('si', '2026-09-20T10:30:00Z'), out('link', '2026-10-05T19:40:00Z', 'HX_ZOOM'), inb('No grazie, non mi interessa', '2026-10-06T00:30:00Z')];
    expect(decideFollowup(c({ lancio_fase: 'link_inviato', rows }))).toEqual({ kind: 'congeda', leadWords: 'No grazie, non mi interessa' });
  });
  it('un rifiuto seguito da un si non e un no: conta l ultimo', () => {
    const rows = [out('benvenuto', ancora, WELCOME), inb('non mi interessa', '2026-09-20T10:30:00Z'), inb('anzi si, mi interessa', '2026-09-20T10:35:00Z')];
    expect(decideFollowup(c({ rows }))).toEqual({ kind: 'invia', tipo: 'followup' });
  });
  it('un no secco come ultimo inbound NON congeda: si manda (il no era la risposta a una domanda)', () => {
    const rows = [out('benvenuto', ancora, WELCOME), inb('si', '2026-09-20T10:30:00Z'), out('hai gia l app Zoom?', '2026-10-05T20:00:00Z'), inb('no', '2026-10-05T20:05:00Z')];
    expect(decideFollowup(c({ lancio_fase: 'link_inviato', rows }))).toEqual({ kind: 'invia', tipo: 'followup' });
  });

  // Piano 2026-10-01, Task 4: a chi non poteva esserci il bot ha promesso la registrazione.
  describe('con la promessa della registrazione', () => {
    const PROMESSA = { registrazione_promessa_at: '2026-10-02T09:00:00Z' };
    it('riceve la registrazione anche se l ultimo testo e "non posso esserci"', () => {
      const rows = [out('benvenuto', ancora, WELCOME), inb('Purtroppo lunedì non riesco, il 5 non potrò partecipare', '2026-10-02T08:59:00Z')];
      expect(decideFollowup(c({ lancio_info: PROMESSA, rows }))).toEqual({ kind: 'invia', tipo: 'registrazione' });
    });
    it('la promessa vince anche su un no che il classificatore leggerebbe come rifiuto', () => {
      const rows = [out('benvenuto', ancora, WELCOME), inb('non mi interessa', '2026-10-02T08:59:00Z')];
      expect(decideFollowup(c({ lancio_info: PROMESSA, rows }))).toEqual({ kind: 'invia', tipo: 'registrazione' });
      // Senza promessa lo stesso testo si congeda: e' la promessa a cambiare la regola.
      expect(decideFollowup(c({ rows })).kind).toBe('congeda');
    });
    it('il congedo marcato vince sulla promessa', () => {
      expect(decideFollowup(c({ lancio_info: { ...PROMESSA, congedo_at: '2026-10-03T10:00:00Z' } }))).toEqual({ kind: 'salta', motivo: 'congedato' });
    });
    it('le altre regole restano: timbro gia scritto, fase fuori perimetro, mai scritto dopo l ancora', () => {
      expect(decideFollowup(c({ lancio_info: PROMESSA, lancio_followup_inviato_at: '2026-10-06T10:00:00Z' }))).toEqual({ kind: 'salta', motivo: 'gia_inviato' });
      expect(decideFollowup(c({ lancio_info: PROMESSA, lancio_fase: 'scelta_fatta' }))).toEqual({ kind: 'salta', motivo: 'fase' });
      expect(decideFollowup(c({ lancio_info: PROMESSA, rows: [out('benvenuto', ancora, WELCOME)] }))).toEqual({ kind: 'salta', motivo: 'mai_scritto' });
    });
    it('vale in ogni fase del perimetro', () => {
      for (const f of ['attesa', 'posto_bloccato', 'link_inviato']) {
        expect(decideFollowup(c({ lancio_fase: f, lancio_info: PROMESSA })), f).toEqual({ kind: 'invia', tipo: 'registrazione' });
      }
    });
  });
});

describe('registrazionePromessa', () => {
  it('vera solo con una stringa non vuota alla chiave registrazione_promessa_at', () => {
    expect(registrazionePromessa({ registrazione_promessa_at: '2026-10-02T09:00:00Z' })).toBe(true);
    for (const v of [null, undefined, 'x', [], {}, { registrazione_promessa_at: '' }, { registrazione_promessa_at: '  ' }, { registrazione_promessa_at: 123 }, { registrazione_promessa_at: null }]) {
      expect(registrazionePromessa(v), JSON.stringify(v)).toBe(false);
    }
  });
});

describe('lancioStandardDrain — quando il drain deve usare il contesto della live', () => {
  it('vero solo per una chat del lancio in fase chiuso', () => {
    expect(lancioStandardDrain({ lancio_slug: 'webdev-2026-10', lancio_fase: 'chiuso' })).toBe(true);
    for (const f of ['attesa', 'posto_bloccato', 'link_inviato', 'post_pitch', 'scelta_fatta', 'followup_inviato', 'restituito', null]) {
      expect(lancioStandardDrain({ lancio_slug: 'webdev-2026-10', lancio_fase: f })).toBe(false);
    }
    expect(lancioStandardDrain({ lancio_slug: null, lancio_fase: 'chiuso' })).toBe(false);
    expect(lancioStandardDrain({})).toBe(false);
  });
});

describe('testi', () => {
  it('il follow-up e il template approvato (spec §7.3) col nome proprio', () => {
    expect(lancioFollowupText('Anna Verdi')).toBe(
      'Ciao Anna, ieri sera alla live abbiamo presentato il percorso Web Developer AI. Ti va di parlarne insieme? Rispondimi qui e ti mando anche il video riassuntivo della live.',
    );
  });
  it('la registrazione e il template fenice_lancio_registrazione_v1 col nome proprio e il link', () => {
    expect(lancioRegistrazioneText('Anna Verdi', 'https://x.it/reg')).toBe(
      'Ciao Anna, come ci avevi chiesto ecco la registrazione della live Web Developer AI: https://x.it/reg - se dopo averla vista vuoi parlarne con un consulente, rispondi a questo messaggio.',
    );
  });
  it('la nota del congedo dal follow-up dice cosa e successo', () => {
    expect(NOTA_CONGEDO_FOLLOWUP).toBe('Lancio Web Dev AI: aveva detto di no prima del follow-up del giorno dopo la live, non gli abbiamo scritto.');
  });
  it('la nota di contesto porta il link della live e sostituisce i quattro video; senza link e null', () => {
    const nota = lancioStandardContextNote('https://corso.feniceacademy.it/live-webdev-2026');
    expect(nota).toContain('https://corso.feniceacademy.it/live-webdev-2026');
    expect(nota).toContain('conferenza-*');
    expect(nota).not.toMatch(/prezz|€|euro|sconto/i);
    expect(lancioStandardContextNote(null)).toBeNull();
    expect(lancioStandardContextNote('  ')).toBeNull();
  });
  // PO 06/10/2026: "prima prende l'appuntamento e poi vede il video". La riga "se lo
  // chiede, mandaglielo subito, anche prima di fissare la call" faceva mandare il video
  // a chiunque rispondesse al follow-up (che il video lo promette) e poi "scrivimi FATTO
  // quando l'hai visto": 37 lead caldi su 92 parcheggiati il primo giorno, nessuna call.
  it('la nota tiene l ordine del flusso: prima l appuntamento, poi il video, anche se lo chiede', () => {
    const nota = lancioStandardContextNote('https://lp.feniceacademy.it/vsl-offerta') ?? '';
    expect(nota).not.toContain('anche prima di fissare la call');
    expect(nota).toContain('prima parlate e fissate l\'appuntamento con il consulente, POI mandi il video');
    expect(nota).toMatch(/NON si manda prima che la call sia fissata, nemmeno se te lo chiede/);
    expect(nota).toMatch(/FATTO/);
  });
  it('chi ha gia il link e dice che lo guarda dopo: si fissa subito, non si aspetta', () => {
    const nota = lancioStandardContextNote('https://lp.feniceacademy.it/vsl-offerta') ?? '';
    expect(nota).toMatch(/NON aspettare e non salutarlo: fissate subito la call/);
    expect(nota).not.toContain("la live l'ha gia' vista");
  });
});

describe('linkSviluppatoreContextNote — chi scrive dal link "professione dello Sviluppatore AI"', () => {
  const LIVE = 'https://corso.feniceacademy.it/live-webdev-2026';
  it('dopo la live: chiede se l ha vista e il video e la registrazione', () => {
    const nota = linkSviluppatoreContextNote({ videoLiveLink: LIVE, eventoPassato: true });
    expect(nota).toMatch(/chiedi.*se ha visto la live/i);
    expect(nota).toContain(LIVE);
    expect(nota).toContain('conferenza-*');
    expect(nota).toMatch(/flusso e' quello standard/i);
    expect(nota).not.toMatch(/prezz|€|euro|sconto/i);
  });
  it('dopo la live ma senza link: la domanda resta, i video restano i classici', () => {
    const nota = linkSviluppatoreContextNote({ videoLiveLink: null, eventoPassato: true });
    expect(nota).toMatch(/se ha visto la live/i);
    expect(nota).not.toContain('conferenza-*');
    expect(nota).not.toContain('http');
  });
  it('prima della live: niente domanda sulla live, flusso standard', () => {
    const nota = linkSviluppatoreContextNote({ videoLiveLink: LIVE, eventoPassato: false });
    expect(nota).not.toMatch(/se ha visto la live/i);
    expect(nota).not.toContain(LIVE);
    expect(nota).toMatch(/flusso e' quello standard/i);
  });
});

describe('eventoLancioPassato', () => {
  const EVT = '2026-10-05T21:00:00+02:00';
  it('vero dall inizio della live in poi', () => {
    expect(eventoLancioPassato(EVT, Date.parse('2026-10-05T21:00:00+02:00'))).toBe(true);
    expect(eventoLancioPassato(EVT, Date.parse('2026-10-08T10:00:00+02:00'))).toBe(true);
  });
  it('falso prima, e falso con data assente o illeggibile (niente domanda su una live che non sappiamo)', () => {
    expect(eventoLancioPassato(EVT, Date.parse('2026-10-05T20:59:00+02:00'))).toBe(false);
    expect(eventoLancioPassato(null, Date.parse('2026-10-08T10:00:00+02:00'))).toBe(false);
    expect(eventoLancioPassato('boh', Date.parse('2026-10-08T10:00:00+02:00'))).toBe(false);
  });
});

describe('bloccaPassaggioLancio (PO 25/09/2026: il lancio non passa mai un lead ai GDO)', () => {
  const base = { lancioStandard: true, passToHuman: true, esitoInPiedi: null, appointmentFixed: false };
  it('chat del lancio senza appuntamento: il passaggio si blocca', () => {
    expect(bloccaPassaggioLancio(base)).toBe(true);
  });
  it('appuntamento gia registrato o fissato in questo turno: il passaggio resta (va alle Conferme)', () => {
    expect(bloccaPassaggioLancio({ ...base, esitoInPiedi: 'APPUNTAMENTO' })).toBe(false);
    expect(bloccaPassaggioLancio({ ...base, appointmentFixed: true })).toBe(false);
  });
  it('fuori dal lancio o senza tag non cambia niente', () => {
    expect(bloccaPassaggioLancio({ ...base, lancioStandard: false })).toBe(false);
    expect(bloccaPassaggioLancio({ ...base, passToHuman: false })).toBe(false);
  });
  it('la frase e la nota non promettono un contatto e portano alla call', () => {
    expect(TESTO_LANCIO_NIENTE_PASSAGGIO).toMatch(/consulente/);
    expect(TESTO_LANCIO_NIENTE_PASSAGGIO).not.toMatch(/collega|ti contatt|ti richiam/);
    expect(NOTA_LANCIO_NIENTE_PASSAGGIO).toMatch(/Non usare MAI \[PASSAGGIO_UMANO\]/);
  });
});

describe('pulsanteDopoNotteContextNote (PO 25/09)', () => {
  it('pulsante il 6: la live l ha vista, niente domanda, video della live se c e', async () => {
    const { pulsanteDopoNotteContextNote } = await import('./lancio-followup');
    const n = pulsanteDopoNotteContextNote({ da: 'pulsante', videoLiveLink: ' https://x/live ', risposte: [] });
    expect(n).toMatch(/dal pulsante mostrato alla fine della live/);
    expect(n).toMatch(/non chiedergli se l'ha vista/);
    expect(n).toContain('https://x/live');
    expect(n).toMatch(/fissa la call con il consulente/);
    expect(n).not.toMatch(/ci aveva gia' detto/);
  });
  it('post_pitch oltre le 03:00: porta le risposte della sera; senza link niente riga del video', async () => {
    const { pulsanteDopoNotteContextNote } = await import('./lancio-followup');
    const n = pulsanteDopoNotteContextNote({ da: 'post_pitch', videoLiveLink: null, risposte: ['studio', 'il progetto'] });
    expect(n).toMatch(/la sera stessa ha premuto il pulsante/);
    expect(n).toContain('"studio" / "il progetto"');
    expect(n).not.toMatch(/registrazione della live:/);
  });
});

describe('iscrittoDopoLiveContextNote (PO 25/09)', () => {
  it('col link: la live c e gia stata, registrazione al posto dei video classici', async () => {
    const { iscrittoDopoLiveContextNote } = await import('./lancio-followup');
    const n = iscrittoDopoLiveContextNote('https://x/live');
    expect(n).toMatch(/la live era gia' finita/);
    expect(n).toMatch(/gli mandi la registrazione/);
    expect(n).toContain('https://x/live');
    expect(n).toMatch(/fissa la call/);
  });
  it('senza link (lancio_video_live_link vuoto): la registrazione non si promette', async () => {
    const { iscrittoDopoLiveContextNote } = await import('./lancio-followup');
    const n = iscrittoDopoLiveContextNote('  ');
    expect(n).toMatch(/non promettergliela/);
    expect(n).not.toMatch(/gli mandi la registrazione/);
  });
});

describe('PO 06/10/2026: fascia unica 9-20, spalmata, e partecipanti al webinar', () => {
  it('la fascia e 09:00-18:30', async () => {
    const { FASCE_FOLLOWUP } = await import('./lancio-followup');
    expect(FASCE_FOLLOWUP).toEqual([{ daMin: 540, aMin: 1110 }]);
  });
  it('la quota spalma i 2.000 del giorno sui run che restano, fra 10 e max', async () => {
    const { quotaFollowup } = await import('./lancio-followup');
    // 09:00: 114 run fino alle 18:30, 2.000 da mandare -> 18
    expect(quotaFollowup(new Date('2026-10-06T09:00:00+02:00'), 3000, 200, 0)).toBe(18);
    // 11:00, gia' 650 inviati oggi: 1.350 su 90 run -> 15
    expect(quotaFollowup(new Date('2026-10-06T11:00:00+02:00'), 3000, 200, 650)).toBe(15);
    // 11:00, coda quasi vuota: 300 su 90 run -> 4 -> minimo 10
    expect(quotaFollowup(new Date('2026-10-06T11:00:00+02:00'), 300, 200, 650)).toBe(10);
    // 18:20: due run, 1.300 da mandare -> fermo al lotto massimo
    expect(quotaFollowup(new Date('2026-10-06T18:20:00+02:00'), 3000, 200, 700)).toBe(200);
    // tetto raggiunto: zero; quasi raggiunto: non lo sfora
    expect(quotaFollowup(new Date('2026-10-06T12:00:00+02:00'), 3000, 200, 2000)).toBe(0);
    expect(quotaFollowup(new Date('2026-10-06T12:00:00+02:00'), 3000, 200, 1995)).toBe(5);
  });
  it('i giorni del follow-up sono 4, dal giorno dopo l evento', async () => {
    const { giorniFollowup } = await import('./lancio-followup');
    expect(giorniFollowup(EVENTO)).toEqual(['2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09']);
  });
  it('partecipanteWebinar: solo minuti numerici positivi', async () => {
    const { partecipanteWebinar } = await import('./lancio-followup');
    expect(partecipanteWebinar({ zoom_minuti: 90 })).toBe(true);
    expect(partecipanteWebinar({ zoom_minuti: 0 })).toBe(false);
    expect(partecipanteWebinar(null)).toBe(false);
  });
});
