import { decideTrackA, decideTrackB, TRACKB_GIVEUP_H, type MsgLite } from './sequence';
import { lancioInCorso } from './lancio-fase';

const H = 3600_000;

/**
 * Soglia più bassa a cui una classificazione Track A può scattare: è il fast-fail
 * "numero morto" di `decideTrackA` (48h dal primo outbound). Prima di allora leggere
 * la cronologia di quel lead non può produrre niente.
 */
export const TRACKA_MIN_CLASSIFY_H = 48;

/** Lo stretto necessario per decidere, dalla sola riga conversations, se serve leggere i messaggi. */
export type CronConvRow = {
  ai_status: string | null;
  ai_started_at: string | null;
  created_at?: string | null;
  last_message_at: string | null;
  last_inbound_at: string | null;
  bot_outcome: string | null;
  gdo_agenda_at: string | null;
  lancio_slug?: string | null;
  lancio_fase?: string | null;
};

const ms = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
};

/**
 * L'ultimo messaggio della conversazione è un inbound del lead ancora senza risposta?
 *
 * Equivale a `lastIsUnansweredInbound` sulla cronologia — se l'ultima riga è un
 * inbound, esiste un inbound dopo l'ultimo outbound — ma si legge dalle due colonne
 * che `conversations` tiene già aggiornate, senza toccare `messages`.
 */
export function ultimoMessaggioEInbound(c: CronConvRow): boolean {
  return c.last_inbound_at !== null && c.last_message_at === c.last_inbound_at;
}

/**
 * Riferimento "ultima attività" per i watchdog handed_off/booked, senza cronologia.
 *
 * Il cron legge i messaggi dall'arruolamento in poi: quando ce ne sono, l'ultimo è
 * `last_message_at`; quando la conversazione ha solo messaggi anteriori, la finestra è
 * vuota e il riferimento torna a essere `ai_started_at`. Il massimo dei due copre
 * entrambi i casi.
 */
export function ultimaAttivitaMs(c: CronConvRow, nowMs: number): number {
  const candidati = [ms(c.last_message_at), ms(c.ai_started_at)].filter((t): t is number => t !== null);
  return candidati.length ? Math.max(...candidati) : nowMs;
}

/**
 * Serve caricare la cronologia messaggi di questa conversazione?
 *
 * Il cron `bot-followups` la caricava per tutte: 2.310 conversazioni, una query a
 * testa, in sequenza. Dal 02/09/2026 non arrivava più in fondo ai 300s di Vercel, e
 * con lui si sono fermati il follow-up agenda, i watchdog e le restituzioni al CRM.
 * Ma due terzi di quelle righe (1.471 lead dei GDO in modalità postino) venivano
 * scartate subito DOPO la lettura, e quasi tutte le altre erano troppo giovani perché
 * una classificazione potesse scattare.
 *
 * Questo è un pre-filtro, non una decisione: chi passa viene poi giudicato dal codice
 * di sempre sulla cronologia vera. Nel dubbio si carica — un giro sprecato costa una
 * query, un esito mancato costa un lead.
 */
export function serveCronologia(c: CronConvRow, nowMs: number): boolean {
  const guidataDalBot = c.ai_status === 'active' || c.ai_status === 'replying';

  // 1. Re-drive: la rete di sicurezza sul drain. Vale anche per i lead dei GDO e per
  //    le conversazioni già esitate — il bot resta comunque il canale della chat.
  //    Non vale su handed_off/booked: lì risponde una persona.
  if (guidataDalBot && ultimoMessaggioEInbound(c)) return true;

  // 1b. Lancio Web Dev AI in corso: il re-drive sopra vale (il turno lo fa lib/lancio-turno),
  //     ma nessuna classificazione — questi lead escono dal bot solo con le restituzioni
  //     del lancio (B5), mai per silenzio prima dell'8/10 (spec A5).
  if (lancioInCorso(c)) return false;

  // 2. Da qui in poi si decide solo di classificare, e queste tre categorie non si
  //    classificano mai: l'esito del lead di un GDO non è nostro, un esito già dato è
  //    terminale, e i watchdog leggono soltanto l'ultima attività.
  if (c.gdo_agenda_at) return false;
  if (c.bot_outcome) return false;
  if (!guidataDalBot) return false;

  const arruolamento = ms(c.ai_started_at) ?? ms(c.created_at);
  const inbound = ms(c.last_inbound_at);

  // Track B / Track A si separano come nel cron: conta solo l'inbound che cade nella
  // finestra letta, cioè dall'arruolamento in poi (stesso buffer di 5' del cron). Un
  // inbound precedente non rende il lead "uno che ha risposto": per la classificazione
  // resta Track A, con la sua soglia più bassa.
  const inboundDopoArruolamento =
    inbound !== null && (arruolamento === null || inbound >= arruolamento - 5 * 60_000);

  if (inboundDopoArruolamento) return nowMs - inbound >= TRACKB_GIVEUP_H * H;
  if (arruolamento === null) return true;
  return nowMs - arruolamento >= TRACKA_MIN_CLASSIFY_H * H;
}

// Il cron bot-followups fa SOLO le classificazioni finali verso il CRM:
// gli invii (aperture, touch, nudge) sono compito del cron sequence-touches.
// `mai_consegnato` si chiamava `discard_dead`: fino al 25/09/2026 finiva in un
// DA_SCARTARE "numero inesistente" (vedi `esitoMaiConsegnato` in fondo al file).
export type FollowupAction = 'non_risposto' | 'mai_consegnato' | 'interrotto_classify' | 'none';

