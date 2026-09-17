import { romeDayKey, romeHour, romeMinute } from './rome-time';
import { giorniLancio } from './lancio-scelta';
import { haCongedo, indiceUltimaPressionePulsante, type RigaLancio } from './lancio-fase';
import { congedoEsplicito } from './lancio-classifica';
import { templateName } from './name';

/**
 * Follow-up del giorno dopo la live (spec §5.5): a chi ha interagito col bot dopo il
 * benvenuto ma non ha scelto la sera del pitch. Qui le sole decisioni, senza effetti:
 * il cron `/api/cron/lancio-followup` le applica col motore del blast.
 */

/**
 * Fasi che ricevono il follow-up. `scelta_fatta` no: quel lead ha gia' scelto ed e' del
 * CRM. `post_pitch` SI', ma solo se la chat e' ferma (vedi `decideFollowup`): chi ha
 * premuto il pulsante la sera del 5, ha magari risposto a una domanda di riscaldamento e
 * poi non ha piu' scritto restava altrimenti li' per sempre — fuori dal follow-up, fuori
 * dalle restituzioni, e fuori dal re-drive di Mario (`lancioInCorso` tiene i suoi cron
 * lontani da tutte le fasi non terminali).
 */
export const FASI_FOLLOWUP = ['attesa', 'posto_bloccato', 'link_inviato', 'post_pitch'] as const;

/** Le due fasce di Roma, in minuti del giorno, estremi `[da, a)`: 12:00-14:00 e 17:30-19:30. */
export const FASCE_FOLLOWUP: readonly { daMin: number; aMin: number }[] = [
  { daMin: 12 * 60, aMin: 14 * 60 },
  { daMin: 17 * 60 + 30, aMin: 19 * 60 + 30 },
];

const minutiDelGiorno = (d: Date) => romeHour(d) * 60 + romeMinute(d);

// Il giorno dopo l'evento e dopodomani (sconfinamento), dentro una delle due fasce. Lo
// schedule UTC di vercel.json (ogni 5 minuti nelle ore 10-11 e 15-17 UTC del 6 e 7/10)
// copre 12:00-13:55 e 17:00-19:55 di Roma: il filtro fine sta qui, e i giorni si
// derivano dall'evento, non da date scritte a mano.
export function inFinestraFollowup(now: Date, eventoAt: Date): boolean {
  const g = giorniLancio(eventoAt);
  const giorno = romeDayKey(now);
  if (giorno !== g.giornoDopo && giorno !== g.dopodomani) return false;
  const m = minutiDelGiorno(now);
  return FASCE_FOLLOWUP.some((f) => m >= f.daMin && m < f.aMin);
}

/** Dopo la fine dell'ultima fascia di dopodomani: i residui sono definitivi. */
export function finestraFollowupChiusa(now: Date, eventoAt: Date): boolean {
  const g = giorniLancio(eventoAt);
  const giorno = romeDayKey(now);
  if (giorno > g.dopodomani) return true;
  if (giorno < g.dopodomani) return false;
  return minutiDelGiorno(now) >= FASCE_FOLLOWUP[FASCE_FOLLOWUP.length - 1].aMin;
}

/**
 * "Questo istante viene dopo l'ancora (o e' l'ancora)". Si confrontano i millisecondi,
 * non le stringhe: l'ancora e le righe arrivano da tre tabelle diverse
 * (`conversations.lancio_benvenuto_at`, `messages.created_at`, `event_log.created_at`) e
 * basta un `...Z` contro un `...+00:00`, o una precisione ai microsecondi contro una ai
 * millisecondi, perche' un confronto testuale dia l'ordine sbagliato. Su un ISO non
 * parsabile si torna al confronto lessicografico, che e' giusto a formato uniforme.
 */
function nonPrimaDi(iso: string | null | undefined, ancoraIso: string): boolean {
  if (!iso) return false;
  const a = Date.parse(iso);
  const b = Date.parse(ancoraIso);
  if (Number.isNaN(a) || Number.isNaN(b)) return iso >= ancoraIso;
  return a >= b;
}

