import type { getSupabaseAdmin } from './supabase/admin';
import type { Json } from './supabase/types';
import type { LancioFase } from './lancio-fase';

type Supa = ReturnType<typeof getSupabaseAdmin>;

/**
 * Cambio di fase di una chat del lancio: un update e una traccia. E' l'unico punto che
 * scrive `lancio_fase`, cosi' la storia di ogni chat si ricostruisce da `event_log`
 * (`lancio_fase_cambiata`) senza interpretare gli altri eventi. B4 (link, post_pitch,
 * scelta) e B5 (follow-up, restituzione) passano da qui.
 */
export async function impostaFaseLancio(
  supabase: Supa,
  conversationId: number,
  fase: LancioFase,
  campi: { lancio_link_inviato_at?: string; lancio_followup_inviato_at?: string; lancio_info?: Json } = {},
): Promise<void> {
  const { error } = await supabase
    .from('conversations')
    .update({ lancio_fase: fase, ...campi })
    .eq('id', conversationId);
  await supabase.from('event_log').insert({
    type: error ? 'lancio_fase_non_scritta' : 'lancio_fase_cambiata',
    payload: { conversationId, fase, ...campi, ...(error ? { errore: error.message } : {}) } as never,
    message: error
      ? `[lancio] conv ${conversationId}: fase ${fase} NON scritta — ${error.message}`
      : `[lancio] conv ${conversationId}: fase → ${fase}`,
    level: error ? 'error' : 'info',
  });
}
