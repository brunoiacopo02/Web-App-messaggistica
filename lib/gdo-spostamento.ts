import { isBookableDate, type BlackoutRange } from './booking-blackout';
import { isoWithOffset } from './bot-contract';
import { quandoNoemi } from './gdo-recap';
import { firstNameOf } from './name';
import { giornoRoma, oraRoma, romeDayKey, romeHour, romeMinute, sameInstant } from './rome-time';
import { parlaDiDisdireOSpostare } from './gdo-warmup';

/**
 * Il bot sposta lui la call di un lead GDO (PO 28/10/2026, contratto v1.9 esito
 * `SPOSTAMENTO`). Qui solo regole e testi, senza I/O: l'invio al CRM sta in
 * `gdo-spostamento-send.ts`, il turno in `fenice-autoreply.ts`.
 *
 * Perché: sui lead GDO la nota "SPOSTAMENTO CHIESTO" con la data rende il 18% di
 * confermati, senza data il 4%; e le Conferme chiamavano lead che dicevano «ho già
 * spostato col bot». Fino al 25/09 il bot spostava le SUE call (in media +1 giorno, e i
 * lead si presentavano come gli altri); il 25/09 lo abbiamo fermato perché spostava anche
 * call già confermate con un tutor in calendario. Qui si sposta solo:
 * - sui lead dei GDO (postino) e, dal 29/10/2026 (PO), anche sulle call fissate dal bot
 *   stesso, con le stesse regole e la stessa nota: `origine` le tiene distinte negli eventi;
 * - una volta sola;
 * - nei prossimi 3 giorni lavorativi, dalle 10 alle 21 (le 9 solo se il lead insiste);
 * - se le Conferme non hanno ancora esitato il lead (confermato = venditore in calendario).
 * Il modello propone la data col tag [SPOSTA|...], il codice la verifica, il CRM decide.
 * Qualunque "no" ripiega sulla nota SPOSTAMENTO CHIESTO di sempre.
 */

/** Interruttore: acceso salvo `GDO_SPOSTAMENTO_BOT_ENABLED=0` (funzione approvata dal PO il 28/10/2026). */
export function spostamentoAbilitato(env: string | undefined): boolean {
  return env !== '0';
}

export const SPOSTAMENTO_GIORNI = 3;
/** Fascia accettata dal codice, minuti di Roma, estremi inclusi. Il prompt propone dalle 10. */
const DA_MIN = 9 * 60;
const A_MIN = 21 * 60;
/** Sotto quest'anticipo la call è troppo vicina per spostarla dalla chat: ci pensano le Conferme. */
const ANTICIPO_MIN_MS = 30 * 60_000;

/** Il giorno lavorativo dopo la chiave 'YYYY-MM-DD' (la domenica salta). */
function lavorativoDopo(key: string): string {
  const g = new Date(`${key}T12:00:00Z`);
  g.setUTCDate(g.getUTCDate() + 1);
  if (g.getUTCDay() === 0) g.setUTCDate(g.getUTCDate() + 1);
  return g.toISOString().slice(0, 10);
}

/**
 * I giorni in cui si può spostare: i prossimi 3 lavorativi dopo oggi (la domenica non
 * conta), meno quelli di chiusura. Stessa finestra del CRM
 * (`src/lib/bot-fissatore/spostamentoGdo.ts`); i giorni chiusi si tolgono, non si
 * sostituiscono, così il bot non propone mai un giorno che il CRM rifiuterebbe.
 */
export function giorniSpostamento(now: Date, ranges: BlackoutRange[]): string[] {
  const giorni: string[] = [];
  let key = romeDayKey(now);
  for (let i = 0; i < SPOSTAMENTO_GIORNI; i++) {
    key = lavorativoDopo(key);
    giorni.push(key);
  }
  return giorni.filter((g) => isBookableDate(g, ranges));
}

/**
 * Di chi è la call che si sposta. `gdo`: lead di un GDO, bot postino (28/10/2026).
 * `bot`: call fissata dal bot (`bot_outcome = APPUNTAMENTO`, PO 29/10/2026). Va in ogni
 * evento (`gdo_spostamento_bot`, `gdo_spostamento_non_fatto`): la misura del 4/11 e
 * dell'11/11 si fa solo sui lead GDO. Una chat postino che ha anche un APPUNTAMENTO del
 * bot non ha un'origine sicura (quale data vale?) e resta fuori: `null`.
 */
export type OrigineSpostamento = 'gdo' | 'bot';

export function origineSpostamento(i: { postino: boolean; botOutcome: string | null }): OrigineSpostamento | null {
  const delBot = i.botOutcome === 'APPUNTAMENTO';
  if (i.postino) return delBot ? null : 'gdo';
  return delBot ? 'bot' : null;
}

