import { NextRequest, NextResponse, after } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { validateTwilioSignature } from '@/lib/twilio';
import { toE164 } from '@/lib/phone';
import { checkRateLimit } from '@/lib/rate-limit';
import { getAutoReply } from '@/lib/fenice-settings';
import { shouldAutoReply, shouldReopen, drainMarioReplies } from '@/lib/fenice-autoreply';
import { isAudioInbound, transcribeTwilioAudio } from '@/lib/transcribe';
import { handleGdoDeliveryUpdate } from '@/lib/send-agenda-gdo';
import { sendCrmNota } from '@/lib/bot-outcome';
import { buildBotRipresoNote } from '@/lib/bot-outcome-rules';

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

    // Agenda GDO finita in "inviato" e poi consegnata davvero: il CRM va avvisato,
    // altrimenti quel lead resta per sempre in uno stato ambiguo col reinvio bloccato.
    // Dopo la risposta a Twilio: la callback non deve aspettare il loro endpoint.
    after(handleGdoDeliveryUpdate(supabase, { sid: params.MessageSid, status: params.MessageStatus }));
    return new NextResponse(TWIML_OK, { status: 200, headers: TWIML_HEADERS });
  }

  // Inbound message (testo o nota vocale)
  if (params.MessageSid && params.From && (params.Body !== undefined || isAudioInbound(params))) {
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

    // Nota vocale → trascrivi in testo così Mario (e l'inbox) la leggono come messaggio.
    let messageBody = params.Body ?? '';
    if ((!messageBody || messageBody.trim() === '') && isAudioInbound(params)) {
      const transcript = await transcribeTwilioAudio(params.MediaUrl0 ?? '', params.MediaContentType0 ?? '');
      messageBody = transcript ?? '[nota vocale]';
      await supabase.from('event_log').insert({
        type: transcript ? 'voice_transcribed' : 'voice_transcribe_failed',
        payload: { from: phone, contentType: params.MediaContentType0 } as never,
        message: transcript
          ? `Nota vocale trascritta da ${phone}`
          : `Trascrizione nota vocale non riuscita da ${phone}`,
        level: transcript ? 'info' : 'warn',
      });
    }

    // Insert messaggio (UNIQUE su twilio_sid → dedup retry)
    const { error: msgErr } = await supabase.from('messages').insert({
      conversation_id: conversationId,
      direction: 'in',
      body: messageBody,
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
      // Numero aziendale su cui il lead ci scrive: le risposte devono partire
      // dallo stesso numero (la finestra 24h vale per coppia numero/utente).
      ...(params.To?.startsWith('whatsapp:') ? { wa_number: params.To } : {}),
    }).eq('id', conversationId);

    await supabase.from('event_log').insert({
      type: 'twilio_inbound', payload: { sid: params.MessageSid, from: phone },
      message: `Inbound ricevuto da ${phone}`, level: 'info',
    });

    // Auto-risposta Mario (solo numero Fenice + lead arruolato + switch ON)
    const feniceNumber = process.env.TWILIO_WHATSAPP_NUMBER_FENICE;
    const toMatchesFenice = !!feniceNumber && (params.To ?? '') === feniceNumber;
    if (toMatchesFenice) {
      const { data: conv } = await supabase
        .from('conversations')
        .select('ai_owner, ai_status, ai_paused_at, crm_lead_id, bot_outcome')
        .eq('id', conversationId)
        .single();

      if (conv && shouldReopen({ aiOwner: conv.ai_owner, aiStatus: conv.ai_status, aiPausedAt: conv.ai_paused_at })) {
        await supabase.from('conversations').update({ ai_status: 'active' }).eq('id', conversationId);
        conv.ai_status = 'active';
        // Il lead era già stato restituito al CRM e ha riscritto: da adesso il bot e i
        // GDO lavorano la stessa persona. Avvisarli è l'unico modo perché non chiamino
        // a vuoto (caso Marina Destefanis). APPUNTAMENTO è escluso: lì il lead è già in
        // agenda e la riapertura ha il suo canale, le note del lead terminale.
        // Dopo la risposta a Twilio: la loro rete non deve rallentare il webhook.
        if (conv.crm_lead_id && conv.bot_outcome && conv.bot_outcome !== 'APPUNTAMENTO') {
          after(
            sendCrmNota(
              supabase,
              conversationId,
              buildBotRipresoNote({ esitoPrecedente: conv.bot_outcome, quandoIso: new Date().toISOString() }),
            ),
          );
        }
      }

      const autoReplyOn = await getAutoReply(supabase);
      if (shouldAutoReply({
        toMatchesFenice,
        autoReplyOn,
        aiOwner: conv?.ai_owner ?? null,
        aiStatus: conv?.ai_status ?? null,
        aiPausedAt: conv?.ai_paused_at ?? null,
      })) {
        // Dopo aver risposto 200 a Twilio: Mario risponde in background, con latenza.
        after(drainMarioReplies(supabase, conversationId, phone));
      }
    }
  }

  return new NextResponse(TWIML_OK, { status: 200, headers: TWIML_HEADERS });
}
