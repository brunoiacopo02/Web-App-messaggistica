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
import { signPayload } from './bot-hmac';

export const HANDOFF_VERGINI = 'lancio_pool_vergini';

/** Chat fermate perché nel CRM il lead non era più del bot (07/10/2026). */
export const HANDOFF_CRM_NON_DEL_BOT = 'crm_non_del_bot';
/** Gruppo di prova "solo umani" del 106 e del 119. */
const HANDOFF_TEST_UMANI = 'gdo_umani_lancio';

/**
 * Chat del lancio ferma che il bot riprende se il lead scrive (PO 07/10/2026: chi scrive
 * al bot lo gestisce il bot, in qualunque pool sia): pool "mai contattati", restituita
 * al pool dei GDO, fermata perché nel CRM non era più del bot, test umani.
 */
export function chatLancioFerma(c: {
  lancio_slug: string | null;
  lancio_fase: string | null;
  handed_off_reason?: string | null;
}): boolean {
  if (!c.lancio_slug) return false;
  const motivo = c.handed_off_reason ?? null;
  if (motivo === HANDOFF_VERGINI || motivo === HANDOFF_CRM_NON_DEL_BOT || motivo === HANDOFF_TEST_UMANI) return true;
  return c.lancio_fase === 'restituito';
}

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

const DEFAULT_CRM_VERGINE_URL = 'https://crm-sales-fenice.vercel.app/api/bot/lancio/vergine-scrive';

/**
 * Un lead del pool ha scritto: chi scrive lo gestisce il bot (PO 07/10). Il CRM lo passa
 * al bot se è ancora nel pool, e risponde `preso:false` se il TL lo ha già dato a un GDO.
 * Rete giù o risposta strana = non preso: meglio una chat che aspetta il GDO che due
 * persone sullo stesso lead.
 */
export async function reclamaVergine(crmLeadId: string): Promise<{ preso: boolean; motivo?: string }> {
  const secret = process.env.BOT_WEBHOOK_SECRET;
  if (!secret) return { preso: false, motivo: 'not_configured' };
  const rawBody = JSON.stringify({ leadId: crmLeadId });
  try {
    const res = await fetch(process.env.CRM_VERGINE_URL || DEFAULT_CRM_VERGINE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bot-signature': signPayload(rawBody, secret) },
      body: rawBody,
      signal: AbortSignal.timeout(5000),
    });
    const body = (await res.json().catch(() => null)) as { preso?: boolean; motivo?: string } | null;
    if (!res.ok || !body) return { preso: false, motivo: `http_${res.status}` };
    return { preso: body.preso === true, motivo: body.motivo };
  } catch (e) {
    return { preso: false, motivo: e instanceof Error ? e.message : 'network_error' };
  }
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
