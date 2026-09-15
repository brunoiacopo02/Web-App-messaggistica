import type { getSupabaseAdmin } from './supabase/admin';

type Supa = ReturnType<typeof getSupabaseAdmin>;

/**
 * Una select dei candidati che fallisce torna `data: null`, cioè — per chi scrive
 * `data ?? []` — zero righe da lavorare. Il cron gira, risponde `ok: true, sent: 0`
 * e si ferma per tutti, in silenzio: da fuori è identico a una coda vuota.
 *
 * Non è teoria: `lancio_slug`/`lancio_fase` sono entrati insieme in sei query, e una
 * migrazione non ancora applicata (Postgres 42703, colonna sconosciuta) le spegnerebbe
 * tutte nello stesso minuto. Qui non si cambia il comportamento — si lascia la traccia
 * che permette di accorgersene: una riga `event_log` di livello error e uno
 * `console.error` nei log della funzione.
 */
export async function logCronQueryError(
  supabase: Supa,
  type: string,
  error: { message?: string; code?: string } | null,
): Promise<void> {
  const messaggio = error?.message ?? 'errore sconosciuto';
  const codice = error?.code ?? null;
  console.error(`[cron] ${type}: ${messaggio}${codice ? ` (${codice})` : ''}`);
  await supabase.from('event_log').insert({
    type,
    payload: { message: messaggio, code: codice } as never,
    message: `[cron] query candidati fallita (${type}): ${messaggio}`,
    level: 'error',
  });
}
