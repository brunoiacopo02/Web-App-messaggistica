import { isBookableDate, type BlackoutRange } from './booking-blackout';
import { isoWithOffset } from './bot-contract';
import { quandoNoemi } from './gdo-recap';
import { firstNameOf } from './name';
import { giornoRoma, oraRoma, romeDayKey, romeHour, romeMinute, sameInstant } from './rome-time';

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
 * - sui lead dei GDO (postino), mai sulle call fissate dal bot stesso;
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

export type MotivoNonSpostabile =
  | 'spento'
  | 'non_postino'
  | 'call_del_bot'
  | 'senza_data'
  | 'call_vicina_o_passata'
  | 'gia_spostato'
  | 'esito_conferme'
  | 'gia_presentato'
  | 'disdetta_chiesta';

/** La chat può offrire lo spostamento? `null` = sì. Non guarda la data nuova. */
export function motivoNonSpostabile(i: {
  enabled: boolean;
  postino: boolean;
  botOutcome: string | null;
  appuntamentoAt: string | null;
  giaSpostato: boolean;
  /** Dalla copia locale dello stato CRM (`crm_lead_status`), se c'è. */
  confermeOutcome?: string | null;
  presented?: boolean | null;
  salesOutcome?: string | null;
  nowMs: number;
}): MotivoNonSpostabile | null {
  if (!i.enabled) return 'spento';
  if (!i.postino) return 'non_postino';
  // Le call fissate dal bot restano com'erano: lì vale la regola del 25/09.
  if (i.botOutcome === 'APPUNTAMENTO') return 'call_del_bot';
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
