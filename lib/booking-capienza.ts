// Quanti appuntamenti stanno in una giornata.
//
// 18/08/2026 — il primo giorno dopo la chiusura di ferragosto ha raccolto 98 call in
// una giornata sola: il bot proponeva "domani" a tutti e nessuno contava quante ne
// stessero già dentro. Un'agenda che nessuno può onorare produce disdette e assenze,
// non appuntamenti. Qui si contano le call già fissate per giorno; `booking-slots`
// salta i giorni al completo come salta le domeniche.
//
// Il tetto vive in `BOOKING_DAILY_CAP` perché è un numero di Fenice, non del software:
// senza env non c'è nessun limite e il comportamento resta quello di prima.

/** Il tetto configurato, o `null` se non c'è (nessun limite). */
export function tettoGiornaliero(raw: string | undefined): number | null {
  if (!raw) return null;
  const t = raw.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return n > 0 ? n : null;
}

import { romeOffset } from './rome-time';

/** Data ISO `YYYY-MM-DD` di un istante, nel fuso di Roma. */
function isoRoma(istante: string): string | null {
  const d = new Date(istante);
  if (Number.isNaN(d.getTime())) return null;
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
  return /^\d{4}-\d{2}-\d{2}$/.test(p) ? p : null;
}

/** Quante call per giornata (fuso di Roma), dalle date grezze. */
export function contaPerGiorno(date: Array<string | null | undefined>): Map<string, number> {
  const per = new Map<string, number>();
  for (const d of date) {
    if (!d) continue;
    const iso = isoRoma(d);
    if (!iso) continue;
    per.set(iso, (per.get(iso) ?? 0) + 1);
  }
  return per;
}

/** Quanti giorni avanti guardare: oltre non si fissa comunque. */
const ORIZZONTE_GG = 30;

type Supa = { from: (t: string) => any };

/**
 * Le date (ISO, fuso di Roma) che hanno già raggiunto il tetto.
 *
 * Un errore di lettura torna `[]`: il tetto è un miglioramento dell'agenda, non un
 * motivo per smettere di fissare appuntamenti.
 */
export async function datePiene(supabase: Supa, tetto: number | null, now: Date): Promise<string[]> {
  if (!tetto) return [];
  // Da mezzanotte di oggi a Roma: le call di ieri non occupano l'agenda di domani.
  const oggi = isoRoma(now.toISOString()) ?? now.toISOString().slice(0, 10);
  const da = new Date(`${oggi}T00:00:00${romeOffset(now)}`).toISOString();
  const a = new Date(now.getTime() + ORIZZONTE_GG * 24 * 3600_000).toISOString();
  try {
    const { data, error } = await supabase
      .from('conversations')
      .select('bot_scheduled_at')
      .not('bot_scheduled_at', 'is', null)
      .gte('bot_scheduled_at', da)
      .lt('bot_scheduled_at', a)
      .limit(1000);
    if (error || !data) return [];
    const per = contaPerGiorno((data as Array<{ bot_scheduled_at: string | null }>).map((r) => r.bot_scheduled_at));
    return [...per.entries()].filter(([, n]) => n >= tetto).map(([iso]) => iso).sort();
  } catch {
    return [];
  }
}
