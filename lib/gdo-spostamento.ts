import { isBookableDate, type BlackoutRange } from './booking-blackout';
import { isoWithOffset } from './bot-contract';
import { quandoNoemi } from './gdo-recap';
import { firstNameOf } from './name';
import { giornoRoma, oraRoma, romeDayKey, romeHour, romeMinute, sameInstant } from './rome-time';
import { parlaDiDisdireOSpostare } from './gdo-warmup';
import { FASCE, oreAffollate, oreDaProporre, type OreOccupate } from './ore-occupate';

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
 *
 * «IL BOT SPOSTA SEMPRE» (PO 12/11/2026). Dal 29/10 al 12/11: 43 spostamenti veri → 26% di
 * confermati sugli esitati; 46 lead rimasti con la sola nota → 0 presenti. Decisione: la
 * sola nota resta dove lo spostamento non si può proprio fare. I rami che finivano in nota
 * e cosa cambia (conteggi dal registro del bot, 29/10-12/11):
 * - lead già SCARTATO dalle Conferme (di solito dopo le tre chiamate senza risposta) che
 *   chiede un altro giorno, ~23 chat: ora il blocco c'è e il CRM sposta riaprendo lo scarto;
 * - call a meno di 30 minuti, ~6 chat: il limite è tolto, basta che la call sia futura;
 * - call del GDO già passata (da non più di 7 giorni), ~3 chat: ora si sposta; sulle call
 *   del bot resta il fissaggio nuovo (`isRifissaggioDopoCallPassata`);
 * - il modello scrive [ESITO:RICHIAMO|data] o [ESITO:APPUNTAMENTO|data] al posto di
 *   [SPOSTA|data], ~8 chat: ora il codice lo tratta come [SPOSTA] (`esitoDaSpostare`);
 * - lead vago o senza data, ~27 chat: il blocco ora fa insistere e proporre due orari
 *   precisi, fino a due volte, prima di ripiegare sulla nota.
 * Restano nota (casi residui): interruttore spento; lead confermato con un venditore, o
 * già presentato; call già spostata una volta dal bot; data fuori dai 3 giorni o dalla
 * fascia; un anticipo rispetto alla call (`esitoDaSpostare`); il CRM che risponde no o non
 * risponde; il lead che dopo due solleciti non dà giorno e ora; call del bot già spostata
 * dalle Conferme; chat postino con anche un appuntamento del bot; call passata da più di
 * 7 giorni; lead senza scheda nel CRM.
 */

/** Interruttore: acceso salvo `GDO_SPOSTAMENTO_BOT_ENABLED=0` (funzione approvata dal PO il 28/10/2026). */
export function spostamentoAbilitato(env: string | undefined): boolean {
  return env !== '0';
}

export const SPOSTAMENTO_GIORNI = 3;
/** Fascia accettata dal codice, minuti di Roma, estremi inclusi. Il prompt propone dalle 10. */
const DA_MIN = 9 * 60;
const A_MIN = 21 * 60;
/**
 * Una call del GDO passata da più di così non si sposta più: è un lead vecchio, già
 * lavorato (stessa soglia di `AGENDA_VECCHIA_GIORNI` in `giudice-spostamento.ts` e del CRM,
 * `SPOSTAMENTO_CALL_PASSATA_MAX_GIORNI`). Fino al 12/11/2026 non si spostava niente sotto i
 * 30 minuti dalla call né dopo: uscivano come nota.
 */
export const CALL_PASSATA_MAX_GIORNI = 7;
/**
 * «Non posso in questi giorni, ti riscrivo io» (PO 12/11/2026, chat 25906: voleva la
 * settimana del 23/11, tre settimane dopo). Il bot insiste sui giorni della finestra; se il
 * lead proprio non può gli dice di riscrivere quando sa quando può, e quando riscrive lo
 * sposta, con la finestra di 3 giorni contata da quel giorno. Lo spostamento "una volta
 * sola" non si consuma (non c'è stato nessuno spostamento) e la call vecchia, anche se nel
 * frattempo è passata, resta spostabile fino a questi giorni (stesso tetto nel CRM:
 * `SPOSTAMENTO_CALL_PASSATA_MAX_GIORNI`).
 */
