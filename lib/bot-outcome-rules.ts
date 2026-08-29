import type { BotOutcome } from './bot-contract';
import { formatRomeDateTime, romeDayKey, romeHour, sameInstant } from './rome-time';
import { isBookableDate, type BlackoutRange } from './booking-blackout';

export type OutcomeArgs = {
  outcome: BotOutcome;
  date?: string;
  note?: string;
  discardReason?: string;
  /** L'ultimo messaggio del lead, testuale. Il "motivo" che il modello produce è una
   *  sintesi: le Conferme hanno chiesto anche le parole vere, per non scoprire al
   *  telefono che la disdetta diceva un'altra cosa. */
  leadWords?: string;
};

export type OutcomeAction =
  | { kind: 'normal' }
  | { kind: 'locked'; outcome: 'NOTA'; note: string; date: null }
  /** Il lead ha chiesto di spostare e ha detto quando: si rifissa (contratto v1.5). */
  | { kind: 'reschedule'; outcome: 'APPUNTAMENTO'; date: string };

/**
 * Costruisce la nota da inviare al CRM quando un lead GIÀ fissato genera un esito
 * successivo. L'esito non declassa: viene tradotto in una nota informativa.
 */
export function buildLockedNote(args: OutcomeArgs, existingDate: string | null): string {
  const inAgenda = existingDate ? formatRomeDateTime(existingDate) : null;
  // Le parole del lead sono la cosa che il CRM ci ha chiesto e che mancava: il "motivo"
  // che mandavamo era la sintesi del modello, cioè una parafrasi. Restano entrambi —
  // la sintesi orienta, la citazione è la prova.
  const parole = paroleDelLead(args.leadWords);
  const citazione = parole ? ` Parole del lead: "${parole}".` : '';
  const extra = args.note && args.note.trim() ? ` ${args.note.trim()}` : '';
  let base: string;
  switch (args.outcome) {
    case 'DA_SCARTARE': {
      // Se disdice, QUANDO: senza la data le Conferme non sanno quale appuntamento
      // stanno per perdere. Quando non ce l'abbiamo lo si dice, invece di tacere.
      const quando = inAgenda ? `appuntamento di ${inAgenda} da annullare` : `appuntamento da annullare (data non nota da noi)`;
      base = `DISDETTA — ${quando}. Motivo: ${args.discardReason?.trim() || 'non specificato'}.`;
      break;
    }
    case 'INTERROTTO':
      base = `CHAT INTERROTTA — il lead ha smesso di rispondere dopo il fissaggio.` +
        ` Appuntamento mantenuto${inAgenda ? `: ${inAgenda}` : ''}.`;
      break;
    case 'RICHIAMO': {
      // RICHIAMO qui significa "il lead vuole spostare l'appuntamento già fissato".
      // Il prompt, quando il lead non indica una data, mette nel tag la data
      // dell'appuntamento stesso come fallback: se la riportassimo sempre come "data
      // indicata dal lead" le Conferme leggerebbero una richiesta di spostamento verso
      // la data già in agenda, che non ha senso. La mostriamo come "data indicata"
      // solo quando è davvero un istante diverso da quello in agenda: un confronto
      // testuale fallirebbe qui, perché existingDate arriva da Postgres normalizzato in
      // UTC mentre args.date arriva dal tag del modello nel fuso locale imposto dal
      // prompt, quindi lo stesso istante avrebbe quasi sempre due stringhe diverse.
      const leadDate = args.date && !sameInstant(args.date, existingDate) ? args.date : null;
      const datePart = leadDate ? ` alla data indicata (${formatRomeDateTime(leadDate)})` : ' (nessuna nuova data indicata dal lead)';
      // "Mantenuto" da solo si legge come "tutto a posto". Chi legge deve sapere che
      // l'appuntamento è ancora lì perché noi non lo spostiamo, e che tocca a loro.
      const kept = inAgenda
        ? `In agenda resta ${inAgenda}: mantenuto finché non lo spostate voi.`
        : 'Appuntamento mantenuto: da spostare voi.';
      base = `SPOSTAMENTO CHIESTO — il lead ha chiesto di spostare l'appuntamento${datePart}. ${kept}`;
      break;
    }
    case 'NON_RISPOSTO':
      base = `NESSUNA RISPOSTA — nessun riscontro dopo il fissaggio.` +
        ` Appuntamento mantenuto${inAgenda ? `: ${inAgenda}` : ''}.`;
      break;
    case 'APPUNTAMENTO':
      if (args.date && existingDate && !sameInstant(args.date, existingDate)) {
        base = `SPOSTAMENTO CHIESTO — il lead ha chiesto di spostare a ${formatRomeDateTime(args.date)}.` +
          ` In agenda resta ${formatRomeDateTime(existingDate)}: mantenuto finché non lo spostate voi.`;
      } else {
        base = `RICONFERMA — il lead ha riconfermato l'appuntamento${inAgenda ? ` di ${inAgenda}` : ''}.`;
      }
      break;
    case 'NOTA':
    case 'CONTATTO_UMANO':
      // Non arrivano mai qui come esito IN INGRESSO: sono i due esiti prodotti in
      // USCITA (NOTA dal ramo locked di resolveOutcomeAction, CONTATTO_UMANO da
      // sendOutcome, che lo intercetta prima). Il caso resta per l'esaustività dello
      // switch: senza, TypeScript vede `base` potenzialmente non assegnata.
      base = `AGGIORNAMENTO — appuntamento mantenuto${inAgenda ? `: ${inAgenda}` : ''}.`;
      break;
  }
  return `${base}${extra}${citazione}`.trim();
}

