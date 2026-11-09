/**
 * Statistiche del Black Friday per il monitor del CRM (PO 09/11/2026).
 *
 * Il CRM manda i suoi lead BF (id, istante di ingresso, telefono per il ripiego)
 * e qui si dice, per ciascuno, cosa e' successo nella chat del bot; in piu' il
 * riepilogo delle chat nate da una data, per funnel. Funzioni pure: le letture
 * stanno nella route `/api/bot/statistiche-bf`.
 *
 * Definizioni (identiche al report delle 14:57 del 09/11):
 *  - conversazione del lead: prima per `crm_lead_id`, poi per telefono; se ce ne
 *    sono piu' di una vale quella con l'ultimo messaggio piu' recente;
 *  - con chat: almeno un messaggio in uscita da 2 minuti prima dell'ingresso in poi;
 *  - consegnato: almeno un messaggio in uscita dopo l'ingresso con stato Twilio
 *    `delivered` o `read`;
 *  - risposto: almeno un messaggio in ingresso dopo l'ingresso;
 *  - nuova / gia' nota: la chat esisteva gia' piu' di 10 minuti prima dell'ingresso = nota;
 *  - esito: `bot_outcome` solo se scritto dopo l'ingresso, altrimenti null.
 * Riepilogo per funnel: chat create dalla data, raggruppate per `crm_funnel`
 * attuale; risposto = almeno un messaggio in ingresso (`last_inbound_at`, che
 * coincide con l'esistenza di un messaggio `in`: verificato su 610 chat il 09/11);
 * appuntamento = `bot_outcome` APPUNTAMENTO; eta' dalla creazione della chat.
 * Nessun testo di messaggio esce di qui.
 */

export const MARGINE_CHAT_MS = 2 * 60_000;
export const SOGLIA_NOTA_MS = 10 * 60_000;
const ORA_MS = 3_600_000;
const CONSEGNATI = new Set(['delivered', 'read']);

export interface LeadRichiesto {
  id: string;
  /** ISO: ingresso del lead nel CRM (createdAt). */
  ingresso: string;
  /** Solo per il ripiego quando nessuna chat porta il crm_lead_id. */
  telefono?: string | null;
}

export interface ConvRiga {
  id: number;
  crm_lead_id: string | null;
  lead_id: number | null;
  created_at: string;
  last_message_at: string | null;
  wa_number: string | null;
  mario_braccio: string | null;
  bot_outcome: string | null;
  bot_outcome_at: string | null;
  ai_status: string | null;
}

export interface MsgRiga {
  conversation_id: number;
  direction: string;
  twilio_status: string | null;
  created_at: string;
}

export interface StatoLeadBf {
  crm_lead_id: string;
  conversation_id: number | null;
  trovata_per: 'crm_lead_id' | 'telefono' | null;
  /** true = chat nata con il BF; false = gia' nota al bot; null = nessuna chat. */
  chat_nuova: boolean | null;
  con_chat: boolean;
  consegnato: boolean;
  risposto: boolean;
  wa_number: string | null;
  mario_braccio: string | null;
  /** bot_outcome scritto dopo l'ingresso BF, altrimenti null. */
  bot_outcome: string | null;
  ai_status: string | null;
  eta_ore: number;
}

export interface RigaFunnelBot {
  funnel: string;
  chat: number;
  risposto: number;
  appuntamenti: number;
  eta_media_ore: number | null;
  esiti: Record<string, number>;
}

const ms = (iso: string | null | undefined) => (iso ? Date.parse(iso) : NaN);

/** La conversazione da usare fra piu' candidate: ultimo messaggio piu' recente, poi id piu' alto. */
export function convPrincipale(convs: ConvRiga[]): ConvRiga | null {
  if (convs.length === 0) return null;
  return [...convs].sort(
    (a, b) => (ms(b.last_message_at) || 0) - (ms(a.last_message_at) || 0) || b.id - a.id,
  )[0];
}

