import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { sendTemplateAndLog } from '@/lib/messaging';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

// Gira ogni minuto: invia il template "video" alle conversazioni che hanno ricevuto
// l'agenda da >= 5 minuti e non hanno ancora ricevuto il video. Idempotente.

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  if (req.headers.get('authorization') === `Bearer ${secret}`) return true;
  if (req.nextUrl.searchParams.get('secret') === secret) return true;
  return false;
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return new NextResponse('unauthorized', { status: 401 });

  const agendaSid = process.env.AGENDA_TEMPLATE_SID;
  const videoSid = process.env.VIDEO_TEMPLATE_SID;
  if (!agendaSid || !videoSid) {
    return NextResponse.json({ ok: false, error: 'AGENDA/VIDEO template SID non configurati' }, { status: 500 });
  }

  const supabase = getSupabaseAdmin();
  const now = Date.now();
  const fiveMinAgo = new Date(now - 5 * 60 * 1000).toISOString();
  const dayAgo = new Date(now - 24 * 60 * 60 * 1000).toISOString();

  // Agende inviate con successo tra 5 min e 24h fa.
  const { data: agendaMsgs } = await supabase
    .from('messages')
    .select('conversation_id')
    .eq('template_sid', agendaSid)
    .eq('direction', 'out')
    .eq('is_template', true)
    .not('twilio_status', 'in', '(failed,undelivered)')
    .lte('created_at', fiveMinAgo)
    .gte('created_at', dayAgo);

  const agendaConvIds = [...new Set((agendaMsgs ?? []).map((m) => m.conversation_id))];
  if (agendaConvIds.length === 0) return NextResponse.json({ ok: true, sent: 0 });

  // Conversazioni che hanno già il video → escludi.
  const { data: videoMsgs } = await supabase
    .from('messages')
    .select('conversation_id')
    .eq('template_sid', videoSid)
    .in('conversation_id', agendaConvIds);
  const done = new Set((videoMsgs ?? []).map((m) => m.conversation_id));
  const targets = agendaConvIds.filter((id) => !done.has(id));
  if (targets.length === 0) return NextResponse.json({ ok: true, sent: 0 });

  // Recupera i telefoni dei lead delle conversazioni target.
  const { data: convs } = await supabase.from('conversations').select('id, lead_id').in('id', targets);
  const leadIds = [...new Set((convs ?? []).map((c) => c.lead_id))];
  const { data: leads } = await supabase.from('leads').select('id, phone_e164').in('id', leadIds);
  const phoneByLead = new Map((leads ?? []).map((l) => [l.id, l.phone_e164]));

  let sent = 0;
  let failed = 0;
  for (const conv of convs ?? []) {
    const phone = phoneByLead.get(conv.lead_id);
    if (!phone) continue;
    const r = await sendTemplateAndLog(supabase, conv.id, phone, videoSid, 'Video');
    if (r.ok) sent++;
    else failed++;
  }

  if (sent > 0 || failed > 0) {
    await supabase.from('event_log').insert({
      type: 'video_followup',
      payload: { sent, failed, candidates: targets.length } as never,
      message: `Video follow-up: inviati ${sent}, falliti ${failed}`,
      level: failed > 0 ? 'warn' : 'info',
    });
  }

  return NextResponse.json({ ok: true, sent, failed });
}
