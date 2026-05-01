import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { validateTwilioSignature } from '@/lib/twilio';
import { toE164 } from '@/lib/phone';
import { checkRateLimit } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TWIML_OK = '<Response/>';
const TWIML_HEADERS = { 'content-type': 'text/xml' };

function publicUrl(req: NextRequest): string {
  const base = process.env.NEXT_PUBLIC_APP_URL;
  if (base) return `${base}${req.nextUrl.pathname}`;
  // fallback per dev
  const host = req.headers.get('host');
  const proto = req.headers.get('x-forwarded-proto') ?? 'https';
  return `${proto}://${host}${req.nextUrl.pathname}`;
}

export async function POST(req: NextRequest) {
  // Rate limit
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  const rl = checkRateLimit(`tw:${ip}`, 120, 60_000);
  if (!rl.ok) return new NextResponse('rate limit', { status: 429 });

  // Twilio webhook è form-encoded
  const text = await req.text();
  const params: Record<string, string> = {};
  new URLSearchParams(text).forEach((v, k) => { params[k] = v; });

  // Validazione firma
  const signature = req.headers.get('x-twilio-signature') ?? '';
  const ok = await validateTwilioSignature({
    url: publicUrl(req),
    signature,
    params,
  });
  if (!ok) return new NextResponse('forbidden', { status: 403 });

  const supabase = getSupabaseAdmin();

  // Status callback?
  if (params.MessageStatus && params.MessageSid) {
    await supabase
      .from('messages')
      .update({
        twilio_status: params.MessageStatus,
        twilio_error_code: params.ErrorCode ? parseInt(params.ErrorCode, 10) : null,
      })
      .eq('twilio_sid', params.MessageSid);

    await supabase.from('event_log').insert({
      type: 'twilio_status',
      payload: params,
      message: `Status ${params.MessageStatus} per ${params.MessageSid}`,
      level: params.MessageStatus === 'failed' || params.MessageStatus === 'undelivered' ? 'warn' : 'info',
    });
    return new NextResponse(TWIML_OK, { status: 200, headers: TWIML_HEADERS });
  }

  // Inbound message
  if (params.MessageSid && params.From && params.Body !== undefined) {
    const phone = toE164(params.From);
    if (!phone) {
      await supabase.from('event_log').insert({
        type: 'twilio_inbound', payload: params,
        message: `From non parsabile: ${params.From}`, level: 'warn',
      });
      return new NextResponse(TWIML_OK, { status: 200, headers: TWIML_HEADERS });
    }

    // Lead
    let leadId: number;
    const { data: leadExisting } = await supabase
      .from('leads').select('id').eq('phone_e164', phone).maybeSingle();
    if (leadExisting) {
      leadId = leadExisting.id;
    } else {
      const { data: leadNew, error: leadErr } = await supabase
        .from('leads').insert({ phone_e164: phone }).select('id').single();
      if (leadErr || !leadNew) {
        await supabase.from('event_log').insert({
          type: 'twilio_inbound', payload: { params, error: leadErr } as any,
          message: 'Lead create fallito', level: 'error',
        });
        return new NextResponse(TWIML_OK, { status: 200, headers: TWIML_HEADERS });
      }
      leadId = leadNew.id;
    }

    // Conversation
    let conversationId: number;
    const { data: convExisting } = await supabase
      .from('conversations').select('id').eq('lead_id', leadId).maybeSingle();
    if (convExisting) {
      conversationId = convExisting.id;
    } else {
      const { data: convNew, error: convErr } = await supabase
        .from('conversations').insert({ lead_id: leadId }).select('id').single();
      if (convErr || !convNew) {
        await supabase.from('event_log').insert({
          type: 'twilio_inbound', payload: { params, error: convErr } as any,
          message: 'Conv create fallito', level: 'error',
        });
        return new NextResponse(TWIML_OK, { status: 200, headers: TWIML_HEADERS });
      }
      conversationId = convNew.id;
    }

    // Insert messaggio (UNIQUE su twilio_sid → dedup retry)
    const { error: msgErr } = await supabase.from('messages').insert({
      conversation_id: conversationId,
      direction: 'in',
      body: params.Body,
      twilio_sid: params.MessageSid,
      twilio_status: 'received',
    });

    if (msgErr) {
      // Possibile duplicato (UNIQUE violation) → skip
      await supabase.from('event_log').insert({
        type: 'twilio_inbound', payload: { sid: params.MessageSid, error: msgErr } as any,
        message: msgErr.code === '23505' ? 'Duplicato (UNIQUE)' : `Insert fallito: ${msgErr.message}`,
        level: msgErr.code === '23505' ? 'info' : 'error',
      });
      return new NextResponse(TWIML_OK, { status: 200, headers: TWIML_HEADERS });
    }

    // Bump conversazione: 2 query (V1 — sufficiente, no RPC)
    const now = new Date().toISOString();
    const { data: cur } = await supabase
      .from('conversations').select('unread_count').eq('id', conversationId).single();
    await supabase.from('conversations').update({
      last_message_at: now,
      last_inbound_at: now,
      unread_count: (cur?.unread_count ?? 0) + 1,
    }).eq('id', conversationId);

    await supabase.from('event_log').insert({
      type: 'twilio_inbound', payload: { sid: params.MessageSid, from: phone },
      message: `Inbound ricevuto da ${phone}`, level: 'info',
    });
  }

  return new NextResponse(TWIML_OK, { status: 200, headers: TWIML_HEADERS });
}
