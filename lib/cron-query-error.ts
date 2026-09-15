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
  // Questa funzione non puo' fallire: la chiamano cron che, senza candidati, finivano
  // il giro senza danno. Se anche la scrittura del log andasse giu' — il caso tipico e'
  // proprio quello in cui il DB non risponde — un'eccezione qui trasformerebbe una
  // giornata a zero invii in un 500, cioe' peggiorerebbe l'unica cosa che stavamo
  // provando a rendere visibile. Il console.error resta comunque nei log di Vercel.
  try {
    console.error(`[cron] ${type}: ${messaggio}${codice ? ` (${codice})` : ''}`);
    await supabase.from('event_log').insert({
      type,
      payload: { message: messaggio, code: codice } as never,
      message: `[cron] query candidati fallita (${type}): ${messaggio}`,
      level: 'error',
    });
  } catch (e) {
    console.error(`[cron] ${type}: anche la scrittura del log e' fallita`, e);
  }
}