export function statoLead(
  lead: LeadRichiesto,
  conv: ConvRiga | null,
  trovataPer: 'crm_lead_id' | 'telefono' | null,
  messaggi: MsgRiga[],
  adesso: Date,
): StatoLeadBf {
  const ingresso = ms(lead.ingresso);
  const eta = Math.round(((adesso.getTime() - ingresso) / ORA_MS) * 10) / 10;
  if (!conv) {
    return {
      crm_lead_id: lead.id, conversation_id: null, trovata_per: null, chat_nuova: null,
      con_chat: false, consegnato: false, risposto: false, wa_number: null, mario_braccio: null,
      bot_outcome: null, ai_status: null, eta_ore: eta,
    };
  }
  const suoi = messaggi.filter((m) => m.conversation_id === conv.id);
  const t = (m: MsgRiga) => ms(m.created_at);
  const esitoAt = ms(conv.bot_outcome_at);
  return {
    crm_lead_id: lead.id,
    conversation_id: conv.id,
    trovata_per: trovataPer,
    chat_nuova: !(ms(conv.created_at) < ingresso - SOGLIA_NOTA_MS),
    con_chat: suoi.some((m) => m.direction === 'out' && t(m) >= ingresso - MARGINE_CHAT_MS),
    consegnato: suoi.some((m) => m.direction === 'out' && t(m) >= ingresso && CONSEGNATI.has(m.twilio_status ?? '')),
    risposto: suoi.some((m) => m.direction === 'in' && t(m) >= ingresso),
    wa_number: conv.wa_number,
    mario_braccio: conv.mario_braccio,
    bot_outcome: conv.bot_outcome && Number.isFinite(esitoAt) && esitoAt >= ingresso ? conv.bot_outcome : null,
    ai_status: conv.ai_status,
    eta_ore: eta,
  };
}

export interface ConvRiepilogo {
  crm_funnel: string | null;
  created_at: string;
  bot_outcome: string | null;
  last_inbound_at: string | null;
}

/** Chat nate dalla data, per crm_funnel attuale. `esiti`: bot_outcome, ATTIVA se vuoto. */
export function riepilogoPerFunnel(convs: ConvRiepilogo[], adesso: Date): RigaFunnelBot[] {
  const acc = new Map<string, { chat: number; risposto: number; app: number; ore: number; esiti: Record<string, number> }>();
  for (const c of convs) {
    const f = c.crm_funnel?.trim() || 'SCONOSCIUTO';
    const a = acc.get(f) ?? { chat: 0, risposto: 0, app: 0, ore: 0, esiti: {} };
    a.chat++;
    if (c.last_inbound_at) a.risposto++;
    if (c.bot_outcome === 'APPUNTAMENTO') a.app++;
    a.ore += (adesso.getTime() - ms(c.created_at)) / ORA_MS;
    const e = c.bot_outcome ?? 'ATTIVA';
    a.esiti[e] = (a.esiti[e] ?? 0) + 1;
    acc.set(f, a);
  }
  return [...acc.entries()]
    .map(([funnel, a]) => ({
      funnel,
      chat: a.chat,
      risposto: a.risposto,
      appuntamenti: a.app,
      eta_media_ore: a.chat ? Math.round((a.ore / a.chat) * 10) / 10 : null,
      esiti: a.esiti,
    }))
    .sort((x, y) => y.chat - x.chat || x.funnel.localeCompare(y.funnel));
}

export const MAX_LEAD = 1000;

/** Corpo della richiesta del CRM. null = non valido. */
export function leggiRichiesta(json: unknown): { ts: number; dal: Date; leads: LeadRichiesto[] } | null {
  if (!json || typeof json !== 'object') return null;
  const j = json as { ts?: unknown; dal?: unknown; leads?: unknown };
  const ts = Date.parse(String(j.ts));
  const dal = new Date(String(j.dal));
  if (!Number.isFinite(ts) || Number.isNaN(dal.getTime())) return null;
  if (!Array.isArray(j.leads) || j.leads.length > MAX_LEAD) return null;
  const leads: LeadRichiesto[] = [];
  for (const l of j.leads) {
    if (!l || typeof l !== 'object') return null;
    const x = l as { id?: unknown; ingresso?: unknown; telefono?: unknown };
    if (typeof x.id !== 'string' || !x.id || typeof x.ingresso !== 'string' || !Number.isFinite(Date.parse(x.ingresso))) return null;
    leads.push({ id: x.id, ingresso: x.ingresso, telefono: typeof x.telefono === 'string' ? x.telefono : null });
  }
  return { ts, dal, leads };
}
