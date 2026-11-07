/**
 * A/B del modello di Mario (decisione PO 07/11/2026).
 *
 * Due bracci, assegnati PER CONVERSAZIONE e mai per singola risposta:
 * - `sonnet`: claude-sonnet-5-5, il modello base, senza ragionamento (come prima su Sonnet 5);
 * - `opus`:   claude-opus-5-5 col ragionamento, piu' il blocco di tecniche di vendita
 *             approvate (`lib/mario-blocco-opus.ts`).
 *
 * La quota del braccio Opus si cambia SENZA deploy da `app_settings`, chiave
 * `mario_opus_percentuale` (numero 0-100). Se la riga manca vale l'env
 * `MARIO_OPUS_PERCENTUALE`, se manca anche quella vale 0 (tutti su Sonnet).
 *
 * Stabilita': al primo turno di Mario la conversazione riceve il braccio da un hash del
 * suo id (secchiello 0-99, Opus se secchiello < percentuale) e lo scrive in
 * `conversations.mario_braccio`. Da li' in poi il braccio e' quello scritto, anche se la
 * percentuale cambia: passare da 25 a 50 manda su Opus solo le conversazioni NUOVE, non
 * cambia modello a meta' di una chat. Unica eccezione: percentuale 0 e' l'interruttore
 * di emergenza e porta TUTTI su Sonnet, anche chi era gia' su Opus.
 *
 * Ogni errore di lettura/scrittura porta su Sonnet: il braccio non deve mai fermare una
 * risposta al lead.
 */
import type { getSupabaseAdmin } from './supabase/admin';

type Supa = ReturnType<typeof getSupabaseAdmin>;

export type BraccioMario = 'sonnet' | 'opus';

export const MODELLO_SONNET = 'claude-sonnet-5-5';
export const MODELLO_OPUS = 'claude-opus-5-5';
export const SETTING_PERCENTUALE_OPUS = 'mario_opus_percentuale';
export const ENV_PERCENTUALE_OPUS = 'MARIO_OPUS_PERCENTUALE';

export const MODELLO_DEL_BRACCIO: Record<BraccioMario, string> = {
  sonnet: MODELLO_SONNET,
  opus: MODELLO_OPUS,
};

/** Secchiello stabile 0-99 di una conversazione (FNV-1a 32 bit su un prefisso fisso). */
export function secchielloConversazione(conversationId: number): number {
  const s = `mario-ab:${conversationId}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % 100;
}

/** Il braccio che l'hash darebbe a questa conversazione con questa percentuale. */
export function braccioDaPercentuale(conversationId: number, percentualeOpus: number): BraccioMario {
  return secchielloConversazione(conversationId) < percentualeOpus ? 'opus' : 'sonnet';
}

/** 0-100 intero, o null se il valore non e' una percentuale leggibile. */
export function normalizzaPercentuale(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return null;
  return Math.min(100, Math.max(0, Math.round(n)));
}

const CACHE_MS = 60_000;
let _cache: { valore: number; letto: number } | null = null;

/** Solo per i test. */
export function _azzeraCachePercentuale(): void {
  _cache = null;
}

/** La percentuale del braccio Opus: app_settings, poi env, poi 0. Cache di 60 secondi. */
export async function leggiPercentualeOpus(supabase: Supa, nowMs: number = Date.now()): Promise<number> {
  if (_cache && nowMs - _cache.letto < CACHE_MS) return _cache.valore;
  let valore: number | null = null;
  try {
    const { data } = await supabase.from('app_settings').select('value').eq('key', SETTING_PERCENTUALE_OPUS).maybeSingle();
    valore = normalizzaPercentuale((data as { value?: unknown } | null)?.value);
  } catch {
    valore = null;
  }
  if (valore === null) valore = normalizzaPercentuale(process.env[ENV_PERCENTUALE_OPUS]) ?? 0;
  _cache = { valore, letto: nowMs };
  return valore;
}

function braccioValido(v: unknown): BraccioMario | null {
  return v === 'opus' || v === 'sonnet' ? v : null;
}

/**
 * Il braccio di questa conversazione, assegnato e scritto al primo uso.
 * La scrittura e' condizionata a `mario_braccio is null`: due drain concorrenti non
 * possono assegnare due bracci diversi, vince il primo e l'altro rilegge.
 */
export async function braccioConversazione(supabase: Supa, conversationId: number): Promise<BraccioMario> {
  try {
    const percentuale = await leggiPercentualeOpus(supabase);
    if (percentuale <= 0) return 'sonnet';
    const { data } = await supabase.from('conversations').select('mario_braccio').eq('id', conversationId).maybeSingle();
    const esistente = braccioValido((data as { mario_braccio?: unknown } | null)?.mario_braccio);
    if (esistente) return esistente;
    const nuovo = braccioDaPercentuale(conversationId, percentuale);
    const { data: scritto } = await supabase.from('conversations')
      .update({ mario_braccio: nuovo } as never)
      .eq('id', conversationId)
      .is('mario_braccio', null)
      .select('mario_braccio');
    const rows = (scritto ?? []) as { mario_braccio?: unknown }[];
    if (rows.length > 0) return braccioValido(rows[0].mario_braccio) ?? nuovo;
    // Un altro drain l'ha scritto un attimo prima: vale il suo.
    const { data: riletto } = await supabase.from('conversations').select('mario_braccio').eq('id', conversationId).maybeSingle();
    return braccioValido((riletto as { mario_braccio?: unknown } | null)?.mario_braccio) ?? nuovo;
  } catch {
    return 'sonnet';
  }
}
