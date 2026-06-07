import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { toE164 } from '@/lib/phone';
import { findOrCreateLeadConversation, sendTemplateAndLog } from '@/lib/messaging';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Endpoint generico chiamato dal CRM per inviare UN template a un lead, su trigger.
// Adatto a tutti i messaggi "manuali/evento" (es. conferme: nr, autoconferma).
// Body JSON: { phone, templateSid, label?, firstName?, lastName?, email?, acContactId? }

function authorized(req: NextRequest): boolean {
  const secret = process.env.AGENDA_API_SECRET; // secret condiviso dei trigger CRM
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
    const text = await req.text();
    new URLSearchParams(text).forEach((v, k) => (body[k] = v));
  }

  const phone = toE164((body.phone ?? body.Phone ?? body.to ?? null) as string | null);
  if (!phone) {
    return NextResponse.json({ ok: false, error: 'telefono mancante o non valido' }, { status: 400 });
  }

  const templateSid = (body.templateSid ?? body.template_sid ?? body.contentSid) as string | undefined;
  if (!templateSid || !/^HX[0-9a-f]{32}$/i.test(templateSid)) {
    return NextResponse.json({ ok: false, error: 'templateSid mancante o non valido (atteso HX...)' }, { status: 400 });
  }

  const label = ((body.label as string | undefined) ?? 'Template').slice(0, 80);

  const supabase = getSupabaseAdmin();

  const { conversationId } = await findOrCreateLeadConversation(supabase, {
    phone,
    firstName: (body.firstName ?? body.first_name) as string | undefined,
    lastName: (body.lastName ?? body.last_name) as string | undefined,
    email: body.email as string | undefined,
    acContactId: (body.acContactId ?? body.contact_id) as string | undefined,
  });

  const res = await sendTemplateAndLog(supabase, conversationId, phone, templateSid, label);

  await supabase.from('event_log').insert({
    type: res.ok ? 'template_sent' : 'send_error',
    payload: { phone, conversationId, templateSid, label, sid: res.sid, error: res.error } as never,
    message: res.ok ? `Template '${label}' inviato a ${phone}` : `Template '${label}' fallito per ${phone}: ${res.error}`,
    level: res.ok ? 'info' : 'error',
  });

  return NextResponse.json({ ok: res.ok, sid: res.sid, conversationId, error: res.error });
}
