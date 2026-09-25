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
/**
 * Il lancio non passa MAI un lead ai GDO (PO 25/09/2026). Nel flusso standard il
 * passaggio a una persona finiva nella coda delle richieste di contatto e da li' a un GDO:
 * finche' il lead non ha un appuntamento, "voglio una persona" e' la call col consulente.
 * Con l'appuntamento gia' fissato la richiesta va alle Conferme, non ai GDO: resta com'e'.
 */
export const NOTA_LANCIO_NIENTE_PASSAGGIO =
  "Non usare MAI [PASSAGGIO_UMANO] in questa chat e non promettere che lo contatta o lo richiama una collega: la persona con cui parlera' e' il consulente, nella call che fissi tu. Se chiede una persona o di essere chiamato, proponigli di fissare la call.";

/** La riga che il lead legge al posto di quella del modello quando scrive [PASSAGGIO_UMANO] lo stesso. */
export const TESTO_LANCIO_NIENTE_PASSAGGIO =
  "Ti rispondo io: la persona con cui parlerai e' il nostro consulente, in una call dedicata a te. Vuoi che la fissiamo? Dimmi che giorno ti va meglio.";

/**
 * Il passaggio a una persona si blocca sulle chat del lancio in mano a Mario standard
 * finche' non c'e' un appuntamento (ne' gia' registrato, ne' fissato in questo turno).
 */
export function bloccaPassaggioLancio(i: {
  lancioStandard: boolean;
  passToHuman: boolean;
  esitoInPiedi: string | null;
  appointmentFixed: boolean;
}): boolean {
  return i.lancioStandard && i.passToHuman && i.esitoInPiedi !== 'APPUNTAMENTO' && !i.appointmentFixed;
}

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
 * Nota di contesto per chi passa a Mario standard DOPO la notte del webinar (decisione PO
 * 25/09): ha premuto il pulsante dal 6 in poi (`da: 'pulsante'`), oppure l'aveva premuto
 * la sera e la chat ha attraversato le 03:00 a meta' della scelta (`da: 'post_pitch'`).
 * Il flusso e' quello standard — Mario fissa la call come per qualunque lead — ma il lead
 * la live l'ha vista: non glielo si chiede, e quello che ha gia' raccontato la sera non si
 * richiede. I pulsanti della sera (chiamata subito, fissiamo domani…) non valgono piu'.
 * Mai null: il contesto della live serve anche senza il link della registrazione.
 */
export function pulsanteDopoNotteContextNote(i: {
  da: 'pulsante' | 'post_pitch';
  videoLiveLink: string | null;
  risposte: readonly string[];
}): string {
  const righe = [
    i.da === 'pulsante'
      ? "CONTESTO LANCIO WEB DEVELOPER AI: questo lead ha seguito la live del percorso Web Developer AI del 5 ottobre e ci ha scritto dal pulsante mostrato alla fine della live: vuole saperne di piu'."
      : "CONTESTO LANCIO WEB DEVELOPER AI: questo lead ha seguito la live del percorso Web Developer AI del 5 ottobre, la sera stessa ha premuto il pulsante alla fine della live e abbiamo iniziato a parlare. Ora la conversazione prosegue con te.",
    "La live l'ha vista: non chiedergli se l'ha vista. Parti da quello che l'ha colpito e da cosa vuole capire meglio.",
  ];
  if (i.risposte.length > 0) {
    righe.push(
      `La sera della live ci aveva gia' detto: ${i.risposte.map((r) => `"${r.slice(0, 200)}"`).join(' / ')}. Non rifargli le stesse domande: usale.`,
    );
  }
  righe.push(
    "Se in cronologia ci sono pulsanti di scelta della sera della live (chiamata subito, fissiamo domani, oggi pomeriggio, domani mattina), non valgono piu': la call si fissa con te, con il flusso standard.",
  );
  const link = i.videoLiveLink?.trim();
  if (link) {
    righe.push(
      `Il video di preparazione da mandargli e' UNO SOLO ed e' la registrazione della live: ${link}`,
      "Usa questo link al posto dei quattro link conferenza-* del blocco sul video, in ogni punto in cui manderesti il video. Non chiedere se lavora o ha famiglia per scegliere il video: il video e' questo.",
    );
  }
  righe.push("Per il resto il flusso e' quello standard: fissa la call con il consulente come sempre.");
  return righe.join('\n');
}

