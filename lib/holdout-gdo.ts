/**
 * Holdout del riscaldamento dei lead GDO (PO 07/11/2026): misurare se serve davvero.
 *
 * Il PO vuole sapere se le domande del riscaldamento (gdo_warmup_*) alzano presenze e
 * chiusure, non se la parte tecnica funziona. Analisi del 07/11: "innocui, effetto non
 * visibile" — senza un gruppo che NON le riceve non si puo' dire. Qui il gruppo.
 *
 * - SOLO il riscaldamento: niente domande ne' nel turno del drain ne' in coda al recap.
 *   Recap, video, solleciti video e promemoria restano a tutti (decisione PO 07/11 sera).
 *   Mai sui promemoria T-24h/T-3h degli appuntamenti del bot.
 * - Braccio stabile per conversazione: secchiello FNV-1a 0-99 dell'id; `holdout` se
 *   secchiello < percentuale (PO: 50), altrimenti `warmup`.
 * - Solo chat con `gdo_agenda_at` dal giorno `dal` (Roma) in poi: chi aveva gia' iniziato
 *   il riscaldamento non lo perde a meta'.
 *
 * Interruttore `app_settings.holdout_gdo` = {"attivo": true, "percentuale": 50, "dal": "YYYY-MM-DD"}.
 * Riga assente, illeggibile, `attivo` != true o `dal` non valido = nessun holdout (tutti
 * ricevono il riscaldamento, come prima). Cache 60 secondi.
 *
 * Misura: evento `holdout_gdo_braccio` una volta per conversazione, ENTRAMBI i bracci,
 * con `braccio` e `crmLeadId` (join sul CRM per presenze/chiusure/€). Il braccio si
 * ricostruisce comunque dall'hash (`secchielloHoldout`).
 */
import { giornoRoma } from './qualita-numeri';
import { alertUnaVolta } from './alert-una-volta';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Supa = { from: (t: string) => any };

export type BraccioHoldout = 'holdout' | 'warmup';
export const KEY_HOLDOUT_GDO = 'holdout_gdo';
export const PERCENTUALE_DEFAULT = 50;

export type ConfigHoldout = { percentuale: number; dal: string };

export function parseHoldoutGdo(raw: unknown): ConfigHoldout | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.attivo !== true) return null;
  const dal = String(r.dal ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dal)) return null;
  const p = r.percentuale === undefined ? PERCENTUALE_DEFAULT : Number(r.percentuale);
  if (!Number.isFinite(p)) return null;
  const percentuale = Math.min(100, Math.max(0, Math.round(p)));
  return percentuale > 0 ? { percentuale, dal } : null;
}

/** Secchiello 0-99 stabile della conversazione. */
export function secchielloHoldout(conversationId: number): number {
  const s = `holdout-gdo:warmup:${conversationId}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % 100;
}

/** Puro: il braccio di questa conversazione, o null se fuori dal test (spento, chat vecchia). */
export function braccioHoldout(
  config: ConfigHoldout | null,
  conversationId: number,
  gdoAgendaAt: string | null | undefined,
): BraccioHoldout | null {
  if (!config || !gdoAgendaAt) return null;
  const ms = Date.parse(gdoAgendaAt);
  if (!Number.isFinite(ms) || giornoRoma(new Date(ms)) < config.dal) return null;
  return secchielloHoldout(conversationId) < config.percentuale ? 'holdout' : 'warmup';
}

const CACHE_MS = 60_000;
let _cache: { valore: ConfigHoldout | null; letto: number } | null = null;
/** Conversazioni gia' loggate in questo processo: evita la lettura di event_log a ogni turno. */
const _loggate = new Set<number>();

/** Solo per i test. */
export function _azzeraCacheHoldout(): void {
  _cache = null;
  _loggate.clear();
}

/** Mai lancia: un errore = nessun holdout (tutti ricevono tutto, come oggi). */
export async function leggiHoldoutGdo(supabase: Supa, nowMs: number = Date.now()): Promise<ConfigHoldout | null> {
  if (_cache && nowMs - _cache.letto < CACHE_MS) return _cache.valore;
  let valore: ConfigHoldout | null = null;
  try {
    const { data } = await supabase.from('app_settings').select('value').eq('key', KEY_HOLDOUT_GDO).maybeSingle();
    valore = parseHoldoutGdo((data as { value?: unknown } | null)?.value);
  } catch {
    valore = null;
  }
  _cache = { valore, letto: nowMs };
  return valore;
}

/** Logga il braccio (una volta per conversazione, entrambi i bracci). Mai lancia. */
export async function segnaBraccioHoldout(
  supabase: Supa,
  args: { conversationId: number; braccio: BraccioHoldout; crmLeadId?: string | null; dove: string },
): Promise<void> {
  if (_loggate.has(args.conversationId)) return;
  _loggate.add(args.conversationId);
  try {
    await alertUnaVolta(supabase, {
      type: 'holdout_gdo_braccio',
      conversationId: args.conversationId,
      level: 'info',
      payload: { braccio: args.braccio, crmLeadId: args.crmLeadId ?? null, dove: args.dove },
      message: `[holdout-gdo] conv ${args.conversationId}: braccio ${args.braccio}`,
    });
  } catch {
    // la misura si ricostruisce dall'hash
  }
}
