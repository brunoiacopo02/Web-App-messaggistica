import type { getSupabaseAdmin } from './supabase/admin';
import { generateMarioReply, type MarioTurn } from './mario';
import { sendFreeText } from './twilio';

type Supa = ReturnType<typeof getSupabaseAdmin>;

export type AutoReplyGate = {
  toMatchesFenice: boolean;
  autoReplyOn: boolean;
  aiOwner: string | null;
  aiStatus: string | null;
};

/** Pure: decide se Mario deve rispondere in automatico a questo inbound. */
export function shouldAutoReply(g: AutoReplyGate): boolean {
  return g.toMatchesFenice && g.autoReplyOn && g.aiOwner === 'mario' && g.aiStatus === 'active';
}

/**
 * Best-effort: ricostruisce la cronologia, chiama Mario, invia la risposta dal numero
 * Fenice e aggiorna lo stato sui tag. Non lancia: logga gli errori in event_log.
 */
export async function runMarioAutoReply(
  supabase: Supa,
  conversationId: number,
  phone: string,
): Promise<void> {
  const from = process.env.TWILIO_WHATSAPP_NUMBER_FENICE;
  if (!from) {
    await supabase.from('event_log').insert({
      type: 'fenice_ai_error', payload: { conversationId } as never,
      message: 'TWILIO_WHATSAPP_NUMBER_FENICE non configurato', level: 'error',
    });
    return;
  }

  try {
    const { data: msgs } = await supabase
      .from('messages')
      .select('direction, body, created_at')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true })
      .limit(100);

    const history: MarioTurn[] = (msgs ?? []).map((m: any) => ({
      role: m.direction === 'in' ? 'user' : 'assistant',
      content: m.body,
    }));

    const result = await generateMarioReply(history);

    if (result.visibleReply) {
      const sent = await sendFreeText({ to: phone, body: result.visibleReply, from });
      await supabase.from('messages').insert({
        conversation_id: conversationId, direction: 'out', body: result.visibleReply,
        twilio_sid: sent.sid, twilio_status: sent.status,
      });
      await supabase.from('conversations')
        .update({ last_message_at: new Date().toISOString() })
        .eq('id', conversationId);
    }

    if (result.passToHuman) {
      await supabase.from('conversations').update({ ai_status: 'handed_off' }).eq('id', conversationId);
    } else if (result.appointmentFixed) {
      await supabase.from('conversations').update({ ai_status: 'booked' }).eq('id', conversationId);
    }

    await supabase.from('event_log').insert({
      type: 'fenice_ai_reply',
      payload: { conversationId, phone, appointmentFixed: result.appointmentFixed, passToHuman: result.passToHuman } as never,
      message: `Mario ha risposto a ${phone}`, level: 'info',
    });
  } catch (err) {
    const m = err instanceof Error ? err.message : 'errore';
    await supabase.from('event_log').insert({
      type: 'fenice_ai_error', payload: { conversationId, phone, error: m } as never,
      message: `Auto-risposta Mario fallita per ${phone}: ${m}`, level: 'error',
    });
  }
}
