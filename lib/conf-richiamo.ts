// Il richiamo blu delle Conferme.
//
// Le Conferme possono "parcheggiare" un lead: niente data della call
// (`confermeOutcome = 'da_rifissare'` nel feed del CRM) e un richiamo in agenda
// (`recall_at`), all'ora in cui Noemi lo chiama per fissare o confermare la
// videochiamata. Il bot ha già la chat aperta con questi lead: circa due ore prima del
// richiamo gli scrive che Noemi lo chiamerà, e di guardare il video.
//
// Sugli stessi lead parcheggiati i promemoria che parlano della call (T-24h/T-3h del
// bot, T-24h dei GDO, solleciti video dei GDO) tacciono: la call che ricordano non c'è
// più. Qui la decisione e il testo, senza I/O, più i due accessi al database che servono
// alle route (lista dei parcheggiati, presa del sollecito).

import { clampToSendWindow } from './precall-reminders';

const H = 3600_000;
const MIN = 60_000;

/** Quanto prima del richiamo parte il sollecito (poi clampato in fascia invii). */
const ANTICIPO_MS = 2 * H;
/** Sotto questo anticipo il sollecito non serve più: Noemi sta per chiamare. */
const ULTIMO_UTILE_MS = 15 * MIN;
/** Finestra di 24h di WhatsApp: dentro si scrive libero, fuori solo template. */
const FINESTRA_MS = 24 * H;

export const ESITO_PARCHEGGIATO = 'da_rifissare';

export interface SollecitoRichiamoInput {
  enabled: boolean;
  confermeOutcome: string | null;
  recallAt: string | null;
  aiPausedAt: string | null;
  /** Già preso per QUESTO richiamo (un richiamo spostato lo riapre). */
  giaInviato: boolean;
  lastInboundAtMs: number | null;
  haTemplate: boolean;
  nowMs: number;
}

/**
 * Il sollecito prima del richiamo: in template, in testo libero, o niente. Parte da due
 * ore prima del richiamo (portate dentro la fascia 08:30-20:30) fino a 15 minuti prima,
 * e mai fuori fascia. Una disdetta chiesta NON lo ferma: il parcheggio di solito segue
 * proprio una richiesta di spostare.
 */
export function decideSollecitoRichiamo(i: SollecitoRichiamoInput): 'template' | 'testo' | null {
  if (!i.enabled || i.confermeOutcome !== ESITO_PARCHEGGIATO) return null;
  if (!i.recallAt || i.aiPausedAt || i.giaInviato) return null;
  const recallMs = Date.parse(i.recallAt);
  if (Number.isNaN(recallMs)) return null;

  const primo = clampToSendWindow(recallMs - ANTICIPO_MS);
  if (i.nowMs < primo || i.nowMs >= recallMs - ULTIMO_UTILE_MS) return null;
  // Fuori fascia invii non si scrive, anche se il richiamo è vicino (un richiamo alle 22
  // ha il sollecito dalle 20:00 alle 20:30, non alle 21).
  if (clampToSendWindow(i.nowMs) !== i.nowMs) return null;

  const daUltimoInbound = i.lastInboundAtMs === null ? null : i.nowMs - i.lastInboundAtMs;
  if (daUltimoInbound !== null && daUltimoInbound < FINESTRA_MS) return 'testo';
  return i.haTemplate ? 'template' : null;
}

export type SollecitoRichiamoVars = { '1': string; '2': string };

/** Il testo del template `fenice_richiamo_conferme_v1`, anche per la finestra aperta. */
export function sollecitoRichiamoText(v: SollecitoRichiamoVars): string {
  return `Ciao ${v['1']}, ${v['2']} ti richiama Noemi, una collega di Fenice Academy, da un numero di cellulare per confermare giorno e ora della tua videochiamata: rispondi, sono pochi minuti. Se non l'hai ancora fatto, guarda il video che ti ho mandato qui.`;
}

// ── I/O ─────────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Supa = { from: (t: string) => any };

/** Pezzi della `.in()`: centinaia di id stanno in un URL, migliaia no. */
const PEZZO = 200;

/**
 * Fra queste conversazioni, quelle parcheggiate dalle Conferme (riga di
 * `crm_lead_status` con esito da_rifissare). Una query per giro, non una per chat. Se la
 * query fallisce torna l'insieme vuoto: i promemoria restano quelli di sempre.
 */
export async function conversazioniParcheggiate(supabase: Supa, ids: number[]): Promise<Set<number>> {
  const out = new Set<number>();
  for (let i = 0; i < ids.length; i += PEZZO) {
    const { data, error } = await supabase
      .from('crm_lead_status')
      .select('conversation_id')
      .eq('conferme_outcome', ESITO_PARCHEGGIATO)
      .in('conversation_id', ids.slice(i, i + PEZZO));
    if (error) {
      console.error(`[conf-richiamo] lettura dei parcheggiati fallita: ${error.message}`);
      continue;
    }
    for (const r of (data ?? []) as Array<{ conversation_id: number | null }>) {
      if (r.conversation_id != null) out.add(r.conversation_id);
    }
  }
  return out;
}

/** Esito della presa: il valore di prima serve a rilasciarla se l'invio non parte. */
export type PresaSollecitoRichiamo = { at: string; prima: string | null };

/**
 * Prende il sollecito per il richiamo di `recallAt` solo se per quello stesso richiamo
 * non è già preso, come `claimPromemoriaGdo` (lib/gdo-reminder24-claim.ts). Torna la
 * presa o `null` (già presa da un altro giro, o update fallito: nel dubbio non si manda).
 */
export async function claimSollecitoRichiamo(
  supabase: Supa,
  conversationId: number,
  recallAt: string,
  prima: string | null,
): Promise<PresaSollecitoRichiamo | null> {
  // Sempre ISO UTC: il CRM manda +01:00/+02:00, Postgres torna UTC.
  const at = new Date(recallAt).toISOString();
  const { data, error } = await supabase
    .from('conversations')
    .update({ conf_richiamo_sollecito_for_at: at })
    .eq('id', conversationId)
    .or(`conf_richiamo_sollecito_for_at.is.null,conf_richiamo_sollecito_for_at.neq.${at}`)
    .select('id');
  if (error) {
    console.error(`[conf-richiamo] presa del sollecito fallita su conv ${conversationId}: ${error.message}`);
    return null;
  }
  if (!data || data.length === 0) return null;
  return { at, prima };
}

/** Ripristina la colonna se l'invio non è partito, solo se porta ancora la nostra presa. */
export async function rilasciaSollecitoRichiamo(
  supabase: Supa,
  conversationId: number,
  presa: PresaSollecitoRichiamo,
): Promise<string | null> {
  const { error } = await supabase
    .from('conversations')
    .update({ conf_richiamo_sollecito_for_at: presa.prima })
    .eq('id', conversationId)
    .eq('conf_richiamo_sollecito_for_at', presa.at);
  return error ? `rilascio del sollecito fallito: ${error.message}` : null;
}
