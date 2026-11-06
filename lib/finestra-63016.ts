import type { getSupabaseAdmin } from './supabase/admin';

type Supa = ReturnType<typeof getSupabaseAdmin>;

/** "Outside the allowed window": testo libero fuori dalla finestra 24h su quella coppia di numeri. */
export const CODICE_FINESTRA_CHIUSA = 63016;

/**
 * Il 63016 arriva SOLO dalla status callback, dopo che l'invio e' stato accettato: fino
 * al 06/11/2026 finiva in un `twilio_status` generico insieme a tutti gli altri stati, e
 * nessuno lo vedeva. Ora ha un evento suo, `finestra_chiusa_63016`, con quello che serve a
 * capire perche': da quale numero e' partito, su quale numero vive la chat, a quale
 * numero e quando il lead ha scritto l'ultima volta. Se `from` e `lastInboundNumber`
 * differiscono, il bot ha creduto aperta la finestra di un altro numero.
 *
 * Non ritenta e non ripiega su un template: il messaggio e' gia' perso, e un ripiego
 * automatico qui scriverebbe al lead una cosa diversa da quella decisa a monte.
 */
export async function registraFinestraChiusa(
  supabase: Supa,
  p: { sid: string; errorCode?: string | null; from?: string | null; to?: string | null },
): Promise<boolean> {
  if (Number(p.errorCode) !== CODICE_FINESTRA_CHIUSA) return false;
  const { data: msg } = await supabase
    .from('messages').select('conversation_id, sender, is_template').eq('twilio_sid', p.sid).maybeSingle();
  const conversationId = (msg as { conversation_id?: number } | null)?.conversation_id ?? null;
  type ConvFinestra = { wa_number: string | null; last_inbound_number: string | null; last_inbound_at: string | null };
  const conv: ConvFinestra | null = conversationId
    ? (((await supabase
        .from('conversations').select('wa_number, last_inbound_number, last_inbound_at').eq('id', conversationId).maybeSingle()).data as ConvFinestra | null) ?? null)
    : null;
  await supabase.from('event_log').insert({
    type: 'finestra_chiusa_63016',
    payload: {
      sid: p.sid,
      conversationId,
      from: p.from ?? null,
      to: p.to ?? null,
      sender: (msg as { sender?: string | null } | null)?.sender ?? null,
      numeroChat: conv?.wa_number ?? null,
      lastInboundNumber: conv?.last_inbound_number ?? null,
      lastInboundAt: conv?.last_inbound_at ?? null,
    } as never,
    message: `[63016] testo libero fuori finestra 24h da ${p.from ?? '?'} (conv ${conversationId ?? '?'}, ultimo inbound su ${conv?.last_inbound_number ?? '?'} il ${conv?.last_inbound_at ?? '?'}): il lead non l'ha ricevuto`,
    level: 'error',
  });
  return true;
}
