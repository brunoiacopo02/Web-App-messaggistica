/**
 * Pool "lead del lancio mai contattati dal bot" (PO 07/10/2026).
 *
 * I lead del lancio a cui il follow-up non era ancora partito sono stati tolti al bot:
 * la chat resta ferma (`handed_off_reason = HANDOFF_VERGINI`, `ai_paused_at`,
 * `lancio_fase = 'chiuso'`, così nessun cron la tocca) e nel CRM finiscono in un pool
 * a parte su /import. Da lì il TL li dà ai GDO, oppure ne restituisce N al bot: in quel
 * caso il CRM chiama `/api/bot/lancio-riprendi` e la chat torna com'era prima del
 * blocco, quindi il cron del follow-up la riprende al suo giro.
 *
 * La fase di prima sta in `lancio_info.pool_vergini.fase_prima`.
 */
export const HANDOFF_VERGINI = 'lancio_pool_vergini';

/** Fasi da cui il blocco può essere partito: sono quelle che il follow-up lavora. */
const FASI_RIPRISTINABILI = new Set(['attesa', 'posto_bloccato', 'link_inviato', 'post_pitch']);

export type ConvVergine = {
  id: number;
  handed_off_reason: string | null;
  lancio_info: Record<string, unknown> | null;
};

export type RipresaUpdate = {
  ai_status: 'active';
  ai_paused_at: null;
  handed_off_at: null;
  handed_off_reason: null;
  lancio_fase: string;
  lancio_info: Record<string, unknown>;
};

/**
 * L'update che riporta una chat bloccata nel pool allo stato di prima, o null se la chat
 * non è una di quelle bloccate da questo pool (qualcun altro l'ha già presa: un GDO, il
 * pulsante del webinar, un altro passaggio). Una fase di prima sconosciuta torna
 * `attesa`, che è la fase di partenza del follow-up.
 */
export function ripresaVergine(conv: ConvVergine, adesso: Date): RipresaUpdate | null {
  if (conv.handed_off_reason !== HANDOFF_VERGINI) return null;
  const info = conv.lancio_info ?? {};
  const pv = (info.pool_vergini ?? {}) as Record<string, unknown>;
  const prima = typeof pv.fase_prima === 'string' && FASI_RIPRISTINABILI.has(pv.fase_prima)
    ? pv.fase_prima
    : 'attesa';
  return {
    ai_status: 'active',
    ai_paused_at: null,
    handed_off_at: null,
    handed_off_reason: null,
    lancio_fase: prima,
    lancio_info: { ...info, pool_vergini: { ...pv, ripreso_at: adesso.toISOString() } },
  };
}

/** Il corpo della richiesta del CRM: `{ leadIds: string[] }`, al massimo 500. */
export function parseRiprendi(json: unknown): { ok: true; leadIds: string[] } | { ok: false; reason: string } {
  const ids = (json as { leadIds?: unknown } | null)?.leadIds;
  if (!Array.isArray(ids)) return { ok: false, reason: 'leadIds_mancante' };
  const puliti = [...new Set(ids.filter((x): x is string => typeof x === 'string' && x.length > 0))];
  if (puliti.length === 0) return { ok: false, reason: 'leadIds_vuoto' };
  if (puliti.length > 500) return { ok: false, reason: 'troppi_lead' };
  return { ok: true, leadIds: puliti };
}