export const ATTESA_LEAD_MAX_GIORNI = 60;
/** L'evento che segna «il lead riscrive lui per la nuova data». */
export const EVENTO_ATTESA_LEAD = 'gdo_spostamento_attesa_lead';

/**
 * Il RICHIAMO di questo turno è «non posso in questi giorni, riscrivo io»? Sì quando la
 * call si poteva spostare (il blocco era nel prompt, che fa uscire con [ESITO:RICHIAMO] solo
 * così) e il turno non ha prodotto né tentato uno spostamento.
 */
export function eRiscriveLui(i: {
  outcome: string | undefined;
  spostaAt: string | undefined;
  spostamentoFatto: boolean;
  motivoNoSposta: MotivoNonSpostabile | null;
}): boolean {
  return i.outcome === 'RICHIAMO' && i.spostaAt === undefined && !i.spostamentoFatto && i.motivoNoSposta === null;
}
const CALL_PASSATA_MAX_MS = CALL_PASSATA_MAX_GIORNI * 24 * 3600_000;

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
  | 'call_passata'
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
  /** Il lead aveva detto «in questi giorni non posso, riscrivo io» (`EVENTO_ATTESA_LEAD`):
   *  la call del GDO si sposta anche se è passata da più di 7 giorni, fino a
   *  `ATTESA_LEAD_MAX_GIORNI`. */
  inAttesaDelLead?: boolean;
  nowMs: number;
}): MotivoNonSpostabile | null {
  if (!i.enabled) return 'spento';
  if (!i.origine) return 'non_postino';
  if (i.dataCambiata) return 'data_cambiata_dal_crm';
  if (!i.appuntamentoAt || Number.isNaN(Date.parse(i.appuntamentoAt))) return 'senza_data';
  // Call passata: quella del GDO si sposta se è passata da poco (PO 12/11/2026), o da più
  // tempo se il lead doveva riscrivere lui; quella del bot no, perché lì il modello fissa un
  // appuntamento nuovo (`isRifissaggioDopoCallPassata`).
  const passataDaMs = i.nowMs - Date.parse(i.appuntamentoAt);
  const maxPassataMs = i.inAttesaDelLead ? ATTESA_LEAD_MAX_GIORNI * 24 * 3600_000 : CALL_PASSATA_MAX_MS;
  if (passataDaMs >= 0 && (i.origine === 'bot' || passataDaMs > maxPassataMs)) return 'call_passata';
  if (i.giaSpostato) return 'gia_spostato';
  if (i.presented || i.salesOutcome) return 'gia_presentato';
  // Scartato dalle Conferme: si sposta, il CRM riapre lo scarto (PO 12/11/2026).
  // Confermato (venditore in calendario), da_rifissare, autofissato: decide chi l'ha in mano.
  if (i.confermeOutcome && i.confermeOutcome !== 'scartato') return 'esito_conferme';
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
 *
 * ORARIO SICURO (PO 10/11/2026): chi sposta ha già saltato o sta per saltare una call.
 * Il nuovo orario deve essere uno in cui il lead è CERTO di esserci, ragionato sui suoi
 * impegni, e confermato esplicitamente prima del [SPOSTA]: niente orari proposti al buio
 * ("dalle 10 in poi", conv 6111) che il lead accetta per cortesia e poi salta. Le ore meno
 * piene (`oreOccupate`, lo stesso dato del fissaggio) contano solo come criterio secondario
 * fra orari ugualmente sicuri per lui.
 */
export function notaSpostamentoPrompt(i: {
  giorni: string[];
  callAt: Date;
  oreOccupate?: OreOccupate | null;
  /** La call in agenda è già passata (lead GDO che l'ha saltata, PO 12/11/2026). */
  callPassata?: boolean;
}): string {
  const giorni = elencoGiorni(i.giorni);
  const call = `${giornoRoma(i.callAt)} alle ${oraRoma(i.callAt)}`;
  const menoPiene = righeOreMenoPiene(i.giorni, i.oreOccupate ?? null);
  const laCall = i.callPassata
    ? `la sua videochiamata era ${call} e non si è fatta: se vuole rifarla la sposti tu a un giorno nuovo`
    : `la sua videochiamata è ${call}`;
  return [
    `SPOSTAMENTO DELLA CALL (vale solo per questo lead e solo se ti chiede di spostare): ${laCall}. Qui lo spostamento lo fai TU, una volta sola, e questa regola prevale su "GIORNO E ORA DI UNA CALL GIÀ FISSATA NON LI SPOSTI TU" e su "il giorno nuovo lo sistemi con Noemi".`,
    `Se ti chiede di spostare, o ti dice che non ce la fa, rispondi con tono deciso ma gentile, frasi corte e parole semplici. Fagli sentire che aveva preso un impegno, per esempio: "Avevi preso un impegno e la videochiamata era riservata a te. Si può spostare una volta sola: dimmi giorno e ora in cui sei sicuro di esserci." Puoi spostarla solo a ${giorni}, dalle 10:00 alle 21:00: questi sono i limiti, non una proposta da fargli. Le 9:00 non proporle mai: accettale solo se ti dice che è l'unico orario possibile.`,
    `ORARIO SICURO: lo scopo non è un orario qualsiasi, è un orario in cui è CERTO di esserci. Non proporgli tu orari al buio e non dargli fasce generiche ("dalle 10 in poi", "dalle 10 alle 21", "quando vuoi"): chi li accetta per cortesia poi salta di nuovo. Chiedigli quando è davvero sicuro di poterci essere, partendo da quello che ti ha raccontato di lavoro, turni, figli o impegni (es. "Giovedì che turno fai? Dimmi un'ora in cui sei sicuro di essere libero e col telefono in mano"). Se ti chiede di proporre tu, prima chiedigli che impegni ha in quei giorni, poi proponi due ore precise che stanno sicuramente fuori da quegli impegni. Una domanda alla volta.`,
    `CONFERMA PRIMA DI SPOSTARE: quando ti dà un giorno e un'ora dentro quei giorni e quella fascia, NON spostare subito. Prima chiedigli una conferma esplicita, una domanda sola, richiamando l'impegno che ti ha detto se c'è (es. "Giovedì 29 alle 18: a quell'ora sei sicuro di esserci, anche col turno che finisce alle 17?"). Se nello stesso messaggio ti aveva già detto lui che a quell'ora è sicuro di esserci, la conferma c'è già. Se tentenna ("penso di sì", "dovrei", "spero", "salvo imprevisti", "vediamo") non spostare: chiedigli cosa potrebbe impedirglielo e cercate insieme un orario davvero sicuro.`,
    ...(menoPiene ? [
      `ORE MENO PIENE (criterio secondario, solo fra orari che per lui sono ugualmente sicuri: la sicurezza viene prima): ${menoPiene}. Se è lui a dirti un'ora sicura, va bene quella anche se è fra le già piene: non dirgli che è piena e non provare a spostarla.`,
    ] : []),
    `Quando ti ha confermato in modo chiaro che a quel giorno e a quell'ora c'è di sicuro, scrivi SOLO il tag [SPOSTA|<data e ora in ISO 8601 con fuso, es. 2026-10-30T18:00:00+01:00>] e nient'altro: il messaggio di conferma, con Noemi e il video, lo manda il sistema. Se ti dà solo il giorno, chiedigli l'ora; se ti dà solo l'ora, chiedigli il giorno.`,
    `LO SPOSTI SEMPRE TU: quando chiede di spostare non rimandarlo a Noemi e non chiudere con [ESITO:RICHIAMO] finché c'è modo di fissare tu giorno e ora. Se resta vago ("non so", "ti faccio sapere", "più avanti") o non ti dà un orario, non mollare al primo giro: chiedigli che impegni ha in quei giorni e proponigli TU due orari precisi fuori da quegli impegni (es. "giovedì alle 18 o venerdì alle 11: in quale dei due sei sicuro di esserci?"). Fallo al massimo due volte, una domanda per messaggio. Se il giorno che vuole è oltre quei giorni (la settimana prossima, fra due settimane, una data lontana), diglielo una volta (si può spostare solo a ${giorni}) e insisti proponendogli due orari dentro quei giorni.`,
    `SE IN QUEI GIORNI NON PUÒ PROPRIO (te lo dice chiaro, o dopo due tentativi non ti dà un giorno e un'ora): NON usare [SPOSTA], non fissargli niente fuori da quei giorni, non mandarlo da Noemi e non proporgli di annullare. Digli di riscriverti lui qui appena sa quando può, e che in quel momento la sposti tu: lo spostamento non lo perde. Es. "Va bene, allora facciamo così: appena sai quando puoi scrivimi qui e te la sposto io in quel momento". Non dirgli che la videochiamata è annullata e non dirgli che non gli scriverai più. Chiudi quel messaggio con [ESITO:RICHIAMO|<le sue parole sul quando, o la data ISO se te l'ha detta>]. Se vuole rinunciare del tutto, vale [ESITO:SCARTO|...] come sempre.`,
  ].join('\n');
}

/**
 * Il modello ha chiuso il turno con [ESITO:RICHIAMO|data] o [ESITO:APPUNTAMENTO|data] al
 * posto di [SPOSTA|data] su una call che il bot può spostare (PO 12/11/2026).
 *
 * Il manuale dice «su una call già fissata lo spostamento è SEMPRE un RICHIAMO», e il
 * modello ogni tanto lo segue anche col blocco dello spostamento nel prompt: la data, buona
 * e dentro la finestra, usciva come nota «SPOSTAMENTO CHIESTO … a giovedì 12 alle 12:00» e
 * la call restava dov'era (conv 30493, 31594, 32096, 30950: 8 chat in due settimane). Se
 * la data regge tutti i controlli di [SPOSTA], il codice la tratta come [SPOSTA]: torna la
 * data da spostare, altrimenti `null` e l'esito segue la strada di sempre.
 *
 * Solo POSTICIPI (o call già passata): una data PRIMA della call in agenda di solito è
 * l'ora in cui il lead vuole essere richiamato da Noemi («richiamatemi domani alle 10»,
 * con la videochiamata domani alle 18), non un nuovo orario della videochiamata. Quella
 * resta una nota e la legge una persona.
 */
export function esitoDaSpostare(i: {
  outcome: string | undefined;
  date: string | undefined;
  /** Il turno ha già un [SPOSTA]. */
  spostaAt: string | undefined;
  motivoNoSposta: MotivoNonSpostabile | null;
  callAt: string | null;
  nowMs: number;
  ranges: BlackoutRange[];
}): string | null {
  if (i.spostaAt !== undefined) return null;
  if (i.outcome !== 'RICHIAMO' && i.outcome !== 'APPUNTAMENTO') return null;
  if (i.motivoNoSposta !== null || !i.callAt) return null;
  const data = (i.date ?? '').trim();
  if (!data || motivoDataNonValida(data, i.callAt, i.nowMs, i.ranges) !== null) return null;
  const callMs = Date.parse(i.callAt);
  if (callMs > i.nowMs && Date.parse(data) < callMs) return null;
  return data;
}

/**
 * Il blocco per il prompt DOPO che il bot ha spostato la call (chat 31379, 09/11/2026).
 *
 * Lo spostamento si fa una volta sola, quindi dal turno dopo `notaSpostamentoPrompt` esce
 * dal prompt e resta solo il manuale: «GIORNO E ORA DI UNA CALL GIÀ FISSATA NON LI SPOSTI
 * TU, MAI… non gli dici "fatto"». Il modello si ritrovava in cronologia la bolla «Fatto, la
 * tua videochiamata ora è…» (scritta dal codice, non da lui), la prendeva per un suo errore
 * e la smentiva: «lo spostamento non lo faccio io, non darlo per fatto… per ora la call
 * resta stasera», con la call già spostata nel CRM. Il lead ha due date in testa e le
 * Conferme una nota di spostamento falsa.
 *
 * Qui il modello viene a sapere che lo spostamento è vero e registrato. Va nel prompt
 * finché la call in agenda è quella a cui il bot l'ha spostata.
 */
export function notaSpostamentoFattoPrompt(i: { callAt: Date }): string {
  const call = `${giornoRoma(i.callAt)} alle ${oraRoma(i.callAt)}`;
  return [
    `SPOSTAMENTO GIÀ FATTO (vale solo per questo lead): su sua richiesta la videochiamata è stata spostata dal sistema ed è registrata in agenda. Adesso è ${call}: è questa la data vera, quella di prima non esiste più.`,
    `Il messaggio "Fatto, la tua videochiamata ora è..." che trovi in chat l'ha mandato il sistema ed è corretto. Non smentirlo, non correggerlo e non scusarti: non dire che lo spostamento non lo puoi fare, che non è valido, che lo deve confermare Noemi, che "per ora resta" l'orario di prima o che passi tu la richiesta a qualcuno. La regola "GIORNO E ORA DI UNA CALL GIÀ FISSATA NON LI SPOSTI TU" qui vuol dire solo che non la sposti un'ALTRA volta.`,
    `Noemi lo chiama prima di ${call} per la conferma di sempre: se ti chiede della call, di Noemi o del video, rispondi sulla data nuova. Un "ok", un "grazie", un "va bene" o una domanda su come funziona la call NON sono una richiesta di spostare: rispondi e basta, senza [ESITO:RICHIAMO].`,
    `Solo se ti chiede lui di cambiare ANCORA giorno o ora: digli che si poteva spostare una volta sola e fai come nella sezione SE VUOLE SPOSTARE O DISDIRE (il nuovo orario lo sistema con Noemi quando lo chiama).`,
  ].join('\n');
}

/** "giovedì 29: la mattina 11:00 o 12:00, ... (già piene: 10:00)" per i giorni dello spostamento. */
export function righeOreMenoPiene(giorni: readonly string[], dati: OreOccupate | null): string | null {
  if (!dati) return null;
  const hh = (h: number) => `${String(h).padStart(2, '0')}:00`;
  const righe = giorni.filter((g) => dati.giorni[g]).map((g) => {
    const conta = dati.giorni[g];
    const fasce = FASCE.map((f) => `${f.nome} ${oreDaProporre(conta, f.ore).map(hh).join(' o ')}`).join(', ');
    const piene = oreAffollate(conta, dati.soglia);
    return `${giornoRoma(new Date(`${g}T12:00:00Z`))}: ${fasce}${piene.length > 0 ? ` (già piene: ${piene.map(hh).join(', ')})` : ''}`;
  });
  return righe.length > 0 ? righe.join('; ') : null;
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
 * - la call in agenda e' proprio quella appena spostata dal bot, e DOPO quello spostamento
 *   il lead non ha chiesto di annullare o di spostare ancora (`testoDopoSpostamento`), oppure
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
  /**
   * I messaggi del lead arrivati DOPO l'ultimo spostamento fatto dal bot e prima di questo
   * turno (chat 32173, 11/11/2026). Il lead, con la call spostata dal bot al giorno dopo,
   * scrive «annulliamo la video di domani»; il bot gli risponde «la annullo io» e mette
   * [ESITO:RICHIAMO] su «La rata finisce a maggio» e sui «Grazie» dopo. La prima regola
   * («la call e' quella appena spostata dal bot») buttava via ogni RICHIAMO: la disdetta
   * non arrivava a `sendOutcome`, `cancel_requested_at` restava vuoto e la mattina dopo e'
   * partito il promemoria della call. Una richiesta di annullare o spostare arrivata dopo
   * lo spostamento e' un fatto nuovo: il RICHIAMO non si butta.
   */
  testoDopoSpostamento?: string;
}): boolean {
  if (i.outcome !== 'RICHIAMO' || i.spostaNelTurno) return false;
  if (i.date && i.date.trim() && !(i.callAt && isoWithOffset(i.date.trim()) && sameInstant(i.date, i.callAt))) return false;
  if (parlaDiDisdireOSpostare(i.testoLead)) return false;
  const callSpostata = !!i.callAt && !!i.spostataDalBotA && sameInstant(i.callAt, i.spostataDalBotA);
  if (callSpostata) return !(i.testoDopoSpostamento && parlaDiDisdireOSpostare(i.testoDopoSpostamento));
  if (i.testoPrima && parlaDiDisdireOSpostare(i.testoPrima)) return false;
  return i.soloPresaDAtto || FRASE_CHE_CONFERMA.test(normalizzaFrase(i.testoLead));
}

// Anche la VSL dell'offerta (funnel Black Friday e lead evergreen dal 10/11/2026).
const LINK_VIDEO_RE = /https?:\/\/(?:corso\.feniceacademy\.it\/conferenza-[A-Za-z0-9_-]+|lp\.feniceacademy\.it\/vsl-offerta[A-Za-z0-9_\/-]*)/g;

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
