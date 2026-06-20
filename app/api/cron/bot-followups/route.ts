import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { sendFreeText } from '@/lib/twilio';
import { sendOutcome } from '@/lib/bot-outcome';
import { decideFollowupAction, FOLLOWUP_TEXTS } from '@/lib/bot-followups';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  if (req.headers.get('authorization') === `Bearer ${secret}`) return true;
  if (req.nextUrl.searchParams.get('secret') === secret) return true;
  return false;
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return new NextResponse('unauthorized', { status: 401 });

  const supabase = getSupabaseAdmin();
  const from = process.env.TWILIO_WHATSAPP_NUMBER_FENICE;
  const now = Date.now();

  // Conversazioni CRM-linked, attive, non chiuse.
  const { data: convs } = await supabase
    .from('conversations')
    .select('id, ai_status, ai_started_at, last_inbound_at, bot_followups_sent, crm_lead_id, leads(phone_e164)')
    .not('crm_lead_id', 'is', null)
    .in('ai_status', ['active', 'replying'])
    .limit(500);

  const report: Record<string, unknown>[] = [];

  for (const c of (convs ?? []) as any[]) {
    const startedAt = c.ai_started_at ? Date.parse(c.ai_started_at) : null;
    if (!startedAt) continue;
    const hasInbound = !!c.last_inbound_at && Date.parse(c.last_inbound_at) >= startedAt;
    const action = decideFollowupAction({
      startedAtMs: startedAt, nowMs: now, followupsSent: c.bot_followups_sent ?? 0, hasInbound,
    });
    if (action === 'none') continue;

    const phone = c.leads?.phone_e164 as string | undefined;

    if (action === 'non_risposto') {
      await sendOutcome(supabase, c.id, { outcome: 'NON_RISPOSTO', note: 'Nessuna risposta dopo i solleciti.' });
      report.push({ id: c.id, action });
      continue;
    }

    // sollecito_1 | sollecito_2: invia il nudge e incrementa il contatore.
    const idx = action === 'sollecito_1' ? 0 : 1;
    if (phone && from) {
      try {
        const sent = await sendFreeText({ to: phone, body: FOLLOWUP_TEXTS[idx], from });
        await supabase.from('messages').insert({
          conversation_id: c.id, direction: 'out', body: FOLLOWUP_TEXTS[idx],
          twilio_sid: sent.sid, twilio_status: sent.status,
        });
        await supabase.from('conversations')
          .update({ bot_followups_sent: idx + 1, last_message_at: new Date().toISOString() })
          .eq('id', c.id);
        report.push({ id: c.id, action, sent: true });
      } catch (e) {
        await supabase.from('event_log').insert({
          type: 'bot_followup_error',
          payload: { conversationId: c.id, error: e instanceof Error ? e.message : 'errore' } as never,
          message: `[bot-fissatore] sollecito fallito conv ${c.id}`,
          level: 'error',
        });
        report.push({ id: c.id, action, sent: false });
      }
    } else {
      // Numero non configurato (es. numero WhatsApp bloccato): NON avanzare il contatore,
      // così non spingiamo il lead verso NON_RISPOSTO senza averlo mai contattato.
      report.push({ id: c.id, action, sent: false, reason: 'no_from_skipped' });
    }
  }

  await supabase.from('event_log').insert({
    type: 'bot_followups_run',
    payload: { count: report.length } as never,
    message: `[bot-fissatore] cron solleciti: ${report.length} azioni`,
    level: 'info',
  });

  return NextResponse.json({ ok: true, actions: report });
}