/**
 * La data della call fissata dal bot. `bot_scheduled_at` è la nostra; `gdo_appuntamento_at`
 * su queste chat lo scrive solo il CRM (`appointment-set`) quando le Conferme spostano la
 * call. Se le due date sono diverse la call l'ha già mossa qualcun altro: non si sposta
 * (`cambiata`), decide chi l'ha in mano.
 */
export function dataCallDelBot(
  botScheduledAt: string | null,
  gdoAppuntamentoAt: string | null,
): { at: string | null; cambiata: boolean } {
  if (!botScheduledAt) return { at: null, cambiata: false };
  return { at: botScheduledAt, cambiata: !!gdoAppuntamentoAt && !sameInstant(botScheduledAt, gdoAppuntamentoAt) };
}

export type MotivoNonSpostabile =
  | 'spento'
  | 'non_postino'
  | 'data_cambiata_dal_crm'
  | 'senza_data'
  | 'call_vicina_o_passata'
  | 'gia_spostato'
  | 'esito_conferme'
  | 'gia_presentato'
  | 'disdetta_chiesta';

/** La chat può offrire lo spostamento? `null` = sì. Non guarda la data nuova. */
export function motivoNonSpostabile(i: {
  enabled: boolean;
  /** `null`: né lead GDO né call del bot (vedi `origineSpostamento`). */
  origine: OrigineSpostamento | null;
  appuntamentoAt: string | null;
  /** Solo call del bot: la data l'ha già cambiata il CRM (`dataCallDelBot`). */
  dataCambiata?: boolean;
  giaSpostato: boolean;
  /** Dalla copia locale dello stato CRM (`crm_lead_status`), se c'è. */
  confermeOutcome?: string | null;
  presented?: boolean | null;
  salesOutcome?: string | null;
  nowMs: number;
}): MotivoNonSpostabile | null {
  if (!i.enabled) return 'spento';
  if (!i.origine) return 'non_postino';
  if (i.dataCambiata) return 'data_cambiata_dal_crm';
  if (!i.appuntamentoAt || Number.isNaN(Date.parse(i.appuntamentoAt))) return 'senza_data';
  if (Date.parse(i.appuntamentoAt) - i.nowMs < ANTICIPO_MIN_MS) return 'call_vicina_o_passata';
  if (i.giaSpostato) return 'gia_spostato';
  if (i.presented || i.salesOutcome) return 'gia_presentato';
  // confermato (venditore in calendario), scartato, da_rifissare: decide chi l'ha in mano.
  if (i.confermeOutcome) return 'esito_conferme';
  return null;
}

export type MotivoDataNonValida =
  | 'assente'
  | 'illeggibile'
  | 'passato'
  | 'stessa_data'
  | 'domenica'
  | 'giorno_chiuso'
  | 'fuori_finestra'
  | 'fuori_fascia';

/** La data del tag [SPOSTA|...] è buona? `null` = sì. Tutto in ora di Roma. */
export function motivoDataNonValida(
  date: string | undefined,
  vecchia: string | null,
  nowMs: number,
  ranges: BlackoutRange[],
): MotivoDataNonValida | null {
  if (!date || !date.trim()) return 'assente';
  if (!isoWithOffset(date.trim())) return 'illeggibile';
  const t = Date.parse(date);
  if (t <= nowMs) return 'passato';
  if (vecchia && (sameInstant(date, vecchia) || Math.abs(Date.parse(vecchia) - t) < 60_000)) return 'stessa_data';
  const quando = new Date(t);
  const giorno = romeDayKey(quando);
  if (new Date(`${giorno}T12:00:00Z`).getUTCDay() === 0) return 'domenica';
  if (!isBookableDate(giorno, ranges)) return 'giorno_chiuso';
  if (!giorniSpostamento(new Date(nowMs), ranges).includes(giorno)) return 'fuori_finestra';
  const minuti = romeHour(quando) * 60 + romeMinute(quando);
  if (minuti < DA_MIN || minuti > A_MIN) return 'fuori_fascia';
  return null;
}

/** "giovedì 29, venerdì 30 e sabato 31": i giorni come li legge il lead. */
export function elencoGiorni(giorni: string[]): string {
  const nomi = giorni.map((g) => giornoRoma(new Date(`${g}T12:00:00Z`)));
  if (nomi.length <= 1) return nomi.join('');
  return `${nomi.slice(0, -1).join(', ')} e ${nomi[nomi.length - 1]}`;
}

/**
 * Il blocco per il prompt, appeso alla nota GDO solo quando lo spostamento si può fare.
 * Prevale sulla regola "giorno e ora di una call già fissata non li sposti tu", e SOLO
 * per questo lead e solo per lo spostamento: il tono assertivo resta qui dentro.
 */
