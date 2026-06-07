import type { getSupabaseAdmin } from './supabase/admin';
import { sendTemplate } from './twilio';

type Supa = ReturnType<typeof getSupabaseAdmin>;

export type LeadInfo = {
  phone: string; // E.164
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  acContactId?: string | null;
};

/**
 * Trova o crea lead (per telefono) e la sua conversazione. Non sovrascrive con null
 * i campi non forniti (così non cancella dati esistenti del lead).
 */
export async function findOrCreateLeadConversation(
  supabase: Supa,
  info: LeadInfo,
): Promise<{ leadId: number; conversationId: number }> {
  const payload: Record<string, unknown> = { phone_e164: info.phone };
  if (info.firstName != null) payload.first_name = info.firstName;
  if (info.lastName != null) payload.last_name = info.lastName;
  if (info.email != null) payload.email = info.email;
  if (info.acContactId != null) payload.ac_contact_id = info.acContactId;

  const { data: leadRow, error } = await supabase
    .from('leads')
    .upsert(payload as never, { onConflict: 'phone_e164' })
    .select('id')
    .single();
  if (error || !leadRow) throw new Error(`lead upsert fallito: ${error?.message}`);

  const { data: convExisting } = await supabase
    .from('conversations')
    .select('id')
    .eq('lead_id', leadRow.id)
    .maybeSingle();
  if (convExisting) return { leadId: leadRow.id, conversationId: convExisting.id };

  const { data: convNew, error: convErr } = await supabase
    .from('conversations')
    .insert({ lead_id: leadRow.id })
    .select('id')
    .single();
  if (convErr || !convNew) throw new Error(`conversazione create fallita: ${convErr?.message}`);
  return { leadId: leadRow.id, conversationId: convNew.id };
}

/**
 * Invia un template a una conversazione esistente e registra il messaggio (out).
 * In caso di errore Twilio registra comunque un messaggio 'failed'.
 */
export async function sendTemplateAndLog(
  supabase: Supa,
  conversationId: number,
  phone: string,
  templateSid: string,
  label: string,
): Promise<{ ok: boolean; sid?: string; error?: string }> {
  try {
    const sent = await sendTemplate({ to: phone, contentSid: templateSid, variables: {} });
    await supabase.from('messages').insert({
      conversation_id: conversationId,
      direction: 'out',
      body: `[template] ${label}`,
      twilio_sid: sent.sid,
      twilio_status: sent.status,
      template_sid: templateSid,
      is_template: true,
    });
    await supabase
      .from('conversations')
      .update({ last_message_at: new Date().toISOString() })
      .eq('id', conversationId);
    return { ok: true, sid: sent.sid };
  } catch (err: unknown) {
    const e = err as { message?: string; code?: number };
    await supabase.from('messages').insert({
      conversation_id: conversationId,
      direction: 'out',
      body: `[template] ${label}`,
      twilio_status: 'failed',
      twilio_error_code: e?.code ?? null,
      template_sid: templateSid,
      is_template: true,
    });
    return { ok: false, error: e?.message ?? 'unknown' };
  }
}