/**
 * Decide cosa fare con un esito in arrivo dato l'esito corrente della conversazione.
 * Se la conversazione è già APPUNTAMENTO l'esito è terminale: 'locked' (nota, niente
 * declassamento). Altrimenti 'normal' (comportamento standard).
 */
export function resolveOutcomeAction(
  current: BotOutcome | null,
  args: OutcomeArgs,
  existingDate: string | null,
): OutcomeAction {
  if (current === 'APPUNTAMENTO') {
    // Dal 26/08/2026 il CRM sa registrare uno spostamento: stesso lead, data diversa,
    // e rispondono `rescheduled`. Prima lo scartavano in silenzio, quindi noi lo
    // traducevamo in una nota e al lead il bot diceva "ti ricontatta una collega" —
    // un vicolo cieco su una persona che stava chiedendo di esserci.
    // Serve una data NUOVA e un appuntamento gia' in agenda da cui spostarsi: senza,
    // e' una riconferma e resta bloccata come prima.
    if (
      args.outcome === 'APPUNTAMENTO' &&
      args.date &&
      existingDate &&
      !sameInstant(args.date, existingDate)
    ) {
      return { kind: 'reschedule', outcome: 'APPUNTAMENTO', date: args.date };
    }
    return { kind: 'locked', outcome: 'NOTA', note: buildLockedNote(args, existingDate), date: null };
  }
  return { kind: 'normal' };
}

/**
 * Oltre questo orizzonte una data di richiamo non è più un appuntamento telefonico: è
 * un numero che il modello ha tirato fuori da "più avanti". ~6 mesi.
 */
export const RICHIAMO_ORIZZONTE_MS = 183 * 24 * 3600_000;

export type MotivoDataNonUsabile = 'assente' | 'illeggibile' | 'passato' | 'oltre_orizzonte';
export type RichiamoCheck = { ok: true } | { ok: false; motivo: MotivoDataNonUsabile };

/**
 * La data di un RICHIAMO è utilizzabile? `isoWithOffset` valida il FORMATO; qui si
 * guarda la plausibilità, che è la cosa che mancava: una data nel passato o a due anni
 * da oggi passa il formato e finisce in agenda a un commerciale.
 */
export function checkDataRichiamo(date: string | undefined, nowMs: number): RichiamoCheck {
  if (!date || !date.trim()) return { ok: false, motivo: 'assente' };
  const t = Date.parse(date);
  if (Number.isNaN(t)) return { ok: false, motivo: 'illeggibile' };
  if (t < nowMs) return { ok: false, motivo: 'passato' };
  if (t - nowMs > RICHIAMO_ORIZZONTE_MS) return { ok: false, motivo: 'oltre_orizzonte' };
  return { ok: true };
}