export function notaSpostamentoPrompt(i: { giorni: string[]; callAt: Date }): string {
  const giorni = elencoGiorni(i.giorni);
  const call = `${giornoRoma(i.callAt)} alle ${oraRoma(i.callAt)}`;
  return [
    `SPOSTAMENTO DELLA CALL (vale solo per questo lead e solo se ti chiede di spostare): la sua videochiamata è ${call}. Qui lo spostamento lo fai TU, una volta sola, e questa regola prevale su "GIORNO E ORA DI UNA CALL GIÀ FISSATA NON LI SPOSTI TU" e su "il giorno nuovo lo sistemi con Noemi".`,
    `Se ti chiede di spostare, o ti dice che non ce la fa, rispondi con tono deciso ma gentile, frasi corte e parole semplici. Fagli sentire che aveva preso un impegno, per esempio: "Avevi preso un impegno e la videochiamata era riservata a te. Si può spostare una volta sola: dimmi giorno e ora in cui sei sicuro di esserci." Puoi spostarla solo a ${giorni}, dalle 10:00 alle 21:00. Le 9:00 non proporle mai: accettale solo se ti dice che è l'unico orario possibile. Una domanda sola: giorno e ora.`,
    `Quando ti dà un giorno e un'ora dentro quei giorni e quella fascia, scrivi SOLO il tag [SPOSTA|<data e ora in ISO 8601 con fuso, es. 2026-10-30T18:00:00+01:00>] e nient'altro: il messaggio di conferma, con Noemi e il video, lo manda il sistema. Se ti dà solo il giorno, chiedigli l'ora; se ti dà solo l'ora, chiedigli il giorno.`,
    `Se il giorno che vuole è fuori da quei giorni, diglielo una volta: si può spostare solo a ${giorni}. Se ti dice che non può prima, o parla di settimane o mesi, o resta vago ("non so", "ti faccio sapere"), NON usare [SPOSTA]: fai come nella sezione SE VUOLE SPOSTARE O DISDIRE (il nuovo orario lo sistema con Noemi) e chiudi con [ESITO:RICHIAMO|...]. Se vuole rinunciare del tutto, vale [ESITO:SCARTO|...] come sempre.`,
  ].join('\n');
}

/** Il lead ha già confermato di aver visto il video? Decide la riga del video nella conferma. */
export function testoSpostamentoFatto(i: {
  nome: string | null;
  call: Date;
  /** Quando conta come fissata la call per dire quando chiama Noemi: adesso. */
  fissatoIl: Date;
  videoVisto: boolean;
  videoLink: string | null;
}): string {
  const n = firstNameOf(i.nome);
  const righe = [
    `${n ? `Fatto ${n}` : 'Fatto'}, la tua videochiamata ora è *${giornoRoma(i.call)} alle ${oraRoma(i.call)}*.`,
    'Si può spostare una volta sola: a quell\'ora devi esserci.',
    `*Ti chiama Noemi, una nostra collega, ${quandoNoemi(i.call, i.fissatoIl)}* da un numero di cellulare. Rispondi, perché se non rispondi la videochiamata non è confermata.`,
  ];
  if (!i.videoVisto) {
    righe.push(
      i.videoLink
        ? `Il video l'hai già visto? Se no, guardalo prima della videochiamata 👉 ${i.videoLink}`
        : "Il video l'hai già visto? Se no, guardalo prima della videochiamata: te l'ho mandato qui sopra",
    );
  }
  return righe.join('\n');
}

/** Il testo che parte quando lo spostamento non si è potuto fare: la data va alle Conferme. */
export const TESTO_SPOSTAMENTO_NON_FATTO =
  'Ho segnato il giorno e l\'ora che mi hai detto. Per confermare il nuovo orario ti chiama Noemi, una nostra collega: rispondi, sono 5 minuti.';

/**
 * Il testo quando lo spostamento non si fa perche' le Conferme hanno gia' deciso sul lead
 * (CRM 409 `scartato`/`confermato`, o lo stato locale lo dice gia'): li' nessuno ha in
 * programma di richiamarlo, e «ti chiama Noemi» sarebbe una promessa falsa (lead c91081be,
 * 30/10/2026: scartato dalle Conferme 90 secondi prima). La data va comunque alle Conferme.
 */
export const TESTO_SPOSTAMENTO_PASSATO_AI_COLLEGHI =
  'Ho segnato il giorno e l\'ora che mi hai detto e li ho passati ai colleghi che seguono gli appuntamenti.';

