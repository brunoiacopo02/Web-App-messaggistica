// Cosa succede al lead DOPO che il bot ha fissato l'appuntamento.
//
// Fino al 26/08/2026 il nostro database si fermava al fissaggio: l'unica cosa che il bot
// poteva ottimizzare era il NUMERO di appuntamenti, e lo si poteva far crescere
// peggiorando il risultato senza che nessuno se ne accorgesse. Il CRM ha aperto
// `POST /api/bot/lead-status` (contratto v1.5, Direzione 5): un canale in lettura, a
// pull, che risponde a "cosa e' cambiato da questo istante".
//
// Qui c'e' solo la logica pura — validare la pagina, mappare le colonne, decidere il
// cursore. La rete e il database stanno in `app/api/cron/crm-lead-status`.

/** Una riga di stato come la manda il CRM. Tutto opzionale tranne le due chiavi. */
export type CrmLeadStatus = {
  leadId: string;
  updatedAt: string;
  status?: string | null;
  appointmentDate?: string | null;
  appointmentCreatedAt?: string | null;
  confermeOutcome?: string | null;
  confermeOutcomeAt?: string | null;
  confermeDiscardReason?: string | null;
  presented?: boolean | null;
  presentedAt?: string | null;
  salesOutcome?: string | null;
  salesOutcomeAt?: string | null;
  sold?: boolean | null;
  soldProduct?: string | null;
  soldAmountEur?: number | string | null;
  discardReason?: string | null;
  agendaStatus?: string | null;
};

export type LeadStatusPage = {
  leads: CrmLeadStatus[];
  nextSince: string | null;
  hasMore: boolean;
  /** Righe buttate perche' senza `leadId` o senza `updatedAt`. Vanno loggate, non ignorate. */
  scartate: number;
};

export type CrmLeadStatusRow = {
  lead_id: string;
  conversation_id: number | null;
  status: string | null;
  appointment_date: string | null;
  appointment_created_at: string | null;
  conferme_outcome: string | null;
  conferme_outcome_at: string | null;
  conferme_discard_reason: string | null;
  presented: boolean;
  presented_at: string | null;
  sales_outcome: string | null;
  sales_outcome_at: string | null;
  sold: boolean;
  sold_product: string | null;
  sold_amount_eur: number | null;
  discard_reason: string | null;
  agenda_status: string | null;
  crm_updated_at: string;
  synced_at: string;
};

const testo = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
const flag = (v: unknown): boolean => v === true;

/** Un importo puo' arrivare come numero o come stringa. Quello che non e' un numero
 *  diventa `null`: un `NaN` in colonna numerica fa fallire l'intero upsert della pagina. */
function importo(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Valida la pagina ricevuta. Una riga malformata non fa cadere le altre: se il CRM
 * cambia un campo, si perde quella riga e non l'intero giro di sincronizzazione.
 */
export function parseLeadStatusPage(
  json: unknown,
): { ok: true; page: LeadStatusPage } | { ok: false; reason: string } {
  if (!json || typeof json !== 'object') return { ok: false, reason: 'body_non_oggetto' };
  const raw = json as Record<string, unknown>;
  if (!Array.isArray(raw.leads)) return { ok: false, reason: 'leads_mancante' };

  const leads: CrmLeadStatus[] = [];
  let scartate = 0;
  for (const item of raw.leads) {
    if (!item || typeof item !== 'object') { scartate++; continue; }
    const l = item as Record<string, unknown>;
    const leadId = testo(l.leadId);
    const updatedAt = testo(l.updatedAt);
    // Senza `updatedAt` la riga non e' collocabile nell'ordine e il cursore non puo'
    // avanzare oltre di lei: tenerla significherebbe rileggerla per sempre.
    if (!leadId || !updatedAt) { scartate++; continue; }
    leads.push({ ...(l as CrmLeadStatus), leadId, updatedAt });
  }

  // `nextSince` e' l'updatedAt dell'ultima riga servita, non "adesso". Se il CRM non lo
  // manda lo ricaviamo noi dal massimo della pagina: ripartire da adesso salterebbe
  // tutto cio' che cambia mentre si scorrono le pagine.
  const nextSince = testo(raw.nextSince)
    ?? leads.reduce<string | null>((max, l) => (max === null || l.updatedAt > max ? l.updatedAt : max), null);

  return { ok: true, page: { leads, nextSince, hasMore: raw.hasMore === true, scartate } };
}

/** Dal payload del CRM alle colonne di `crm_lead_status`. */
export function toRow(lead: CrmLeadStatus, conversationId: number | null): CrmLeadStatusRow {
  return {
    lead_id: lead.leadId,
    conversation_id: conversationId,
    status: testo(lead.status),
    appointment_date: testo(lead.appointmentDate),
    appointment_created_at: testo(lead.appointmentCreatedAt),
    conferme_outcome: testo(lead.confermeOutcome),
    conferme_outcome_at: testo(lead.confermeOutcomeAt),
    conferme_discard_reason: testo(lead.confermeDiscardReason),
    presented: flag(lead.presented),
    presented_at: testo(lead.presentedAt),
    sales_outcome: testo(lead.salesOutcome),
    sales_outcome_at: testo(lead.salesOutcomeAt),
    sold: flag(lead.sold),
    sold_product: testo(lead.soldProduct),
    sold_amount_eur: importo(lead.soldAmountEur),
    discard_reason: testo(lead.discardReason),
    agenda_status: testo(lead.agendaStatus),
    crm_updated_at: lead.updatedAt,
    synced_at: new Date().toISOString(),
  };
}

type Latchabile = { presented: boolean; presented_at: string | null; sold: boolean };

/**
 * Presenza e vendita non tornano indietro. Il CRM dice di latchare `presented` da parte
 * sua, ma la riga e' uno stato corrente che riscriviamo per intero: se una correzione a
 * monte la rimettesse a falsa, cancelleremmo una presenza davvero avvenuta e le nostre
 * statistiche cambierebbero retroattivamente.
 */
export function mergeLatched<T extends Latchabile>(esistente: Latchabile | null, row: T): T {
  if (!esistente) return row;
  return {
    ...row,
    presented: esistente.presented || row.presented,
    presented_at: row.presented_at ?? (esistente.presented ? esistente.presented_at : null),
    sold: esistente.sold || row.sold,
  };
}

/**
 * Dove riparte il giro. Un cursore che non avanza (stesso istante, o piu' indietro di
 * dove siamo) chiude il giro invece di rileggere la stessa pagina all'infinito: succede
 * quando piu' righe del `limit` condividono lo stesso `updatedAt`.
 */
export function prossimoCursore(
  corrente: string,
  page: LeadStatusPage,
): { since: string; continua: boolean; bloccato: boolean } {
  if (page.leads.length === 0 || !page.nextSince) {
    return { since: corrente, continua: false, bloccato: false };
  }
  if (page.nextSince <= corrente) {
    return { since: corrente, continua: false, bloccato: true };
  }
  return { since: page.nextSince, continua: page.hasMore, bloccato: false };
}
