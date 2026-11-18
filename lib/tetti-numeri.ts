import type { getSupabaseAdmin } from './supabase/admin';
import { numeroPrimario } from './mittente';

type Supa = ReturnType<typeof getSupabaseAdmin>;

/**
 * Quante chat NUOVE al giorno puo' aprire ogni numero secondario del bot.
 *
 * Vive in `app_settings.tetti_numeri` e non in una env perche' il PO la gira a
 * mano, senza deploy (delibera 26/09/2026: 150 elixir, 150 8061, 0 il 0047 a
 * riposo). Per esempio:
 *   update app_settings set value='{"whatsapp:+393522018718":150}'::jsonb where key='tetti_numeri';
 *
 * Fallisce chiuso: un numero assente, o con un valore che non e' un intero >= 0,
 * vale 0 — cioe' non apre niente. Un numero nuovo si brucia col volume, e
 * l'unico volume giusto e' quello che una persona ha scritto.
 * Il primario passa di qui solo per le aperture di Mario (`includiPrimario`):
 * assente o 0 = non entra nel giro e fa solo da ripiego, com'era fino al 23/10/2026.
 */
const KEY = 'tetti_numeri';

function chiave(n: string): string {
  return n.trim().replace(/^whatsapp:/i, '');
}

export function parseTettiNumeri(raw: unknown): Map<string, number> {
  const out = new Map<string, number>();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
    if (Number.isInteger(n) && n >= 0) out.set(chiave(k), n);
  }
  return out;
}

export function tettoDi(tetti: Map<string, number>, numero: string): number {
  return tetti.get(chiave(numero)) ?? 0;
}

/** null = non si e' potuto leggere: chi chiama tratta tutti i secondari come chiusi. */
export async function getTettiNumeri(supabase: Supa): Promise<Map<string, number> | null> {
  try {
    const { data, error } = await supabase.from('app_settings').select('value').eq('key', KEY).maybeSingle();
    if (error) {
      console.error('[tetti-numeri] lettura fallita: nessun secondario apre', error);
      return null;
    }
    return parseTettiNumeri((data as { value?: unknown } | null)?.value);
  } catch (e) {
    console.error('[tetti-numeri] lettura esplosa: nessun secondario apre', e);
    return null;
  }
}

/**
 * Lo stato del cron qualita-numeri (`app_settings.qualita_numeri_stato`, scritto da
 * lib/qualita-numeri.ts), letto per il trabocco di `scegliMittenteNuovo`: storico
 * per numero (senza `whatsapp:`) → giorno di Roma → lettura peggiore del giorno,
 * pause in corso e, dal 17/11/2026, `ultime`: l'ultima lettura valida di ogni numero
 * con la fila di letture cattive (assente negli stati scritti prima).
 */
export type StatoQualitaLetto = {
  storico: Record<string, Record<string, string>>;
  pause: Record<string, unknown>;
  ultime?: Record<string, { qualita?: string; alle?: string; cattiveDiFila?: number } | undefined>;
  /** Numeri tenuti aperti da una persona anche sotto HIGH (titolare 18/11/2026). */
  esenti?: string[];
};

/** null = non si e' potuto leggere: nessun numero vale HIGH (fallisce chiuso). */
export async function getStatoQualitaNumeri(supabase: Supa): Promise<StatoQualitaLetto | null> {
  try {
    const { data, error } = await supabase.from('app_settings').select('value').eq('key', 'qualita_numeri_stato').maybeSingle();
    if (error) return null;
    const v = (data as { value?: Partial<StatoQualitaLetto> } | null)?.value;
    if (!v || typeof v !== 'object') return null;
    return {
      storico: v.storico ?? {}, pause: v.pause ?? {},
      ...(v.ultime && typeof v.ultime === 'object' ? { ultime: v.ultime } : {}),
      ...(Array.isArray(v.esenti) ? { esenti: v.esenti.filter((x): x is string => typeof x === 'string') } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Il numero puo' ricevere i giri che vogliono un numero sano (Black Friday, trabocco,
 * database): ha una lettura di oggi, o di ieri se oggi non c'e' ancora (il cron gira
 * 06:10-21:10 Roma; un intake di notte vede la sera prima), e non e' in pausa.
 *
 * Titolare 17/11/2026: un numero esce da questi giri solo quando il cron lo ferma, cioe'
 * dopo DUE letture cattive di fila, non per una lettura isolata. Quindi:
 * - pausa in corso (finche' il cron non la toglie) = no;
 * - peggiore del giorno HIGH = si';
 * - peggiore del giorno MEDIUM o LOW = si' solo se la fila di letture cattive in
 *   `ultime` e' sotto 2 (lettura isolata, o gia' tornato HIGH). Con la fila a 2 o piu'
 *   e' no anche senza pausa: e' il numero che il cron non ha potuto fermare perche' era
 *   l'ultimo aperto, e fuori da questi giri ci stava gia' prima;
 * - nessuna lettura, lettura piu' vecchia di ieri, UNKNOWN, stato senza `ultime` per quel
 *   numero (scritto prima di questa regola) = no, come prima (fallisce chiuso).
 * Il primario (3199) tiene la regola di prima: esce alla prima lettura sotto HIGH
 * (decisione che NON cambia), quindi per lui vale solo la peggiore del giorno.
 */
export function eHighEFuoriPausa(stato: StatoQualitaLetto | null, numero: string, oggi: string, ieri: string): boolean {
  if (!stato) return false;
  const n = chiave(numero);
  // Tenuto aperto da una persona (titolare 18/11/2026): vale come sano, qualunque lettura.
  if (stato.esenti?.some((e) => chiave(e) === n)) return true;
  if (stato.pause[n]) return false;
  const giorni = stato.storico[n] ?? {};
  const delGiorno = giorni[oggi] ?? giorni[ieri];
  if (delGiorno === 'HIGH') return true;
  if (delGiorno !== 'MEDIUM' && delGiorno !== 'LOW') return false;
  if (n === chiave(numeroPrimario() ?? '')) return false;
  const fila = stato.ultime?.[n]?.cattiveDiFila;
  return typeof fila === 'number' && Number.isInteger(fila) && fila >= 0 && fila < 2;
}