/** Fascia in cui Fenice fissa le call, ora di Roma, estremi inclusi (l'ultimo slot è
 *  alle 21:00). Sta scritta anche nel prompt, in `bookingSlotsContext`. */
export const APPUNTAMENTO_ORA_MIN = 9;
export const APPUNTAMENTO_ORA_MAX = 21;

export type MotivoAppuntamentoNonFissabile =
  | 'assente'
  | 'illeggibile'
  | 'passato'
  | 'domenica'
  | 'giorno_chiuso'
  | 'fuori_fascia';
export type AppuntamentoCheck = { ok: true } | { ok: false; motivo: MotivoAppuntamentoNonFissabile };

/**
 * La data di un APPUNTAMENTO è fissabile davvero?
 *
 * Le regole su giorni e orari vivevano solo nel prompt, dentro `bookingSlotsContext`:
 * valevano finché era il bot a proporre il giorno, e cadevano appena era il lead a
 * proporlo. Il 24/08/2026, sui dati: 27 call finite dentro la chiusura di ferragosto
 * (15 fissate a blocco già attivo) e 3 a mezzanotte. Una call in un giorno o a un'ora
 * in cui non c'è nessuno arriva alle Conferme e al venditore come se fosse vera.
 *
 * Il giorno e l'ora si leggono SEMPRE in ora di Roma: un tag "T22:00" senza offset è
 * mezzanotte italiana, non le 22.
 */
export function checkDataAppuntamento(
  date: string | undefined,
  nowMs: number,
  ranges: BlackoutRange[],
): AppuntamentoCheck {
  if (!date || !date.trim()) return { ok: false, motivo: 'assente' };
  const t = Date.parse(date);
  if (Number.isNaN(t)) return { ok: false, motivo: 'illeggibile' };
  if (t < nowMs) return { ok: false, motivo: 'passato' };

  const quando = new Date(t);
  const giorno = romeDayKey(quando);
  // romeDayKey dà 'YYYY-MM-DD' del giorno italiano: parsarlo a mezzogiorno UTC evita
  // che il giorno della settimana slitti col fuso.
  if (new Date(`${giorno}T12:00:00Z`).getUTCDay() === 0) return { ok: false, motivo: 'domenica' };
  if (!isBookableDate(giorno, ranges)) return { ok: false, motivo: 'giorno_chiuso' };

  const ora = romeHour(quando);
  if (ora < APPUNTAMENTO_ORA_MIN || ora > APPUNTAMENTO_ORA_MAX) return { ok: false, motivo: 'fuori_fascia' };
  return { ok: true };
}

const DETTAGLIO_APPUNTAMENTO: Record<MotivoAppuntamentoNonFissabile, string> = {
  assente: 'il tag non portava nessuna data',
  illeggibile: 'la data non era leggibile',
  passato: 'la data era già passata',
  domenica: 'cadeva di domenica, quando non fissiamo',
  giorno_chiuso: 'cadeva in un giorno di chiusura',
  fuori_fascia: `era fuori dalla fascia ${APPUNTAMENTO_ORA_MIN}:00-${APPUNTAMENTO_ORA_MAX}:00`,
};

/**
 * La nota che parte al posto dell'appuntamento scartato. Deve dire in testa che
 * l'appuntamento NON c'è: se le Conferme leggessero "appuntamento" chiamerebbero un
 * lead che non aspetta nessuna call.
 */
export function buildAppuntamentoNonFissabileNote(input: {
  motivo: MotivoAppuntamentoNonFissabile;
  dataScartata?: string;
  leadWords?: string;
}): string {
  const parole = paroleDelLead(input.leadWords);
  const citazione = parole ? ` Parole del lead: "${parole}".` : '';
  const quando =
    input.dataScartata && !Number.isNaN(Date.parse(input.dataScartata))
      ? ` (${formatRomeDateTime(input.dataScartata)})`
      : '';
  // Il modello, quando emette il tag, ha già detto al lead che la call è presa: la
  // guardia ferma la scrittura, non la frase già mandata in chat. La nota deve dirlo,
  // altrimenti chi legge crede che il lead sia solo da richiamare.
  return (
    `APPUNTAMENTO NON FISSATO — il bot stava per fissare una call${quando} ma ` +
    `${DETTAGLIO_APPUNTAMENTO[input.motivo]}: in agenda non c'è niente. Il lead ` +
    `potrebbe aver ricevuto una conferma in chat: va ricontattato per concordare ` +
    `giorno e ora.${citazione}`
  );
}

