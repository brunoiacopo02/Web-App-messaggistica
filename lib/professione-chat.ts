import type { getSupabaseAdmin } from './supabase/admin';
import { isMarkerProfessioni, riconosciProfessione, type SlugProfessione } from './professioni';

type Supa = ReturnType<typeof getSupabaseAdmin>;

/**
 * Il lead ha mandato la frase del funnel Professioni: si segna il corso sulla chat, che sia
 * appena adottata o gia' aperta da tempo (spec §1). Il funnel CRM non si tocca: quello si
 * decide solo all'adozione. Senza frase o senza corso riconosciuto non scrive niente.
 */
export async function segnaProfessione(supabase: Supa, conversationId: number, testo: string | null | undefined): Promise<SlugProfessione | null> {
  if (!isMarkerProfessioni(testo)) return null;
  const slug = riconosciProfessione(testo);
  if (!slug) return null;
  const { error } = await supabase.from('conversations').update({ professione: slug }).eq('id', conversationId);
  if (error) {
    await supabase.from('event_log').insert({
      type: 'professione_non_scritta',
      payload: { conversationId, slug, errore: error.message } as never,
      message: `[professioni] conv ${conversationId}: corso ${slug} NON scritto — ${error.message}`,
      level: 'warn',
    });
    return null;
  }
  await supabase.from('event_log').insert({
    type: 'professione_segnata',
    payload: { conversationId, slug } as never,
    message: `[professioni] conv ${conversationId}: interessato a ${slug}`,
    level: 'info',
  });
  return slug;
}
