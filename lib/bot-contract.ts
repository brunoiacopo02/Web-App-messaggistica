export interface BotIntakePayload {
  leadId: string;
  name: string | null;
  phone: string;
  email: string | null;
  funnel: string | null;
  companyId: string;
}

/** Profilo del lead raccolto dal GDO al telefono: decide quale video mandare. */
export interface GdoVariant {
  lavora: boolean;
  haFamiglia: boolean;
  offertaDelMese: boolean;
}

/** Payload di `POST /api/send-agenda`: come l'intake, più la variante del video. */
export interface SendAgendaPayload extends BotIntakePayload {
  variant: GdoVariant;
}

export type BotOutcome = 'APPUNTAMENTO' | 'DA_SCARTARE' | 'RICHIAMO' | 'NON_RISPOSTO' | 'INTERROTTO' | 'NOTA' | 'CONTATTO_UMANO';

export interface BotReport {
  summary?: string;
  painPoints?: string[];
  budgetSignal?: string;
  urgency?: string;
  objections?: string[];
  levaConsigliata?: string;
}

export interface BotOutcomeBody {
  leadId: string;
  outcome: BotOutcome;
  date?: string;
  /** RICHIAMO senza data certa (contratto v1.5): "a settembre", con le parole del lead.
   *  Sostituisce `date`; mandarne almeno uno dei due o il CRM risponde 400. */
  periodo?: string;
  note?: string;
  discardReason?: string;
  report?: BotReport;
  /** CONTATTO_UMANO (v1.5): categoria della richiesta. Il CRM normalizza e non
   *  restituisce mai 400 su un valore che non riconosce. */
  motivo?: string;
  /** CONTATTO_UMANO (v1.5): quello che sappiamo per far partire la telefonata giusta.
   *  Solo fatti — niente parafrasi del modello. `appuntamento` è la data che il lead ha
   *  già fissato: senza, il CRM instrada la segnalazione al GDO invece che alle
   *  Conferme, che sono le sole competenti su un lead già fissato (13 su 66 finivano
   *  così). Assente, mai null, se non c'è un appuntamento. */
  info?: { sintesi?: string; disponibilita?: string; telefonoPreferito?: string; urgenza?: string; argomenti?: string[]; appuntamento?: string };
}

const OUTCOMES: BotOutcome[] = ['APPUNTAMENTO', 'DA_SCARTARE', 'RICHIAMO', 'NON_RISPOSTO', 'INTERROTTO', 'NOTA', 'CONTATTO_UMANO'];
// CONTATTO_UMANO resta FUORI da DATE_REQUIRED: non è un appuntamento, è una
// segnalazione. Chiedere una data qui rimetterebbe il modello nella condizione di
// inventarne una — il bug chiuso il 06/08 sulle date di RICHIAMO.
const DATE_REQUIRED: BotOutcome[] = ['APPUNTAMENTO', 'RICHIAMO'];

/** True solo se ISO 8601 con offset di fuso (`Z` oppure `±HH:MM`). */
export function isoWithOffset(date: string): boolean {
  if (typeof date !== 'string') return false;
  // Deve avere data+ora e terminare con Z oppure ±HH:MM
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(date)) return false;
  return !Number.isNaN(Date.parse(date));
}

export function parseIntakePayload(
  raw: unknown,
): { ok: true; value: BotIntakePayload } | { ok: false; reason: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'bad_request' };
  const o = raw as Record<string, unknown>;
  const leadId = typeof o.leadId === 'string' ? o.leadId.trim() : '';
  const phone = typeof o.phone === 'string' ? o.phone.trim() : '';
  const companyId = typeof o.companyId === 'string' ? o.companyId : '';
  if (companyId !== 'fenice') return { ok: false, reason: 'forbidden' };
  if (!leadId || !phone) return { ok: false, reason: 'bad_request' };
  return {
    ok: true,
    value: {
      leadId,
      phone,
      companyId,
      name: typeof o.name === 'string' ? o.name : null,
      email: typeof o.email === 'string' ? o.email : null,
      funnel: typeof o.funnel === 'string' ? o.funnel : null,
    },
  };
}