/** Motivi del "no" per cui le Conferme hanno gia' deciso: niente promessa della telefonata. */
const MOTIVI_CONFERME_GIA_DECISO = new Set(['scartato', 'confermato', 'esito_conferme', 'gia_presentato']);

export function testoSpostamentoNonFatto(motivo: string | null | undefined): string {
  return motivo && MOTIVI_CONFERME_GIA_DECISO.has(motivo)
    ? TESTO_SPOSTAMENTO_PASSATO_AI_COLLEGHI
    : TESTO_SPOSTAMENTO_NON_FATTO;
}

/**
 * Lo stesso [SPOSTA] alla stessa data e' gia' stato tentato e rifiutato in questa chat?
 * (lead c91081be: dopo il 409, su «Ok grazie» il modello rimette [SPOSTA] e il lead riceve
 * lo stesso testo due volte). `tentativi` = le date degli eventi `gdo_spostamento_non_fatto`.
 */
export function spostamentoGiaRifiutato(data: string | undefined, tentativi: readonly (string | null | undefined)[]): boolean {
  if (!data || !data.trim()) return false;
  return tentativi.some((t) => !!t && (t.trim() === data.trim() || (isoWithOffset(t.trim()) && isoWithOffset(data.trim()) && sameInstant(t, data))));
}

/** Frasi che confermano o prendono atto, non chiedono di spostare ("farò il possibile", "l'ho visto stamattina!"). */
const FRASE_CHE_CONFERMA =
  /^(faro il possibile|ci saro|confermo|l ho (gia )?visto|visto|fatto|tutto chiaro)( (grazie|stamattina|ieri|oggi|sicuramente|certo|allora))*$/;

const normalizzaFrase = (s: string): string =>
  s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * Il RICHIAMO del modello NON e' una richiesta di spostamento e non deve diventare la
 * nota «SPOSTAMENTO CHIESTO … mantenuto finché non lo spostate voi»? (lead 4da4e19f,
 * 30/10/2026: dopo lo spostamento fatto dal bot a martedi' 3 alle 17, «farò il possibile»
 * e «l'ho visto stamattina!» hanno prodotto due note di spostamento.)
 *
 * Si', solo se il modello non ha messo una data nuova (o ha rimesso quella in agenda), il
 * turno non ha un [SPOSTA], il lead non parla di spostare/disdire, e:
 * - la call in agenda e' proprio quella appena spostata dal bot, oppure
 * - il lead ha solo preso atto o confermato ("ok", "farò il possibile", "l'ho visto") e nei
 *   suoi messaggi di prima (`testoPrima`) non c'e' una richiesta di spostare rimasta aperta:
 *   un "ok" dopo «giovedì non posso» puo' essere il RICHIAMO vero di quella richiesta.
 */
export function richiamoNonESpostamento(i: {
  outcome: string | undefined;
  date: string | undefined;
  spostaNelTurno: boolean;
  /** La call in agenda adesso. */
  callAt: string | null;
  /** La data a cui il bot ha spostato la call (ultimo `gdo_spostamento_bot`), o null. */
  spostataDalBotA: string | null;
  testoLead: string;
  /** Il turno del lead e' solo una presa d'atto (`isSoloPresaDAtto`). */
  soloPresaDAtto: boolean;
  /** I messaggi del lead dei turni appena prima (vale solo per la seconda regola). */
  testoPrima?: string;
}): boolean {
  if (i.outcome !== 'RICHIAMO' || i.spostaNelTurno) return false;
  if (i.date && i.date.trim() && !(i.callAt && isoWithOffset(i.date.trim()) && sameInstant(i.date, i.callAt))) return false;
  if (parlaDiDisdireOSpostare(i.testoLead)) return false;
  const callSpostata = !!i.callAt && !!i.spostataDalBotA && sameInstant(i.callAt, i.spostataDalBotA);
  if (callSpostata) return true;
  if (i.testoPrima && parlaDiDisdireOSpostare(i.testoPrima)) return false;
  return i.soloPresaDAtto || FRASE_CHE_CONFERMA.test(normalizzaFrase(i.testoLead));
}

const LINK_VIDEO_RE = /https?:\/\/corso\.feniceacademy\.it\/conferenza-[A-Za-z0-9_-]+/g;

/**
 * L'ultimo link del video uscito in chat (call fissate dal bot, che non hanno
 * `gdo_video_url`): serve alla riga del video nella conferma dello spostamento.
 * Senza link la conferma dice «te l'ho mandato qui sopra».
 */
export function ultimoLinkVideo(rows: { direction: string; body?: string | null }[]): string | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (r.direction !== 'out' || !r.body) continue;
    const trovati = r.body.match(LINK_VIDEO_RE);
    if (trovati && trovati.length > 0) return trovati[trovati.length - 1];
  }
  return null;
}
