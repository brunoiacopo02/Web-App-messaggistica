import type { getSupabaseAdmin } from './supabase/admin';
import { eSuAltroAccount } from './twilio-account';

type Supa = ReturnType<typeof getSupabaseAdmin>;

/**
 * Il peso di ogni numero nella divisione delle aperture a freddo (titolare 17/11/2026).
 *
 * Dove si sceglie "il numero meno carico" (lib/scelta-mittente.ts: il giro normale, il
 * giro Black Friday `sceltaHighMenoCarico`, il trabocco) non si confrontano piu' le
 * aperture di oggi ma aperture ÷ peso. Peso 1 = quota piena; 0,9 = a regime il numero
 * riceve il 10% in meno di uno a peso 1. A parita' resta l'ordine di sempre.
 *
 * Predefinito: 0,9 per i numeri dell'account Twilio principale, 1 per gli altri.
 * "Account principale" = il numero NON e' dichiarato su un altro account
 * (`TWILIO_WHATSAPP_NUMBERS_2` / `_3`, lib/twilio-account.ts): oggi il 3199 e l'8061,
 * che condividono il WABA storico e sono i piu' delicati. Un numero dimenticato in
 * quelle env risulta sul principale e prende 0,9: sbaglia verso il meno.
 *
 * Si regola senza deploy in `app_settings.pesi_numeri`, mappa numero → peso (con o senza
 * `whatsapp:`), per esempio:
 *   insert into app_settings (key, value) values
 *     ('pesi_numeri', '{"+393520413199":0.9,"+393520158061":0.9,"+393522070047":1}'::jsonb);
 * Riga assente, illeggibile o non un oggetto = tutti al predefinito. Un numero assente
 * dalla mappa, o con un valore non valido (non numerico, non finito, <= 0), prende il suo
 * predefinito: la mappa puo' essere parziale. Per fermare un numero non si usa il peso
 * ma il tetto 0 in `tetti_numeri`.
 */
export const KEY_PESI_NUMERI = 'pesi_numeri';
export const PESO_ACCOUNT_PRINCIPALE = 0.9;
export const PESO_ALTRI_ACCOUNT = 1;

function chiave(n: string): string {
  return n.trim().replace(/^whatsapp:/i, '');
}

/** 0,9 se il numero sta sull'account principale, 1 se e' dichiarato su un altro account. */
export function pesoPredefinito(numero: string): number {
  return eSuAltroAccount(numero) ? PESO_ALTRI_ACCOUNT : PESO_ACCOUNT_PRINCIPALE;
}

/** Solo le voci valide (numero finito > 0; accetta "0.9" e "0,9" scritti a mano). */
export function parsePesiNumeri(raw: unknown): Map<string, number> {
  const out = new Map<string, number>();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v.trim().replace(',', '.')) : NaN;
    if (Number.isFinite(n) && n > 0 && chiave(k)) out.set(chiave(k), n);
  }
  return out;
}

/** Il peso scritto in `pesi_numeri`, o il predefinito del numero. */
export function pesoDi(pesi: Map<string, number> | null | undefined, numero: string): number {
  return pesi?.get(chiave(numero)) ?? pesoPredefinito(numero);
}

/**
 * Aperture ÷ peso: e' il numero che si confronta per scegliere il meno carico.
 * Arrotondato al milionesimo, cosi' 9 aperture a peso 0,9 e 10 a peso 1 sono pari
 * anche quando la divisione in virgola mobile lascia un resto.
 */
export function caricoPesato(aperture: number, peso: number): number {
  const p = Number.isFinite(peso) && peso > 0 ? peso : 1;
  return Math.round((aperture / p) * 1e6) / 1e6;
}

/**
 * La mappa di `app_settings.pesi_numeri`. Non fallisce mai: lettura in errore, riga
 * assente o malformata = mappa vuota, cioe' tutti al predefinito (il peso sposta una
 * quota del 10%, non protegge un numero: non vale fermare un'apertura per lui).
 */
export async function getPesiNumeri(supabase: Supa): Promise<Map<string, number>> {
  try {
    const { data, error } = await supabase.from('app_settings').select('value').eq('key', KEY_PESI_NUMERI).maybeSingle();
    if (error) return new Map();
    return parsePesiNumeri((data as { value?: unknown } | null)?.value);
  } catch {
    return new Map();
  }
}
