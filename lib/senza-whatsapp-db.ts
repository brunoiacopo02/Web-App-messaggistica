/**
 * Restituzione immediata del lead con numero senza WhatsApp (regole in lib/senza-whatsapp.ts).
 * La chiama la callback di stato Twilio (app/api/webhooks/twilio) dopo la risposta a
 * Twilio. Mai lancia: se qualcosa non torna non fa niente, e la rete del cron orario
 * (`bot-followups`) ci riprova.
 */
import type { getSupabaseAdmin } from './supabase/admin';
import { sendOutcome } from './bot-outcome';
import { esitoMaiConsegnato, postinoGdo, type MsgConErrore } from './bot-followups';
import { lancioInCorso } from './lancio-fase';
import { ERRORI_DESTINATARIO_DEFINITIVI } from './recupero-aperture';
import { convIdonea, numeroSenzaWhatsapp, EVENTO_SENZA_WHATSAPP, HANDOFF_SENZA_WHATSAPP } from './senza-whatsapp';

type Supa = ReturnType<typeof getSupabaseAdmin>;

/** Il buffer di 5' con cui il cron legge la cronologia dall'arruolamento. */
const BUFFER_MS = 5 * 60_000;

/** Dopo un esito Twilio con errore definitivo: se la chat e' tutta fallita, il lead torna al CRM. */
export async function restituisciSeSenzaWhatsapp(
  supabase: Supa,
  args: { sid: string; errorCode: number | null },
  nowMs: number = Date.now(),
): Promise<'restituito' | 'non_serve' | 'errore'> {
  try {
    if (args.errorCode == null || !ERRORI_DESTINATARIO_DEFINITIVI.includes(args.errorCode)) return 'non_serve';
    const { data: msg } = await supabase
      .from('messages').select('conversation_id, direction').eq('twilio_sid', args.sid).maybeSingle();
    if (!msg || msg.direction !== 'out' || msg.conversation_id == null) return 'non_serve';

    const { data: conv } = await supabase
      .from('conversations')
      .select('id, crm_lead_id, crm_funnel, ai_status, bot_outcome, ai_paused_at, ai_started_at, gdo_agenda_at, gdo_appuntamento_at, lancio_slug, lancio_fase')
      .eq('id', msg.conversation_id)
      .maybeSingle();
    if (!conv || !convIdonea(conv)) return 'non_serve';
    if (postinoGdo(conv, nowMs) || lancioInCorso(conv)) return 'non_serve';

    let q = supabase
      .from('messages')
      .select('direction, body, created_at, twilio_status, template_sid, is_template, twilio_error_code')
      .eq('conversation_id', conv.id)
      .order('created_at', { ascending: true })
      .limit(200);
    if (conv.ai_started_at) q = q.gte('created_at', new Date(Date.parse(conv.ai_started_at) - BUFFER_MS).toISOString());
    const { data: righe, error } = await q;
    if (error) return 'errore';
    const rows = (righe ?? []) as MsgConErrore[];
    if (!numeroSenzaWhatsapp(rows)) return 'non_serve';

    const r = await sendOutcome(supabase, conv.id, { ...esitoMaiConsegnato(rows), letto: false });
    if (r.sent) {
      await supabase.from('conversations')
        .update({ handed_off_reason: HANDOFF_SENZA_WHATSAPP, handed_off_at: new Date(nowMs).toISOString() })
        .eq('id', conv.id);
    }
    await supabase.from('event_log').insert({
      type: EVENTO_SENZA_WHATSAPP,
      payload: {
        conversationId: conv.id, crmLeadId: conv.crm_lead_id, funnel: conv.crm_funnel, errorCode: args.errorCode,
        origine: 'twilio_status', sent: r.sent, status: r.status ?? null, error: r.error ?? null,
      },
      message: `[senza-whatsapp] conv ${conv.id}: errore ${args.errorCode}, nessun messaggio consegnato, restituita al CRM da chiamare (${r.sent ? 'ok' : r.error ?? r.status ?? 'errore'})`,
      level: r.sent ? 'info' : 'warn',
    });
    return r.sent ? 'restituito' : 'errore';
  } catch (e) {
    console.error('[senza-whatsapp] restituzione', e);
    return 'errore';
  }
}
