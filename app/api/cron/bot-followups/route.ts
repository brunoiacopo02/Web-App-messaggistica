import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { sendOutcome } from '@/lib/bot-outcome';
import { decideFollowupAction } from '@/lib/bot-followups';
import { drainMarioReplies, lastIsUnansweredInbound } from '@/lib/fenice-autoreply';

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
  const now = Date.now();

  // Conversazioni CRM-linked, attive, non chiuse.
  const { data: convs } = await supabase
    .from('conversations')
    .select('id, ai_status, ai_started_at, crm_lead_id, leads(phone_e164)')
    .not('crm_lead_id', 'is', null)
    .in('ai_status', ['active', 'replying'])
    .limit(500);

  const report: Record<string, unknown>[] = [];

  for (const c of (convs ?? []) as any[]) {
    try {
      const phone = c.leads?.phone_e164 as string | undefined;

      // 1. Carica la cronologia messaggi dall'arruolamento in poi.
      let q = supabase
        .from('messages')
        .select('direction, body, created_at')
        .eq('conversation_id', c.id)
        .order('created_at', { ascending: true })
        .limit(200);
      if (c.ai_started_at) q = q.gte('created_at', c.ai_started_at);
      const { data: msgData } = await q;
      const rows = (msgData ?? []) as { direction: string; body: string; created_at: string }[];

      // 2. Rete di sicurezza: re-drive se c'è un inbound senza risposta.
      if (lastIsUnansweredInbound(rows)) {
        if (!phone) {
          report.push({ id: c.id, action: 'redrive', skipped: true, reason: 'no_from' });
          continue;
        }
        // delayMs = () => 0: il lead ha già aspettato, salta la finestra di accorpamento.
        await drainMarioReplies(supabase, c.id, phone, () => 0);
        report.push({ id: c.id, action: 'redrive' });
        continue;
      }

      // 3. Classificazione CRM (NON_RISPOSTO / INTERROTTO).
      const startedAtMs = c.ai_started_at ? Date.parse(c.ai_started_at) : null;
      if (!startedAtMs) continue;

      const hasInbound = rows.some((r) => r.direction === 'in');
      const lastInboundAtMs =
        rows.reduceRight<number | null>((acc, r) => {
          if (acc !== null) return acc;
          return r.direction === 'in' ? Date.parse(r.created_at) : null;
        }, null);

      const action = decideFollowupAction({ startedAtMs, nowMs: now, hasInbound, lastInboundAtMs });

      if (action === 'non_risposto') {
        await sendOutcome(supabase, c.id, { outcome: 'NON_RISPOSTO', note: 'Nessuna risposta.' });
        report.push({ id: c.id, action });
      } else if (action === 'interrotto') {
        await sendOutcome(supabase, c.id, { outcome: 'INTERROTTO', note: 'Chat interrotta senza obiezione, riassegnare a operatore.' });
        report.push({ id: c.id, action });
      }
      // action === 'none': niente da fare
    } catch (e) {
      await supabase.from('event_log').insert({
        type: 'bot_followup_error',
        payload: { conversationId: c.id, error: e instanceof Error ? e.message : 'errore' } as never,
        message: `[bot-fissatore] errore su conv ${c.id}: ${e instanceof Error ? e.message : 'errore'}`,
        level: 'error',
      });
    }
  }

  await supabase.from('event_log').insert({
    type: 'bot_followups_run',
    payload: { count: report.length } as never,
    message: `[bot-fissatore] cron backstop: ${report.length} azioni`,
    level: 'info',
  });

  return NextResponse.json({ ok: true, actions: report });
}