/**
 * L'istante da cui un messaggio del lead "conta" per questo lancio: la colonna
 * `lancio_benvenuto_at` (timbrata all'invio del benvenuto), poi l'ultima riga del
 * template di benvenuto in cronologia, poi l'ULTIMA pressione del pulsante del webinar
 * (inclusa), poi l'evento `lancio_intake`. Null = non si sa: chi chiama NON manda
 * (template su numero a qualita' LOW).
 *
 * Il pulsante e' l'ancora di chi nel lancio e' entrato la sera della live senza essere
 * mai stato in lista: li' il benvenuto non esiste, e `lancio_intake` e' scritto DOPO la
 * riga del pulsante (il webhook salva il messaggio e poi arruola). Con l'intake come
 * ancora quella pressione restava fuori, `haInteragito` era falso, e un lead che aveva
 * alzato la mano risultava "non ha mai scritto": niente follow-up il 6 e, l'8, ritorno al
 * pool con la nota `Lancio: mai risposto`. L'ordine e la regola sono gli stessi del
 * taglio della cronologia (`tagliaRigheDalLancio`), che li applica dal B4.
 */
export function ancoraLancio(i: {
  rows: RigaLancio[];
  welcomeSid: string | null;
  benvenutoAt: string | null;
  ingressoAt: string | null;
}): string | null {
  if (i.benvenutoAt) return i.benvenutoAt;
  if (i.welcomeSid) {
    for (let k = i.rows.length - 1; k >= 0; k--) {
      const r = i.rows[k];
      if (r.template_sid === i.welcomeSid && r.created_at) return r.created_at;
    }
  }
  const pulsante = indiceUltimaPressionePulsante(i.rows);
  if (pulsante >= 0 && i.rows[pulsante].created_at) return i.rows[pulsante].created_at as string;
  return i.ingressoAt;
}

/**
 * L'istante dell'ULTIMO messaggio del lead dall'ancora in poi, in millisecondi. `null`
 * se non ce n'e' nessuno o se la data non si legge: chi chiama tratta il "non si sa"
 * come "la chat potrebbe essere viva" e sta zitto.
 */
export function ultimoInboundMs(rows: RigaLancio[], ancoraIso: string): number | null {
  let ultimo: number | null = null;
  for (const m of inboundDopo(rows, ancoraIso)) {
    const ms = Date.parse(m.created_at ?? '');
    if (Number.isNaN(ms)) return null;
    if (ultimo === null || ms > ultimo) ultimo = ms;
  }
  return ultimo;
}

/** Gli inbound dall'ancora in poi (compresa). */
export function inboundDopo(rows: RigaLancio[], ancoraIso: string): RigaLancio[] {
  return rows.filter((m) => m.direction === 'in' && nonPrimaDi(m.created_at, ancoraIso));
}

/** "Ha interagito" = almeno un messaggio del lead dall'ancora in poi. */
export function haInteragito(rows: RigaLancio[], ancoraIso: string | null): boolean {
  if (!ancoraIso) return false;
  return inboundDopo(rows, ancoraIso).length > 0;
}

/** L'ultimo messaggio del lead con del testo, dall'ancora in poi. Vuoto = solo media. */
export function ultimoTestoInbound(rows: RigaLancio[], ancoraIso: string): string {
  const dopo = inboundDopo(rows, ancoraIso);
  for (let k = dopo.length - 1; k >= 0; k--) {
    const testo = (dopo[k].body ?? '').trim();
    if (testo !== '') return testo;
  }
  return '';
}

/**
 * Il rifiuto ESPLICITO (ruling C1 aggiornato il 17/09): solo le frasi di `NO_FRASI`
 * ("non mi interessa", "toglimi dalla lista", "no grazie"…), mai il "no" secco — in
 * assistenza il bot fa domande e quel "no" e' una risposta (commit 9d17b88). Un lead
 * freddo che riceve il follow-up costa un template; un lead scartato per un "no" detto
 * a "hai l'app Zoom?" e' irreversibile.
 */
export function haDettoNo(testo: string): boolean {
  return congedoEsplicito(testo);
}

export type MotivoSalto = 'fase' | 'gia_inviato' | 'congedato' | 'ancora_ignota' | 'mai_scritto' | 'in_scelta';
export type DecisioneFollowup =
  | { kind: 'invia' }
  | { kind: 'congeda'; leadWords: string }
  | { kind: 'salta'; motivo: MotivoSalto };

export type CandidataFollowup = {
  lancio_fase: string | null;
  lancio_followup_inviato_at: string | null;
  lancio_info: unknown;
  rows: RigaLancio[];
  ancora: string | null;
  /**
   * Le 03:00 di Roma del giorno dopo l'evento (`fineNotteLancio`), in millisecondi: la
   * fine della modalita' notte, cioe' il confine oltre il quale un `post_pitch` che
   * scrive e' un lead dentro il flusso della scelta e non un lead fermo.
   */
  fineNotte: number;
};

