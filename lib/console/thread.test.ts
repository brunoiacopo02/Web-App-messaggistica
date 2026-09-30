import { describe, it, expect } from 'vitest';
import { raggruppa, finestra24h, autoreDi, numeroWa, intercala, leggibile, dataOraBreve, testoEvento, TIPI_EVENTI_THREAD, fondiMessaggi, cursoreDopo, type Gruppo, type Msg } from './thread';

const m = (id: number, direction: 'in' | 'out', created_at: string, sender: string | null = null): Msg =>
  ({ id, direction, body: 'x', created_at, is_template: false, twilio_status: 'delivered', twilio_error_code: null, sender });

const forma = (g: Gruppo[]) =>
  g.map((x) => (x.tipo === 'giorno' ? x.etichetta : `${x.lato}:${x.messaggi.length}`));

it('separatori di giorno e blocchi consecutivi dello stesso lato', () => {
  const g = raggruppa([m(1, 'out', '2026-10-04T16:02:00Z', 'bot'), m(2, 'in', '2026-10-05T18:47:00Z'), m(3, 'in', '2026-10-05T18:48:00Z'), m(4, 'out', '2026-10-05T18:49:00Z', 'bot')], new Date('2026-10-05T19:00:00Z'));
  expect(forma(g)).toEqual(['Ieri', 'bot:1', 'Oggi', 'lead:2', 'bot:1']);
});

it('giorni più vecchi di ieri: giorno della settimana e data, sul calendario di Roma', () => {
  // 22:30Z del 30/09 è già il 1/10 a Roma.
  const g = raggruppa([m(1, 'in', '2026-09-30T22:30:00Z')], new Date('2026-10-05T19:00:00Z'));
  expect(g[0]).toEqual({ tipo: 'giorno', etichetta: 'giovedì 1 ottobre' });
});

it('in uscita, un autore diverso apre un blocco nuovo', () => {
  const g = raggruppa(
    [m(1, 'out', '2026-10-05T18:00:00Z', 'automazione'), m(2, 'out', '2026-10-05T18:01:00Z', 'bot'), m(3, 'out', '2026-10-05T18:02:00Z', 'bot')],
    new Date('2026-10-05T19:00:00Z'),
  );
  expect(g.slice(1).map((x) => (x.tipo === 'blocco' ? `${x.autore}:${x.messaggi.length}` : ''))).toEqual(['Automazione:1', 'Mario:2']);
});

it('autore dei messaggi in uscita, dai valori reali di messages.sender', () => {
  // Valori letti in produzione il 26/09/2026 (ultimi 7 giorni): out 'bot' 42.969,
  // out 'automazione' 6.422, out 'operatore' 5, in null 23.720.
  expect(autoreDi('bot')).toBe('Mario');
  expect(autoreDi(null)).toBe('Mario');
  expect(autoreDi('mario')).toBe('Mario');
  expect(autoreDi('automazione')).toBe('Automazione');
  expect(autoreDi('operatore')).toBe('Operatore');
  expect(autoreDi('human')).toBe('Operatore');
  // Non visti negli ultimi 7 giorni, gestiti per non mostrare valori grezzi.
  expect(autoreDi('gdo:105')).toBe('GDO 105');
  expect(autoreDi('noemi@fenice.com')).toBe('noemi');
});

it('autore del bot: Mario, o il GDO se sender lo dice', () => {
  const g = raggruppa([m(1, 'out', '2026-10-05T18:00:00Z', 'gdo:105')], new Date('2026-10-05T19:00:00Z'));
  expect((g[1] as { autore: string }).autore).toBe('GDO 105');
});

it('finestra 24h', () => {
  const now = new Date('2026-10-05T19:30:00Z');
  expect(finestra24h('2026-10-05T19:14:00Z', now)).toEqual({ aperta: true, chiudeAlle: 'domani 21:14' });
  expect(finestra24h('2026-10-04T20:00:00Z', now)).toEqual({ aperta: true, chiudeAlle: 'oggi 22:00' });
  expect(finestra24h('2026-10-03T10:00:00Z', now)).toEqual({ aperta: false, chiudeAlle: null });
  expect(finestra24h(null, now)).toEqual({ aperta: false, chiudeAlle: null });
});

it('numero WA: le ultime 4 cifre, oppure null', () => {
  expect(numeroWa('whatsapp:+393520413199')).toBe('3199');
  expect(numeroWa('+393522070047')).toBe('0047');
  expect(numeroWa(null)).toBeNull();
});

it('intercala le righe di sistema per orario dentro i blocchi', () => {
  const g = raggruppa([m(1, 'in', '2026-10-05T18:00:00Z'), m(2, 'in', '2026-10-05T18:10:00Z')], new Date('2026-10-05T19:00:00Z'));
  const v = intercala(g, [{ at: '2026-10-05T18:05:00Z', tipo: 'bot_paused', testo: 'fermo', livello: 'warn' }], new Date('2026-10-05T19:00:00Z'));
  expect(v.map((x) => x.tipo === 'giorno' ? x.etichetta : x.tipo === 'sistema' ? 'sys' : `${x.lato}:${x.messaggi.length}`)).toEqual(['Oggi', 'lead:1', 'sys', 'lead:1']);
});

it('codici leggibili e data breve', () => {
  expect(leggibile('CONTATTO_UMANO')).toBe('Contatto umano');
  expect(leggibile(null)).toBeNull();
  expect(dataOraBreve('2026-09-24T15:00:00Z')).toBe('24/09 17:00');
  expect(dataOraBreve(null)).toBeNull();
});

