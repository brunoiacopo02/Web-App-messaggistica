import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { sendFreeText, sendTemplate, getTemplateBody } from '@/lib/twilio';
import { renderBodyTemplate } from '@/lib/campaigns';
import { isWindowOpen } from '@/lib/utils';
import type { z } from 'zod';
import type { SendMessageSchema } from '@/lib/schemas';

export type SendMessageInput = z.infer<typeof SendMessageSchema>;

/** Invia un messaggio (libero o template) in una conversazione. Logica unica per /api/messages e /api/campagne-chat/messages. */
export async function sendConversationMessage(input: SendMessageInput): Promise<NextResponse> {
  const admin = getSupabaseAdmin();
  const { data: conv } = await admin
    .from('conversations')
    .select('id, last_inbound_at, wa_number, lead:leads(phone_e164)')
    .eq('id', input.conversation_id)
    .single();
  if (!conv) return NextResponse.json({ error: 'conversation not found' }, { status: 404 });

  const phone = (conv as any).lead?.phone_e164 as string | undefined;
  if (!phone) return NextResponse.json({ error: 'lead phone missing' }, { status: 422 });

  // Risposta dallo stesso numero aziendale della conversazione (finestra 24h per
  // coppia numero/utente). Fallback: default env (TWILIO_WHATSAPP_NUMBER).
  const from = ((conv as any).wa_number as string | null) ?? undefined;

  if (input.mode === 'free') {
    if (!isWindowOpen((conv as any).last_inbound_at)) {
      return NextResponse.json({ error: 'window_expired' }, { status: 422 });
    }
    let sent;
    try {
      sent = await sendFreeText({ to: phone, body: input.body, from });
    } catch (err: any) {
      await admin.from('event_log').insert({
        type: 'send_error', message: `UI free send fallito: ${err?.message}`,
        payload: { phone, code: err?.code }, level: 'error',
      });
      return NextResponse.json({ error: 'twilio_error', code: err?.code }, { status: 502 });
    }
    const { data: msg } = await admin.from('messages').insert({
      conversation_id: input.conversation_id,
      direction: 'out',
      body: input.body,
      twilio_sid: sent.sid,
      twilio_status: sent.status,
      sender: 'operatore',
    }).select('id').single();
    await admin.from('conversations').update({ last_message_at: new Date().toISOString() }).eq('id', input.conversation_id);
    return NextResponse.json({ id: (msg as any)?.id, twilio_sid: sent.sid });
  }

  // template mode
  const { data: campaign } = await admin
    .from('campaigns')
    .select('twilio_template_sid, name, active')
    .eq('id', input.template_id)
    .single();
  if (!campaign || !(campaign as any).active) {
    return NextResponse.json({ error: 'campaign_not_found_or_inactive' }, { status: 404 });
  }
  let sent;
  try {
    sent = await sendTemplate({
      to: phone,
      contentSid: (campaign as any).twilio_template_sid,
      variables: input.vars,
      from,
    });
  } catch (err: any) {
    await admin.from('event_log').insert({
      type: 'send_error', message: `UI template send fallito: ${err?.message}`,
      payload: { phone, code: err?.code }, level: 'error',
    });
    return NextResponse.json({ error: 'twilio_error', code: err?.code }, { status: 502 });
  }
  const tplBodyRaw = (await getTemplateBody((campaign as any).twilio_template_sid)) ?? `[template] ${(campaign as any).name}`;
  const tplBody = renderBodyTemplate(tplBodyRaw, input.vars);
  const { data: msg } = await admin.from('messages').insert({
    conversation_id: input.conversation_id,
    direction: 'out',
    body: tplBody,
    twilio_sid: sent.sid,
    twilio_status: sent.status,
    template_sid: (campaign as any).twilio_template_sid,
    template_vars: input.vars,
    is_template: true,
    sender: 'operatore',
  }).select('id').single();
  await admin.from('conversations').update({ last_message_at: new Date().toISOString() }).eq('id', input.conversation_id);
  return NextResponse.json({ id: (msg as any)?.id, twilio_sid: sent.sid });
}