/**
 * Nota di contesto per chi si e' iscritto alla live quando era gia' finita, o era rimasto
 * in coda senza benvenuto (decisione PO 25/09): la live non l'ha vista. Mario gli dice
 * che c'e' gia' stata, gli manda la registrazione e fissa la call come sempre.
 *
 * Senza `lancio_video_live_link` la registrazione NON si promette: si fissa la call coi
 * video classici (e il drain lascia il warn `lancio_video_live_link_missing`, una volta
 * per chat). Promettere un link che non c'e' e' peggio che non nominarlo.
 */
export function iscrittoDopoLiveContextNote(videoLiveLink: string | null): string {
  const righe = [
    "CONTESTO LANCIO WEB DEVELOPER AI: questo lead si e' iscritto alla live gratuita del percorso Web Developer AI del 5 ottobre, ma la live era gia' finita e non l'ha vista.",
  ];
  const link = videoLiveLink?.trim();
  if (link) {
    righe.push(
      "Nel tuo primo messaggio digli che la live c'e' gia' stata e che gli mandi la registrazione, poi fissa la call.",
      `Il video di preparazione da mandargli e' UNO SOLO ed e' la registrazione della live: ${link}`,
      "Usa questo link al posto dei quattro link conferenza-* del blocco sul video, in ogni punto in cui manderesti il video. Non chiedere se lavora o ha famiglia per scegliere il video: il video e' questo.",
    );
  } else {
    righe.push(
      "Se ne parla, digli che la live c'e' gia' stata. La registrazione non ce l'hai: non promettergliela e non inventare link.",
    );
  }
  righe.push("Per il resto il flusso e' quello standard: fissa la call con il consulente come sempre.");
  return righe.join('\n');
}

/**
 * Nota di contesto per chi ci scrive dal link "professione dello Sviluppatore AI" (PO
 * 24/09/2026). Il flusso e' quello standard, come dopo il follow-up; cambiano l'apertura
 * e il video. Dopo la live Mario chiede se l'ha vista, e il video di preparazione e' la
 * registrazione. Prima della live (scelta (a) del PO) non la nomina: fissa e basta.
 * Mai null, a differenza della nota del follow-up: senza link la domanda sulla live
 * serve lo stesso, e i video restano i quattro classici.
 */
export function linkSviluppatoreContextNote(i: { videoLiveLink: string | null; eventoPassato: boolean }): string {
  const righe = [
    "CONTESTO LANCIO WEB DEVELOPER AI: questo lead ci ha scritto dal link \"professione dello Sviluppatore AI\", la pubblicita' del percorso Web Developer AI.",
  ];
  if (!i.eventoPassato) {
    righe.push("Il flusso e' quello standard: presentati e fissa la call come sempre. Non nominare nessuna live o webinar.");
    return righe.join('\n');
  }
  righe.push(
    'Il 5 ottobre abbiamo fatto una live su questo percorso. Nel tuo primo messaggio chiedigli se ha visto la live del 5 ottobre.',
    "Se l'ha vista, parti da li': chiedigli cosa l'ha colpito e cosa vuole capire meglio. Se non l'ha vista, digli che gli mandi la registrazione.",
  );
  const link = i.videoLiveLink?.trim();
  if (link) {
    righe.push(
      `Il video di preparazione da mandargli e' UNO SOLO ed e' la registrazione della live: ${link}`,
      "Usa questo link al posto dei quattro link conferenza-* del blocco sul video, in ogni punto in cui manderesti il video. Non chiedere se lavora o ha famiglia per scegliere il video: il video e' questo.",
    );
  }
  righe.push("Per il resto il flusso e' quello standard: fissa la call con il consulente come sempre.");
  return righe.join('\n');
}

/**
 * La chat e' del lancio ed e' in mano a Mario standard: fase `chiuso` (dopo il
 * follow-up, o dopo il congedo — ma un congedato non arriva al drain: `shouldReopen`
 * lo tiene chiuso). `restituito` NO: quel lead e' del GDO (ruling C8).
 */
export function lancioStandardDrain(c: { lancio_slug?: string | null; lancio_fase?: string | null }): boolean {
  return !!c.lancio_slug && c.lancio_fase === 'chiuso';
}

/**
 * La live del lancio e' gia' iniziata? Da `lancio_evento_at` (app_settings). Assente o
 * illeggibile = no: meglio non chiedere di una live che non sappiamo se c'e' stata.
 */
export function eventoLancioPassato(eventoAt: string | null, nowMs: number): boolean {
  if (!eventoAt) return false;
  const t = Date.parse(eventoAt);
  return !Number.isNaN(t) && nowMs >= t;
}