/**
 * Decide la classificazione finale per un lead CRM. Pura: delega a
 * decideTrackA/decideTrackB e mappa i soli kind di classificazione;
 * ogni kind di invio o attesa diventa 'none'.
 * Le classificazioni scattano anche a kill-switch spento (garantito da lib/sequence).
 */
export function decideFollowupAction(input: {
  nowMs: number;
  msgs: MsgLite[];
  seqSids: string[];
  hasInbound: boolean;
  lastInboundAtMs: number | null;
  /** Esito CRM già registrato. Qualunque esito è terminale: mai riclassificare. */
  botOutcome?: string | null;
  /** Kill-switch invii (SEQUENCE_ENABLED). Irrilevante per le classificazioni. */
  sequenceEnabled?: boolean;
  /** conversations.bot_followups_sent (contatore nudge Track B). */
  nudgesSent?: number;
  /** Lead di proprietà di un GDO (`gdo_agenda_at`): il bot fa solo da canale. */
  gdoPostino?: boolean;
  /** Chat del lancio con fase non terminale: mai classificare. */
  lancio?: boolean;
}): FollowupAction {
  // Chat del lancio Web Dev AI: l'esito lo decide il flusso del lancio (B5). Una
  // classificazione di Mario qui restituirebbe al CRM un lead che sta aspettando il 5/10.
  if (input.lancio === true) return 'none';

  // Lead del GDO: l'esito non è nostro da decidere. Una classificazione automatica
  // arriverebbe al CRM come esito su un lead che sta lavorando un commerciale.
  if (input.gdoPostino === true) return 'none';

  // Un esito è già stato dato: mai riclassificare, qualunque esso sia. La guardia
  // copriva solo APPUNTAMENTO, ma una riga riaperta dal webhook che porta ancora il suo
  // esito rispedisce lo stesso POST a ogni giro del cron — il 07/08 erano 21
  // conversazioni 'active' con un esito già registrato (11 INTERROTTO, 8 NON_RISPOSTO,
  // 2 RICHIAMO).
  if (input.botOutcome) return 'none';

  if (input.hasInbound && input.lastInboundAtMs !== null) {
    // Track B: ha risposto poi silenzio.
    const b = decideTrackB({
      nowMs: input.nowMs,
      lastInboundAtMs: input.lastInboundAtMs,
      nudgesSent: input.nudgesSent ?? 0,
      sequenceEnabled: input.sequenceEnabled ?? false,
    });
    return b.kind === 'classify' ? 'interrotto_classify' : 'none';
  }

  // Track A: mai risposto.
  const a = decideTrackA({
    nowMs: input.nowMs,
    msgs: input.msgs,
    seqSids: input.seqSids,
    sequenceEnabled: input.sequenceEnabled ?? false,
  });
  if (a.kind === 'discard_dead') return 'mai_consegnato';
  if (a.kind === 'non_risposto') return 'non_risposto';
  return 'none';
}

/** Un messaggio con il codice d'errore Twilio: serve solo a scrivere la nota giusta. */
export type MsgConErrore = MsgLite & { twilio_error_code?: number | null };

/** Twilio 63024: "invalid message recipient" — il destinatario non ha WhatsApp. */
const TWILIO_SENZA_WHATSAPP = 63024;

/**
 * L'esito per un lead a cui WhatsApp non ha consegnato NIENTE (Track A, `mai_consegnato`).
 *
 * Fino al 25/09/2026 partiva un `DA_SCARTARE` con motivo "numero inesistente" e il lead
 * usciva dal circuito. Ma quasi sempre il numero esiste: semplicemente non ha WhatsApp
 * (errore Twilio 63024 in ~9 casi su 10 a settembre), e al telefono può rispondere. Fra
 * gli "inesistenti" c'erano perfino fissi italiani scritti senza lo 0 iniziale
 * (+39 965..., +39 661...). Decisione del PO: mai scartarli, vanno ai GDO da chiamare.
 *
 * `NON_RISPOSTO` è l'esito del contratto che fa esattamente questo, senza toccare il
 * CRM: `/api/bot/outcome` lo passa a `reassignBotLeadToHumanPool(leadId, 'mai_risposto')`
 * (round robin dei ridati, lead di nuovo NEW con callCount 0). Sui lead del lancio va nel
 * pool di /import con motivo `mai_risposto`: per questo la nota non deve contenere
 * "follow-up", che il CRM leggerebbe come un altro motivo.
 *
 * Nessun filtro per i numeri "palesemente falsi" (1111111111, 3400000000...): a
 * settembre erano ~6 su 562, e ogni regola provata prendeva anche numeri veri. Un GDO
 * che lo scopre con una telefonata costa meno di un lead buono buttato.
 */
export function esitoMaiConsegnato(msgs: MsgConErrore[]): { outcome: 'NON_RISPOSTO'; note: string } {
  const uscite = msgs.filter((m) => m.direction === 'out');
  const n = uscite.length;
  const quanti = `${n} ${n === 1 ? 'messaggio' : 'messaggi'}`;
  const senzaWhatsApp = uscite.some((m) => m.twilio_error_code === TWILIO_SENZA_WHATSAPP);
  const note = senzaWhatsApp
    ? `WhatsApp mai consegnato (numero senza WhatsApp, errore Twilio 63024: ${quanti} inviati, nessuno arrivato). Il numero può essere valido: chiamare a voce.`
    : `WhatsApp mai consegnato (${quanti} inviati, nessuno arrivato). Il numero può essere valido: chiamare a voce.`;
  return { outcome: 'NON_RISPOSTO', note };
}
