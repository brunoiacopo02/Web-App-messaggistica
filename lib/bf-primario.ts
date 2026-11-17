/**
 * Aperture Black Friday dal 3199 solo per chi ha gia' una chat con lui (PO 12/11/2026).
 *
 * Parole di Bruno: «i bf che arrivano a lui, se hanno una chat in passato con lui va bene
 * che gli scriva lui, altrimenti distribuiamoli sugli altri». L'11 e il 12/11 le aperture
 * BF uscite dal 3199 sono state 35, tutte su chat che esistevano gia' su quel numero
 * (l'arruolamento tiene il numero della chat): 24 con il lead che aveva scritto, 11 con
 * la sola nostra apertura di settembre mai risposta.
 *
 * Regola:
 * - una chat BF NUOVA non nasce mai sul 3199 (`escludiPrimario` in lib/scelta-mittente.ts):
 *   va sul numero HIGH meno carico fra gli altri, con le regole di sempre;
 * - una chat che e' gia' sul 3199 resta li' SOLO se il lead ci ha scritto almeno una volta
 *   (un messaggio in ingresso nella conversazione): quella e' una chat. Una vecchia
 *   apertura mai risposta non lo e': l'apertura BF parte da un altro numero e la chat
 *   passa a quel numero (evento `bf_apertura_fuori_dal_primario`), come gia' fa il cron
 *   bf-aperture quando il numero della chat non e' HIGH;
 * - se nessun altro numero e' utilizzabile, o una lettura fallisce, non si sposta niente
 *   (meglio un'apertura dal 3199 che un lead muto o una chat spezzata).
 *
 * Stabile (non legata alla qualita' del 3199), ma si spegne senza deploy:
 * `app_settings.bf_primario_solo_chat_passata` = "off" (o false). Riga assente o
 * illeggibile = regola ACCESA.
 */
import type { getSupabaseAdmin } from './supabase/admin';

type Supa = ReturnType<typeof getSupabaseAdmin>;

export const KEY_BF_PRIMARIO = 'bf_primario_solo_chat_passata';
export const EVENTO_BF_FUORI_DAL_PRIMARIO = 'bf_apertura_fuori_dal_primario';

const soloNum = (n: string | null | undefined) => (n ?? '').trim().replace(/^whatsapp:/i, '');

/** Solo "off"/false/0/"no" (anche dentro `{attivo: …}`) spengono; tutto il resto = accesa. */
export function parseRegolaBfPrimario(raw: unknown): boolean {
  const v = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as { attivo?: unknown }).attivo : raw;
  if (v === false || v === 0) return false;
  if (typeof v === 'string' && ['off', 'false', '0', 'no', 'spento'].includes(v.trim().toLowerCase())) return false;
  return true;
}

export async function regolaBfPrimarioAttiva(supabase: Supa): Promise<boolean> {
  try {
    const { data, error } = await supabase.from('app_settings').select('value').eq('key', KEY_BF_PRIMARIO).maybeSingle();
    if (error) return true;
    return parseRegolaBfPrimario((data as { value?: unknown } | null)?.value);
  } catch {
    return true;
  }
}

/** Il lead ha mai scritto in questa conversazione? null = non si e' potuto leggere. */
export async function leadHaScrittoInChat(supabase: Supa, conversationId: number): Promise<boolean | null> {
  try {
    const { count, error } = await supabase
      .from('messages').select('id', { count: 'exact', head: true })
      .eq('conversation_id', conversationId).eq('direction', 'in');
    if (error || typeof count !== 'number') return null;
    return count > 0;
  } catch {
    return null;
  }
}

/**
 * La chat e' sul primario senza una chat passata col lead? Allora l'apertura BF deve
 * partire da un altro numero. false in ogni dubbio (regola spenta, chat su un altro
 * numero, lettura fallita): chi chiama lascia tutto com'e'.
 */
export async function bfDaToglierDalPrimario(
  supabase: Supa,
  a: { attiva: boolean; conversationId: number; numeroChat: string | null | undefined; primario: string | null | undefined },
): Promise<boolean> {
  if (!a.attiva) return false;
  const primario = soloNum(a.primario);
  if (!primario || soloNum(a.numeroChat) !== primario) return false;
  return (await leadHaScrittoInChat(supabase, a.conversationId)) === false;
}

/** Lo stesso numero, con o senza `whatsapp:`. */
export function stessoNumero(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!soloNum(a) && soloNum(a) === soloNum(b);
}
