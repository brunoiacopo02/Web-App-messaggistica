import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { parseAcPayload, DEDUP_WINDOW_MINUTES } from '@/lib/ac';
import { matchCampaign, renderTemplateVariables, type CampaignRow } from '@/lib/campaigns';
import { toE164 } from '@/lib/phone';
import { sendTemplate } from '@/lib/twilio';
import { checkRateLimit } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function readBody(req: NextRequest): Promise<Record<string, unknown>> {
  const ct = req.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) {
    try { return await req.json(); } catch { return {}; }
  }
  // form-encoded
  const text = await req.text();
  const params = new URLSearchParams(text);
  const out: Record<string, string> = {};
  params.forEach((v, k) => { out[k] = v; });
  return out;
}

export async function POST(req: NextRequest) {
  // Auth via secret in URL o header
  const expected = process.env.AC_WEBHOOK_SECRET;
  const provided =
    req.nextUrl.searchParams.get('secret') ??
    req.headers.get('x-ac-secret') ??
    '';
  if (!expected || provided !== expected) {
    return new NextResponse('forbidden', { status: 403 });
  }

  // Rate limit basico
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  const rl = checkRateLimit(`ac:${ip}`, 60, 60_000);
  if (!rl.ok) return new NextResponse('rate limit', { status: 429 });

  const body = await readBody(req);
  const supabase = getSupabaseAdmin();
  const lead = parseAcPayload(body);

  // Log iniziale (servirà anche come storia per dedup)
  await supabase.from('event_log').insert({
    type: 'ac_webhook',
    payload: { email: lead.email, phone: lead.phone, listName: lead.listName, listId: lead.listId, raw: body },
    message: 'AC webhook received',
    level: 'info',
  });

  // Normalizza telefono
  const phone = toE164(lead.phone);
  if (!phone) {
    await supabase.from('event_log').insert({
      type: 'send_error',
      payload: { lead },
      message: 'Telefono mancante o non valido',
      level: 'warn',
    });
    return NextResponse.json({ ok: true, skipped: 'invalid_phone' });
  }

  // Dedup: cerca event_log type='ac_webhook' con stesso email|phone negli ultimi N min
  const since = new Date(Date.now() - DEDUP_WINDOW_MINUTES * 60_000).toISOString();
  const { count } = await supabase
    .from('event_log')
    .select('id', { count: 'exact', head: true })
    .eq('type', 'ac_webhook')
    .gte('created_at', since)
    .or(`payload->>email.eq.${lead.email ?? '__none__'},payload->>phone.eq.${phone}`);

  if ((count ?? 0) > 1) {
    // > 1 perché l'INSERT sopra è già contato
    await supabase.from('event_log').insert({
      type: 'dedup_skip',
      payload: { email: lead.email, phone },
      message: 'Webhook duplicato entro finestra dedup',
      level: 'info',
    });
    return NextResponse.json({ ok: true, skipped: 'dedup' });
  }

  // Trova campagna matching
  const { data: campaignsData } = await supabase
    .from('campaigns').select('*').eq('active', true);
  const campaigns = (campaignsData ?? []) as CampaignRow[];
  const campaign = matchCampaign(campaigns, lead);
  if (!campaign) {
    await supabase.from('event_log').insert({
      type: 'config_error',
      payload: { listName: lead.listName, listId: lead.listId },
      message: 'Nessuna campagna attiva matcha questa lista AC',
      level: 'error',
    });
    return NextResponse.json({ ok: true, skipped: 'no_campaign' });
  }

  // Upsert lead
  const { data: leadRow, error: leadErr } = await supabase
    .from('leads')
    .upsert({
      phone_e164: phone,
      first_name: lead.firstName,
      last_name: lead.lastName,
      email: lead.email,
      ac_contact_id: lead.acContactId,
    }, { onConflict: 'phone_e164' })
    .select('id')
    .single();
  if (leadErr || !leadRow) {
    await supabase.from('event_log').insert({
      type: 'send_error', message: `Lead upsert fallito: ${leadErr?.message}`,
      payload: { phone, error: leadErr }, level: 'error',
    });
    return NextResponse.json({ ok: true, skipped: 'lead_upsert_failed' });
  }

  // Find or create conversation
  const { data: convExisting } = await supabase
    .from('conversations').select('id').eq('lead_id', leadRow.id).maybeSingle();
  let conversationId = convExisting?.id;
  if (!conversationId) {
    const { data: convNew, error: convErr } = await supabase
      .from('conversations')
      .insert({ lead_id: leadRow.id, campaign_id: campaign.id })
      .select('id').single();
    if (convErr || !convNew) {
      await supabase.from('event_log').insert({
        type: 'send_error', message: `Conv create fallito: ${convErr?.message}`,
        payload: { leadId: leadRow.id }, level: 'error',
      });
      return NextResponse.json({ ok: true, skipped: 'conv_create_failed' });
    }
    conversationId = convNew.id;
  }

  // Render variabili e invia template
  const vars = renderTemplateVariables(campaign.template_variables, lead);

  let sent: { sid: string; status: string } | null = null;
  try {
    sent = await sendTemplate({
      to: phone,
      contentSid: campaign.twilio_template_sid,
      variables: vars,
    });
  } catch (err: any) {
    await supabase.from('event_log').insert({
      type: 'send_error', message: `Twilio send fallito: ${err?.message ?? 'unknown'}`,
      payload: { phone, code: err?.code, status: err?.status }, level: 'error',
    });
    // Inseriamo comunque il messaggio come 'failed'
    await supabase.from('messages').insert({
      conversation_id: conversationId,
      direction: 'out',
      body: `[template] ${campaign.name}`,
      twilio_status: 'failed',
      twilio_error_code: err?.code ?? null,
      template_sid: campaign.twilio_template_sid,
      template_vars: vars,
      is_template: true,
    });
    return NextResponse.json({ ok: true, sent: false });
  }

  // Insert message + bump conversation
  await supabase.from('messages').insert({
    conversation_id: conversationId,
    direction: 'out',
    body: `[template] ${campaign.name}`,
    twilio_sid: sent.sid,
    twilio_status: sent.status,
    template_sid: campaign.twilio_template_sid,
    template_vars: vars,
    is_template: true,
  });

  await supabase.from('conversations')
    .update({ last_message_at: new Date().toISOString() })
    .eq('id', conversationId);

  return NextResponse.json({ ok: true, sent: true, sid: sent.sid });
}
