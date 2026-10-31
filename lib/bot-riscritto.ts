import type { getSupabaseAdmin } from '@/lib/supabase/admin';
import { sendCrmNota } from '@/lib/bot-outcome';
import { buildBotRipresoNote } from '@/lib/bot-outcome-rules';

type Supa = ReturnType<typeof getSupabaseAdmin>;

/** Al massimo una nota «il lead ha riscritto» per conversazione in questa finestra. */
export const FINESTRA_NOTA_RISCRITTO_MS = 6 * 60 * 60 * 1000;

/** Il lucchetto è l'evento stesso (indice `event_log_type_idx` su type, created_at). */
export const EVENTO_NOTA_RISCRITTO = 'bot_nota_riscritto';

/**
 * Il lead restituito a un GDO (esito non APPUNTAMENTO) ha riscritto: avvisa il CRM con
 * le sue parole, al massimo una volta ogni 6 ore per conversazione. Prima ogni
 * «grazie» / «a presto» dopo la riapertura produceva un'altra nota (2-4 in pochi minuti).
 *
 * Compare-and-set su event_log: si scrive prima il lucchetto, poi si guarda chi è il
 * PRIMO della finestra. Di due inbound in volo insieme spedisce solo quello col lucchetto
 * più vecchio. Se l'invio fallisce il lucchetto si toglie, così il messaggio successivo
 * riprova invece di lasciare il GDO al buio per 6 ore.
 */
export async function notaRiscrittoSeDovuta(
  supabase: Supa,
  input: { conversationId: number; crmLeadId: string; esitoPrecedente: string; testo: string },
): Promise<void> {
  const { conversationId, crmLeadId, esitoPrecedente, testo } = input;
  const { data: mio, error: eIns } = await supabase
    .from('event_log')
    .insert({
      type: EVENTO_NOTA_RISCRITTO,
      payload: { conversationId, crmLeadId, esitoPrecedente, testo: testo.slice(0, 300) } as never,
      message: `[bot-fissatore] conv ${conversationId}: il lead restituito come ${esitoPrecedente} ha riscritto`,
      level: 'info',
    })
    .select('id')
    .single();
  if (eIns || !mio) return;
  const mioId = (mio as { id: number }).id;

  const da = new Date(Date.now() - FINESTRA_NOTA_RISCRITTO_MS).toISOString();
  const { data: primo } = await supabase
    .from('event_log')
    .select('id')
    .eq('type', EVENTO_NOTA_RISCRITTO)
    .eq('payload->>conversationId', String(conversationId))
    .gte('created_at', da)
    .order('id', { ascending: true })
    .limit(1)
    .maybeSingle();
  const primoId = (primo as { id: number } | null)?.id;
  if (primoId !== undefined && primoId !== mioId) {
    // Nota già partita (o in partenza) nella finestra: questo messaggio non ne fa un'altra.
    await supabase.from('event_log').delete().eq('id', mioId);
    return;
  }

  const nota = buildBotRipresoNote({ esitoPrecedente, quandoIso: new Date().toISOString(), leadWords: testo });
  const r = await sendCrmNota(supabase, conversationId, nota);
  if (!r.sent) {
    await supabase.from('event_log').delete().eq('id', mioId);
    await supabase.from('event_log').insert({
      type: 'bot_nota_riscritto_fallita',
      payload: { conversationId, crmLeadId, status: r.status ?? null, errore: r.error ?? null } as never,
      message: `[bot-fissatore] conv ${conversationId}: nota "il lead ha riscritto" NON arrivata al CRM (${r.error ?? r.status ?? '?'})`,
      level: 'warn',
    });
  }
}