/**
 * Come `parseIntakePayload`, più la variante del video. I flag non booleani non sono
 * un errore: il GDO è al telefono col lead e un `variant` sporco non deve impedire
 * l'invio dell'agenda — al massimo il lead riceve il video di default.
 */
export function parseSendAgendaPayload(
  raw: unknown,
): { ok: true; value: SendAgendaPayload } | { ok: false; reason: string } {
  const base = parseIntakePayload(raw);
  if (!base.ok) return base;
  const v = (raw as Record<string, unknown>).variant;
  const flag = (k: keyof GdoVariant): boolean =>
    !!v && typeof v === 'object' && (v as Record<string, unknown>)[k] === true;
  return {
    ok: true,
    value: {
      ...base.value,
      variant: {
        lavora: flag('lavora'),
        haFamiglia: flag('haFamiglia'),
        offertaDelMese: flag('offertaDelMese'),
      },
    },
  };
}

/** Data e ora della call comunicate dal CRM: primo fissaggio o spostamento. */
export interface AppointmentSetPayload {
  leadId: string;
  /** ISO 8601 con offset esplicito di fuso. */
  appointmentAt: string;
}

// Non abbiamo la loro specifica scritta e le loro chiamate finora morivano in un 404,
// quindi non ne abbiamo nemmeno una da leggere: si accettano gli alias plausibili e il
// route registra il corpo grezzo di tutto il resto. Il primo giorno di traffico vero
// vale piu' di un documento.
const ALIAS_LEAD = ['leadId', 'lead_id', 'crmLeadId', 'crm_lead_id'] as const;
const ALIAS_DATA = [
  'appointmentAt', 'appuntamentoAt', 'appointment_at', 'appuntamento_at',
  'scheduledAt', 'scheduled_at', 'date', 'at',
] as const;

const primaStringa = (o: Record<string, unknown>, chiavi: readonly string[]): string | null => {
  for (const k of chiavi) {
    const v = o[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
};

export type AppointmentSetReason = 'bad_request' | 'lead_mancante' | 'data_mancante' | 'data_senza_offset';

export function parseAppointmentSetPayload(
  raw: unknown,
): { ok: true; value: AppointmentSetPayload } | { ok: false; reason: AppointmentSetReason } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'bad_request' };
  const o = raw as Record<string, unknown>;
  const leadId = primaStringa(o, ALIAS_LEAD);
  if (!leadId) return { ok: false, reason: 'lead_mancante' };
  const data = primaStringa(o, ALIAS_DATA);
  if (!data) return { ok: false, reason: 'data_mancante' };
  // Senza offset non sappiamo se le 18:00 sono italiane o UTC, e un appuntamento
  // sbagliato di due ore in silenzio vale meno di un 400 che si legge subito. E' la
  // stessa regola che il loro endpoint applica alle date che mandiamo noi.
  if (!isoWithOffset(data)) return { ok: false, reason: 'data_senza_offset' };
  return { ok: true, value: { leadId, appointmentAt: data } };
}

export function validateOutcomeBody(
  b: BotOutcomeBody,
): { ok: true } | { ok: false; reason: string } {
  if (!b || typeof b.leadId !== 'string' || !b.leadId.trim()) return { ok: false, reason: 'bad_request' };
  if (!OUTCOMES.includes(b.outcome)) return { ok: false, reason: 'bad_request' };
  if (DATE_REQUIRED.includes(b.outcome)) {
    // Dal contratto v1.5 un RICHIAMO puo' viaggiare con `periodo` al posto di `date`:
    // e' il rimedio all'ora inventata (22 RICHIAMO su 26 cadevano su ore tonde che
    // nessun lead aveva mai detto). L'APPUNTAMENTO no: li' la data serve davvero.
    const periodoOk = b.outcome === 'RICHIAMO' && typeof b.periodo === 'string' && b.periodo.trim() !== '';
    if (!periodoOk && (!b.date || !isoWithOffset(b.date))) return { ok: false, reason: 'bad_request' };
  }
  // La nota È il contenuto per questi due esiti: senza, il CRM risponde 400.
  if ((b.outcome === 'NOTA' || b.outcome === 'CONTATTO_UMANO') && (!b.note || !b.note.trim())) {
    return { ok: false, reason: 'note_required' };
  }
  return { ok: true };
}