const DETTAGLIO_MOTIVO: Record<MotivoDataNonUsabile, string> = {
  assente: 'ma non ha indicato quando',
  illeggibile: 'ma non ha indicato quando in modo utilizzabile',
  passato: 'ma la data raccolta è nel passato e non è utilizzabile',
  oltre_orizzonte: 'ma la data raccolta è troppo lontana per essere quella vera',
};

/** Oltre questa lunghezza una citazione smette di essere leggibile al volo. */
const MAX_PAROLE_LEAD = 400;

/**
 * Le parole del lead pronte per una nota: a-capo e spazi doppi via, taglio su confine
 * di parola. Le note le leggono le Conferme pochi minuti prima di chiamare il cliente,
 * quindi devono stare su una riga e finire dove finisce un pensiero.
 */
export function paroleDelLead(testo: string | undefined, max = MAX_PAROLE_LEAD): string | null {
  const pulito = (testo ?? '').replace(/\s+/g, ' ').trim();
  if (!pulito) return null;
  if (pulito.length <= max) return pulito;
  const tagliato = pulito.slice(0, max);
  const ultimoSpazio = tagliato.lastIndexOf(' ');
  const base = ultimoSpazio > max * 0.6 ? tagliato.slice(0, ultimoSpazio) : tagliato;
  return `${base.trimEnd()}…`;
}

/**
 * La nota del CONTATTO_UMANO. Il CRM la mostra alle Conferme: il fatto in testa, poi
 * le parole del lead. La richiesta non si parafrasa mai — "vuole assistenza" e "voglio
 * disdire e parlare con un responsabile" non sono la stessa cosa, e chi chiama deve
 * sapere quale delle due ha davanti.
 */
export function buildContattoUmanoNote(input: { leadWords?: string; motivo?: string }): string {
  const parole = paroleDelLead(input.leadWords);
  const motivo = input.motivo?.replace(/\s+/g, ' ').trim();
  const coda = parole
    ? ` Parole del lead: "${parole}".`
    : ' Il lead ha chiesto esplicitamente di parlare con una persona.';
  const contesto = motivo ? ` Contesto: ${motivo}.` : '';
  return `RICHIESTA DI PARLARE CON UNA PERSONA — il bot si è fatto da parte.${coda}${contesto}`;
}

/**
 * Scrive su WhatsApp qualcuno che alla call c'è già andato, o che ha già comprato. Il bot
 * si toglie di mezzo — non è una conversazione da prequalifica — ma il silenzio sarebbe
 * peggio: quella persona ha scritto e merita una risposta da chi la segue davvero.
 */
export function buildScriveDopoLaCallNote(input: { leadWords?: string; cliente: boolean }): string {
  const parole = paroleDelLead(input.leadWords);
  const chi = input.cliente
    ? 'UN CLIENTE HA SCRITTO IN CHAT'
    : 'HA SCRITTO CHI SI È GIÀ PRESENTATO ALLA CALL';
  const coda = parole ? ` Parole del lead: "${parole}".` : '';
  return (
    `${chi} — il bot si è tolto di mezzo perché non è una conversazione da prequalifica, ` +
    'e la chat aspetta una persona.' + coda
  );
}

/**
 * Il lead aveva detto sì a un giorno e un'ora — o aveva compilato il form — e
 * l'appuntamento al CRM non è mai arrivato. Fino al 29/08/2026 una chat così tornava
 * indietro come "interrotta" e basta: in agosto è successo 49 volte, e su una di quelle
 * (Giulia, «si esatto confermo mercoledì 19 alle 12») il sì era nero su bianco.
 *
 * La nota dice il fatto e riporta le parole, perché chi legge decida se telefonare: non
 * fissa niente da sola, e la chat resta restituita come prima.
 */