/**
 * Cosa fare con questa chat. L'ordine e' quello del costo dell'errore: una fase fuori
 * perimetro e un timbro gia' scritto non si toccano; il congedo vince su tutto (C4); senza
 * ancora o senza inbound dopo l'ancora non si manda; chi ha detto no per ultimo si
 * congeda (C1) invece di ricevere "ti va di parlarne?".
 */
export function decideFollowup(c: CandidataFollowup): DecisioneFollowup {
  if (!c.lancio_fase || !(FASI_FOLLOWUP as readonly string[]).includes(c.lancio_fase)) return { kind: 'salta', motivo: 'fase' };
  if (c.lancio_followup_inviato_at) return { kind: 'salta', motivo: 'gia_inviato' };
  if (haCongedo(c.lancio_info)) return { kind: 'salta', motivo: 'congedato' };
  if (!c.ancora) return { kind: 'salta', motivo: 'ancora_ignota' };
  if (!haInteragito(c.rows, c.ancora)) return { kind: 'salta', motivo: 'mai_scritto' };
  const testo = ultimoTestoInbound(c.rows, c.ancora);
  if (testo !== '' && haDettoNo(testo)) return { kind: 'congeda', leadWords: testo };
  // `post_pitch`: il follow-up e' l'ultima rete per chi si e' fermato dopo il pulsante,
  // ma NON si interrompe chi sta ancora scegliendo. Il discrimine e' l'ultimo inbound:
  // prima delle 03:00 del giorno dopo la chat e' ferma dalla sera del pitch (il turno
  // post-pitch non risponde piu' da quell'ora in poi, `puoRispondere`); dalle 03:00 in
  // poi il lead ha scritto di giorno, e li' il flusso della scelta e' vivo — una bolla di
  // marketing sopra una conversazione in corso e' il danno peggiore dei due.
  if (c.lancio_fase === 'post_pitch') {
    const ultimo = ultimoInboundMs(c.rows, c.ancora);
    if (ultimo === null || ultimo >= c.fineNotte) return { kind: 'salta', motivo: 'in_scelta' };
  }
  return { kind: 'invia' };
}

/** Nota al CRM col `DA_SCARTARE` del congedo deciso dal cron (nessuna bolla al lead). */
export const NOTA_CONGEDO_FOLLOWUP =
  'Lancio Web Dev AI: aveva detto di no prima del follow-up del giorno dopo la live, non gli abbiamo scritto.';

/**
 * Corpo del template `LANCIO_FOLLOWUP_TEMPLATE_SID` (spec §7.3) con {{1}} risolto: e'
 * quello che finisce nella riga `messages` per i pannelli. Identico al template approvato.
 */
export function lancioFollowupText(name: string | null | undefined): string {
  return (
    `Ciao ${templateName(name)}, ieri sera alla live abbiamo presentato il percorso Web Developer AI. ` +
    'Ti va di parlarne insieme? Rispondimi qui e ti mando anche il video riassuntivo della live.'
  );
}

/**
 * Nota di contesto per `generateMarioReply` dopo il follow-up (spec §5.5): il flusso e'
 * quello standard, l'unica differenza e' il video, che e' la live editata. Null senza
 * link: Mario usa i quattro video classici (meglio un video che nessun video). Nessuna
 * promessa nuova: "il video riassuntivo della live" e' nel template approvato.
 */
export function lancioStandardContextNote(videoLiveLink: string | null): string | null {
  const link = videoLiveLink?.trim();
  if (!link) return null;
  return [
    'CONTESTO LANCIO WEB DEVELOPER AI: questo lead era iscritto alla live del percorso Web Developer AI e ha risposto al nostro messaggio del giorno dopo.',
    `Il video di preparazione da mandargli e' UNO SOLO ed e' la registrazione della live: ${link}`,
    "Usa questo link al posto dei quattro link conferenza-* del blocco sul video, in ogni punto in cui manderesti il video. Non chiedere se lavora o ha famiglia per scegliere il video: il video e' questo.",
    'Nel messaggio gli abbiamo scritto che gli mandiamo il video riassuntivo della live: se lo chiede, mandaglielo subito, anche prima di fissare la call.',
  ].join('\n');
}

/**
 * La chat e' del lancio ed e' in mano a Mario standard: fase `chiuso` (dopo il
 * follow-up, o dopo il congedo — ma un congedato non arriva al drain: `shouldReopen`
 * lo tiene chiuso). `restituito` NO: quel lead e' del GDO (ruling C8).
 */
export function lancioStandardDrain(c: { lancio_slug?: string | null; lancio_fase?: string | null }): boolean {
  return !!c.lancio_slug && c.lancio_fase === 'chiuso';
}
