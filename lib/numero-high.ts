/**
 * "Questo numero oggi e' HIGH?" — la guardia comune dei follow-up che il PO ha
 * riacceso o messo in test il 07/11/2026 (sollecito agenda, A/B del touch).
 *
 * Legge lo stato scritto dal cron qualita-numeri (`app_settings.qualita_numeri_stato`,
 * lettura PEGGIORE del giorno, ogni 3 ore dalle 06:10) e i tetti (`tetti_numeri`).
 * Basta una lettura MEDIUM o LOW oggi perche' il numero resti fermo fino a domani:
 * il giorno dopo riparte solo se la prima lettura e' di nuovo HIGH.
 *
 * Fallisce chiuso: stato illeggibile o nessuna lettura oggi = non si manda
 * (`non_letto`), ma non e' un calo di qualita' (chi tiene un interruttore a scatto,
 * come l'A/B del touch, NON deve fermarsi per questo).
 */
import { soloNumero, type StatoQualita } from './qualita-numeri';

export type EsitoNumero =
  | { ok: true }
  | { ok: false; motivo: 'senza_numero' | 'non_letto' | 'sotto_high' | 'in_pausa' | 'tetto_zero'; qualita?: string };

export function numeroHighOggi(input: {
  numero: string | null | undefined;
  stato: Pick<StatoQualita, 'storico' | 'pause'> | null;
  /** `tetti_numeri` grezzo o parsato. Un numero ASSENTE non e' fermo (il 3199 puo' mancare). */
  tetti: Map<string, number> | Record<string, unknown> | null;
  oggi: string;
}): EsitoNumero {
  const num = soloNumero(input.numero ?? '');
  if (!num) return { ok: false, motivo: 'senza_numero' };
  if (!input.stato) return { ok: false, motivo: 'non_letto' };
  if (input.stato.pause?.[num]) return { ok: false, motivo: 'in_pausa' };
  const q = input.stato.storico?.[num]?.[input.oggi];
  if (q === 'MEDIUM' || q === 'LOW') return { ok: false, motivo: 'sotto_high', qualita: q };
  // Tetto 0 scritto a mano (o dal cron): numero fermo, non si sollecita da li'.
  const t = tettoScritto(input.tetti, num);
  if (t === 0) return { ok: false, motivo: 'tetto_zero' };
  if (q !== 'HIGH') return { ok: false, motivo: 'non_letto' };
  return { ok: true };
}

function tettoScritto(tetti: Map<string, number> | Record<string, unknown> | null, num: string): number | null {
  if (!tetti) return null;
  if (tetti instanceof Map) return tetti.has(num) ? (tetti.get(num) as number) : null;
  for (const [k, v] of Object.entries(tetti)) {
    if (soloNumero(k) === num) return typeof v === 'number' ? v : Number(v);
  }
  return null;
}
