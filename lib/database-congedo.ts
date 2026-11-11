/**
 * "Non mi interessa" su un lead di database (PO 10/11/2026): una riga di congedo e la chat
 * si chiude con l'esito che c'e' gia' per questo caso, `DA_SCARTARE` motivo "non
 * interessato" (lo stesso del congedo del lancio, lib/lancio-effetti.ts). Nessun esito
 * nuovo, nessun rilancio.
 *
 * Il congedo e' un testo libero: il lead ha appena premuto il pulsante, quindi la
 * finestra delle 24 ore e' aperta sul numero della chat.
 */
import type { getSupabaseAdmin } from './supabase/admin';
import { sendFreeText } from './twilio';
import { sendOutcome } from './bot-outcome';
import {
  EVENTO_DATABASE_NON_INTERESSA, PULSANTE_NON_INTERESSA, TESTO_CONGEDO_DATABASE, notaNonInteressaDatabase,
  type VarianteDatabase,
} from './database-bot';

type Supa = ReturnType<typeof getSupabaseAdmin>;

/**
 * Manda il congedo e l'esito. `chiusa: true` quando l'esito e' definitivo (il CRM l'ha
 * preso, o ha risposto 403: il lead non e' piu' del bot). Un errore di rete o un 500
 * lasciano la chat 'active': il messaggio del lead ha gia' la sua risposta, e la chat la
 * chiude `bot-followups` come ogni conversazione che si ferma.
 * Se l'invio del congedo lancia, l'errore sale: il drain lo registra e riprova al giro dopo.
 */
export async function congedoDatabase(
  supabase: Supa,
  c: { conversationId: number; phone: string; from: string; crmLeadId: string | null; variante: VarianteDatabase | null },
): Promise<{ chiusa: boolean }> {
  const sent = await sendFreeText({ to: c.phone, body: TESTO_CONGEDO_DATABASE, from: c.from });
  await supabase.from('messages').insert({
    conversation_id: c.conversationId, direction: 'out', body: TESTO_CONGEDO_DATABASE,
    twilio_sid: sent.sid, twilio_status: sent.status, sender: 'bot',
  });
  await supabase.from('conversations').update({ last_message_at: new Date().toISOString() }).eq('id', c.conversationId);

  let accettato = true;
  let motivo: string | null = null;
  if (c.crmLeadId) {
    const esito = await sendOutcome(supabase, c.conversationId, {
      outcome: 'DA_SCARTARE',
      discardReason: 'non interessato',
      note: notaNonInteressaDatabase(c.variante),
      leadWords: PULSANTE_NON_INTERESSA,
    });
    accettato = esito.sent || esito.error === 'note_duplicate' || esito.status === 403;
    motivo = esito.sent ? null : (esito.error ?? `http_${esito.status ?? '?'}`);
  }
  await supabase.from('event_log').insert({
    type: EVENTO_DATABASE_NON_INTERESSA,
    payload: { conversationId: c.conversationId, variante: c.variante, crmLeadId: c.crmLeadId, accettato, motivo } as never,
    message: `[database] conv ${c.conversationId}: "Non mi interessa", congedata${accettato ? '' : ' (esito al CRM non partito)'}`,
    level: accettato ? 'info' : 'warn',
  });
  return { chiusa: accettato };
}
