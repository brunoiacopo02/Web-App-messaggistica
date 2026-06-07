import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { toE164 } from '@/lib/phone';
import { findOrCreateLeadConversation, sendTemplateAndLog } from '@/lib/messaging';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Endpoint chiamato dal CRM quando un operatore preme "Invia agenda".
// Invia subito il template agenda al lead via Twilio; il video parte automaticamente
// dopo 5 min tramite il cron /api/cron/send-video.

function authorized(req: NextRequest): boolean {
  const secret = process.env.AGENDA_API_SECRET;
  if (!secret) return false;
  if (req.headers.get('authorization') === `Bearer ${secret}`) return true;
  if (req.headers.get('x-agenda-secret') === secret) return true;
  if (req.nextUrl.searchParams.get('secret') === secret) return true;
  return false;
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) return new NextResponse('unauthorized', { status: 401 });

  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    // accetta anche form-encoded
    const text = await req.text();
    new URLSearchParams(text).forEach((v, k) => (body[k] = v));
  }

  const rawPhone = (body.phone ?? body.Phone ?? body.to) as string | undefined;
  const phone = toE164(rawPhone ?? null);
  if (!phone) {
    return NextResponse.json({ ok: false, error: 'telefono mancante o non valido' }, { status: 400 });
  }

  const templateSid = process.env.AGENDA_TEMPLATE_SID;
  if (!templateSid) {
    return NextResponse.json({ ok: false, error: 'AGENDA_TEMPLATE_SID non configurato' }, { status: 500 });
  }

  const supabase = getSupabaseAdmin();

  const { conversationId } = await findOrCreateLeadConversation(supabase, {
    phone,
    firstName: (body.firstName ?? body.first_name) as string | undefined,
    lastName: (body.lastName ?? body.last_name) as string | undefined,
    email: body.email as string | undefined,
    acContactId: (body.acContactId ?? body.contact_id) as string | undefined,
  });

  const res = await sendTemplateAndLog(supabase, conversationId, phone, templateSid, 'Agenda');

  await supabase.from('event_log').insert({
    type: res.ok ? 'agenda_sent' : 'send_error',
    payload: { phone, conversationId, sid: res.sid, error: res.error } as never,
    message: res.ok ? `Agenda inviata a ${phone}` : `Agenda fallita per ${phone}: ${res.error}`,
    level: res.ok ? 'info' : 'error',
  });

  return NextResponse.json({ ok: res.ok, sid: res.sid, conversationId, error: res.error });
}
