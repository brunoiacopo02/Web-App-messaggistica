import { NextResponse } from 'next/server';
import { getSupabaseServer } from '@/lib/supabase/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { SendMessageSchema } from '@/lib/schemas';
import { sendFreeText, sendTemplate } from '@/lib/twilio';
import { isWindowOpen } from '@/lib/utils';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  const supabase = await getSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return new NextResponse('unauthorized', { status: 401 });

  let body;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'invalid json' }, { status: 400 }); }

  const parsed = SendMessageSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'validation', details: parsed.error.flatten() }, { status: 400 });
  }
  const input = parsed.data;

  const admin = getSupabaseAdmin();
  const { data: conv } = await admin
    .from('conversations')
    .select('id, last_inbound_at, lead:leads(phone_e164)')
    .eq('id', input.conversation_id)
    .single();
  if (!conv) return NextResponse.json({ error: 'conversation not found' }, { status: 404 });

  const phone = (conv as any).lead?.phone_e164 as string | undefined;
  if (!phone) return NextResponse.json({ error: 'lead phone missing' }, { status: 422 });

  if (input.mode === 'free') {
    if (!isWindowOpen((conv as any).last_inbound_at)) {
      return NextResponse.json({ error: 'window_expired' }, { status: 422 });
    }
    let sent;
    try {
      sent = await sendFreeText({ to: phone, body: input.body });
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
    });
  } catch (err: any) {
    await admin.from('event_log').insert({
      type: 'send_error', message: `UI template send fallito: ${err?.message}`,
      payload: { phone, code: err?.code }, level: 'error',
    });
    return NextResponse.json({ error: 'twilio_error', code: err?.code }, { status: 502 });
  }
  const { data: msg } = await admin.from('messages').insert({
    conversation_id: input.conversation_id,
    direction: 'out',
    body: `[template] ${(campaign as any).name}`,
    twilio_sid: sent.sid,
    twilio_status: sent.status,
    template_sid: (campaign as any).twilio_template_sid,
    template_vars: input.vars,
    is_template: true,
  }).select('id').single();
  await admin.from('conversations').update({ last_message_at: new Date().toISOString() }).eq('id', input.conversation_id);
  return NextResponse.json({ id: (msg as any)?.id, twilio_sid: sent.sid });
}
