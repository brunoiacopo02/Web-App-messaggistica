import type { getSupabaseAdmin } from './supabase/admin';
import { sendFreeText } from './twilio';
import { nomeProfessione, urlScheda, type SlugProfessione } from './professioni';

type Supa = ReturnType<typeof getSupabaseAdmin>;

export function testoScheda(slug: SlugProfessione): string {
  return `Ecco la scheda del corso di ${nomeProfessione(slug)} 👇`;
}

/**
 * Manda la scheda PDF del corso, una volta sola per chat (spec §3). Il lucchetto e' un
 * compare-and-set su `scheda_inviata_at`: due drain in volo non la mandano due volte. Se
 * Twilio fallisce il lucchetto si rilascia (la prossima occasione ci riprova) e si logga;
 * nessun ripiego su un altro numero.
 */
export async function inviaScheda(
  supabase: Supa,
  i: { conversationId: number; phone: string; from: string; slug: SlugProfessione; momento: 'pre_appuntamento' | 'post_appuntamento' },
): Promise<'inviata' | 'gia_inviata' | 'fallita'> {
  const adesso = new Date().toISOString();
  const { data: prese } = await supabase.from('conversations')
    .update({ scheda_inviata_at: adesso })
    .eq('id', i.conversationId).is('scheda_inviata_at', null).select('id');
  if (!prese || prese.length === 0) return 'gia_inviata';

  const body = testoScheda(i.slug);
  try {
    const sent = await sendFreeText({ to: i.phone, from: i.from, body, mediaUrl: [urlScheda(i.slug)] });
    await supabase.from('messages').insert({
      conversation_id: i.conversationId, direction: 'out', body,
      twilio_sid: sent.sid, twilio_status: sent.status, sender: 'bot',
    });
    await supabase.from('event_log').insert({
      type: 'scheda_inviata',
      payload: { conversationId: i.conversationId, slug: i.slug, momento: i.momento } as never,
      message: `[professioni] conv ${i.conversationId}: scheda ${i.slug} inviata (${i.momento})`,
      level: 'info',
    });
    return 'inviata';
  } catch (e) {
    await supabase.from('conversations').update({ scheda_inviata_at: null }).eq('id', i.conversationId);
    const errore = e instanceof Error ? e.message : 'errore';
    await supabase.from('event_log').insert({
      type: 'scheda_invio_fallito',
      payload: { conversationId: i.conversationId, slug: i.slug, momento: i.momento, errore } as never,
      message: `[professioni] conv ${i.conversationId}: scheda ${i.slug} NON inviata — ${errore}`,
      level: 'error',
    });
    return 'fallita';
  }
}