describe('testoEvento: frasi italiane per le righe di sistema', () => {
  const casi: [string, string | null, string][] = [
    ['bot_intake', '[bot-fissatore] intake lead 5 → conv 9', 'Lead preso in carico dal bot'],
    ['lancio_intake', '[lancio] x', 'Lead entrato nel lancio'],
    ['fenice_enroll', 'Lead arruolato (Mario): +39333', 'Lead arruolato da Mario'],
    ['bot_outcome_sent', '[bot-fissatore] esito APPUNTAMENTO inviato per lead 5', 'Esito Appuntamento inviato al CRM'],
    ['bot_outcome_sent', '[bot-fissatore] RICHIAMO interim inviato per lead 5 (sequenza in corso)', 'Richiamo provvisorio inviato al CRM'],
    ['bot_outcome_locked', '[bot-fissatore] esito X intercettato', 'Esito intercettato: il lead era già in appuntamento, nota al CRM'],
    ['bot_outcome_rejected', '[bot-fissatore] CRM ha rifiutato (403)', "Il CRM ha rifiutato l'esito: chat chiusa in locale"],
    ['bot_note_sent', '[gdo] nota inviata al CRM per lead 5', 'Nota inviata al CRM'],
    ['bot_fermo_stato_crm', '[bot-fissatore] conv 3: il bot non risponde, il CRM dice APPOINTMENT', 'Bot fermo: il CRM dice Appointment'],
    ['bot_contatto_umano_inviato', null, 'Richiesta di contatto umano inviata'],
    ['bot_appuntamento_rifissato', null, 'Appuntamento rifissato dal bot'],
    ['bot_paused', '[chat] bot fermato sulla conv 3 da a@b.it', 'Bot fermato da a@b.it'],
    ['bot_paused', null, 'Bot fermato'],
    ['bot_resumed', '[chat] bot riattivato sulla conv 3 da a@b.it', 'Bot riattivato da a@b.it'],
    ['stale_handed_off', 'x', 'Chat passata a persona da oltre 48 ore senza esito: serve chiusura manuale'],
    ['cancel_requested', 'x', 'Il lead ha chiesto di annullare o spostare: automatismi spenti'],
    ['inbound_su_altro_numero', 'x', 'Il lead ha risposto a un altro numero: la chat non si sposta'],
    ['lancio_fase_cambiata', '[lancio] conv 3: fase → posto_bloccato', 'Fase del lancio: posto bloccato'],
    ['lancio_posto_bloccato', 'x', 'Posto bloccato per il lead'],
    ['lancio_domanda', '[lancio] conv 3: risposta a domanda 2/3', 'Risposta a domanda 2 di 3'],
    ['lancio_apertura_inviata', 'x', 'Messaggio di apertura inviato'],
    ['lancio_silenzio', 'x', 'Il lead non ha risposto'],
    ['lancio_congedo', 'x', 'Congedo inviato al lead'],
    ['lancio_ripresa_manuale', 'x', 'Chat ripresa a mano'],
    ['gdo_video_sent', '[gdo] video inviato a +39 dopo la risposta', 'Video inviato al lead'],
    ['gdo_video_followup_sent', 'x', 'Sollecito sul video inviato'],
    ['video_watched', 'x', 'Il lead conferma di aver visto il video'],
    ['gdo_agenda_sent', 'x', 'Agenda del GDO inviata al lead'],
    ['gdo_agenda_esito', '[gdo] agenda per il lead 5: inviato', 'Esito invio agenda GDO: inviato'],
    ['recupero_nr_inviato', 'x', 'Recupero per mancata risposta inviato'],
    ['richiamo_restituito', 'x', 'Richiamo restituito ai GDO'],
    ['appuntamento_registrato', '[crm] data della call registrata per il lead 5: 2026-09-24T15:00:00Z', 'Appuntamento registrato per il 24/09 17:00'],
    ['appuntamento_registrato', null, 'Appuntamento registrato'],
    ['appuntamento_spostato', '[crm] appuntamento del lead 5 spostato da a a 2026-09-24T15:00:00Z', 'Appuntamento spostato al 24/09 17:00'],
    ['console_azione', 'x', 'Azione eseguita dalla console'],
  ];
  it.each(casi)('%s', (tipo, message, atteso) => {
    expect(testoEvento(tipo, message)).toBe(atteso);
  });

  it('un caso per ogni tipo del thread', () => {
    for (const t of TIPI_EVENTI_THREAD) expect(casi.some(([c]) => c === t), t).toBe(true);
  });

  it('tipo sconosciuto: frase generica, mai il testo tecnico né vuoto', () => {
    expect(testoEvento('boh_strano', '[x] technical error snake_case')).toBe('Evento di sistema');
    expect(testoEvento('', null)).toBe('Evento di sistema');
  });
});

it('fondiMessaggi: aggiunge i nuovi, aggiorna per id (stato di consegna), resta in ordine', () => {
  const a = m(1, 'out', '2026-10-05T18:00:00Z', 'bot');
  const b = { ...m(2, 'in', '2026-10-05T18:01:00Z'), twilio_status: null };
  const aLetto = { ...a, twilio_status: 'read' };
  const c = m(3, 'out', '2026-10-05T18:02:00Z', 'bot');
  const f = fondiMessaggi([a, b], [c, aLetto]);
  expect(f.map((x) => x.id)).toEqual([1, 2, 3]);
  expect(f[0].twilio_status).toBe('read');
  expect(fondiMessaggi([a], [])).toEqual([a]);
});

it('cursoreDopo: sovrappone gli ultimi messaggi per rileggerne lo stato', () => {
  const lista = Array.from({ length: 30 }, (_, i) => m(i + 1, 'out', `2026-10-05T18:${String(i).padStart(2, '0')}:00Z`));
  expect(cursoreDopo(lista)).toBe(10);
  expect(cursoreDopo(lista.slice(0, 5))).toBe(0);
  expect(cursoreDopo([])).toBe(0);
});
