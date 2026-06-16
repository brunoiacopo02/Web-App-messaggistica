import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseServer } from '@/lib/supabase/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { toE164 } from '@/lib/phone';
import { findOrCreateLeadConversation, sendTemplateAndLog } from '@/lib/messaging';
import { feniceOpening } from '@/lib/fenice-opening';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const authed = await getSupabaseServer();
  const { data: { user } } = await authed.auth.getUser();
  if (!user) return new NextResponse('unauthorized', { status: 401 });

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const phone = toE164((body.phone ?? null) as string | null);
  if (!phone) return NextResponse.json({ ok: false, error: 'telefono non valido' }, { status: 400 });

  const templateSid = process.env.FENICE_OPENING_TEMPLATE_SID;
  const from = process.env.TWILIO_WHATSAPP_NUMBER_FENICE;
  if (!templateSid || !from) {
    return NextResponse.json({ ok: false, error: 'FENICE_OPENING_TEMPLATE_SID o TWILIO_WHATSAPP_NUMBER_FENICE non configurati' }, { status: 500 });
  }

  const firstName = (body.firstName ?? body.first_name) as string | undefined;

  const supabase = getSupabaseAdmin();
  const { conversationId } = await findOrCreateLeadConversation(supabase, {
    phone,
    firstName,
  });

  // Riempi il nome ({{3}}) nel template e registra il testo risolto come apertura,
  // così la cronologia non mostra il placeholder e Mario prosegue senza ripresentarsi.
  const variables: Record<string, string> = firstName ? { '3': firstName } : {};
  const res = await sendTemplateAndLog(
    supabase, conversationId, phone, templateSid, 'Fenice apertura', from, variables, feniceOpening(firstName),
  );

  await supabase.from('conversations')
    .update({ ai_owner: 'mario', ai_status: 'active', ai_started_at: new Date().toISOString() })
    .eq('id', conversationId);

  await supabase.from('event_log').insert({
    type: res.ok ? 'fenice_enroll' : 'send_error',
    payload: { phone, conversationId, sid: res.sid, error: res.error } as never,
    message: res.ok ? `Lead arruolato (Mario): ${phone}` : `Arruolamento fallito ${phone}: ${res.error}`,
    level: res.ok ? 'info' : 'error',
  });

  return NextResponse.json({ ok: res.ok, conversationId, sid: res.sid, error: res.error });
}