export function buildConfermaPersaNote(input: { leadWords?: string; stage?: string }): string {
  const parole = paroleDelLead(input.leadWords);
  const dove = input.stage?.replace(/\s+/g, ' ').trim();
  const coda = parole ? ` Parole del lead: "${parole}".` : '';
  const contesto = dove ? ` La chat si è fermata ${dove}.` : '';
  return (
    "AVEVA CONFERMATO E L'APPUNTAMENTO NON C'È — il lead ha detto sì a un giorno e un'ora " +
    '(o ha completato il form) ma da noi non è mai partito nessun appuntamento, quindi ' +
    'in agenda non esiste.' + coda + contesto + " Vale una telefonata: il sì c'era già."
  );
}

/**
 * La nota di chi ha risposto DOPO il terzo tentativo di chiamata. È un caso diverso dal
 * `CONTATTO_UMANO` normale e la nota deve dirlo: il bot non si è fatto da parte, e
 * soprattutto dall'altra parte quel lead è già stato scartato in automatico dal terzo
 * NR. Chi legge deve capire in una riga che c'è un lead da RIAPRIRE, non da richiamare
 * come tutti gli altri.
 */
export function buildRispostaPostNrNote(input: { leadWords?: string; quandoNrIso: string }): string {
  const parole = paroleDelLead(input.leadWords);
  const coda = parole ? ` Parole del lead: "${parole}".` : '';
  return (
    'IL LEAD HA RISPOSTO DOPO IL TERZO TENTATIVO DI CHIAMATA — gli avevamo scritto ' +
    `${formatRomeDateTime(input.quandoNrIso)} dicendogli che senza una risposta ` +
    "l'appuntamento sarebbe stato annullato, e lui ha risposto." +
    `${coda} Da riaprire dalle Conferme: l'appuntamento è ancora recuperabile.`
  );
}

/**
 * Il lead era già stato restituito al CRM e ha riscritto. Da qui in poi due canali
 * lavorano la stessa persona senza vedersi, ed è esattamente com'è andata a Marina
 * Destefanis: restituita il 26/07, riassegnata a un GDO che l'ha chiamata tre volte e
 * poi scartata, mentre il giorno dopo il bot le fissava l'appuntamento. La nota serve a
 * fermare quella telefonata, quindi lo dice in chiaro.
 */
export function buildBotRipresoNote(input: { esitoPrecedente: string; quandoIso: string }): string {
  return (
    `IL BOT HA RIPRESO LA CHAT — il lead ha riscritto ${formatRomeDateTime(input.quandoIso)}, ` +
    `dopo che ve lo avevamo restituito come ${input.esitoPrecedente}. ` +
    `Non chiamatelo a mano finché non vi arriva un nuovo esito dal bot.`
  );
}

/**
 * La nota che parte al posto di un RICHIAMO con una data che non ci fidiamo a mandare.
 * Nessuna data dentro, di proposito: si riportano le parole del lead e si dice
 * esplicitamente che giorno e ora sono da concordare. La data scartata viaggia
 * nell'event_log, dove serve a noi e non confonde il commerciale.
 */
export function buildRichiamoSenzaDataNote(input: {
  motivo: MotivoDataNonUsabile;
  leadWords?: string;
}): string {
  const parole = paroleDelLead(input.leadWords);
  const citazione = parole ? ` Parole del lead: "${parole}".` : '';
  return (
    `DA RICHIAMARE — giorno e ora da concordare: il lead ha chiesto di essere ` +
    `ricontattato ${DETTAGLIO_MOTIVO[input.motivo]}.${citazione}`
  );
}

/**
 * Questo esito, su un lead con l'appuntamento GIÀ fissato, è una richiesta di
 * disdetta o di spostamento? Serve a spegnere gli automatismi (promemoria, solleciti)
 * senza toccare `bot_outcome`, che resta terminale.
 * INTERROTTO e NON_RISPOSTO no: lì il lead non ha chiesto niente, è sparito.
 */
export function isRichiestaDisdetta(outcome: BotOutcome): boolean {
  return outcome === 'DA_SCARTARE' || outcome === 'RICHIAMO';
}
