import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { sendOutcome } from '@/lib/bot-outcome';
import { decideFollowupAction } from '@/lib/bot-followups';
import { drainMarioReplies, lastIsUnansweredInbound, isOrphanedReplyingLock, REPLYING_ORPHAN_MS } from '@/lib/fenice-autoreply';
import { runAgendaFollowups } from '@/lib/agenda-followup';

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
    .select('id, ai_status, ai_started_at, crm_lead_id, bot_outcome, leads(phone_e164)')
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
        // Calcola l'istante dell'ultimo inbound (lastIsUnansweredInbound è true,
        // quindi rows[rows.length-1] è un inbound).
        const lastInboundAtMs = Date.parse(rows[rows.length - 1].created_at);

        if (isOrphanedReplyingLock(c.ai_status, lastInboundAtMs, now)) {
          // Lock orfano: reset CAS sicuro. Se nel frattempo un drain reale ha
          // cambiato stato, il reset non scatta.
          await supabase
            .from('conversations')
            .update({ ai_status: 'active' })
            .eq('id', c.id)
            .eq('ai_status', 'replying');
        }
        // Il lead ha già aspettato, salta la finestra di accorpamento.
        await drainMarioReplies(supabase, c.id, phone, () => 0);
        report.push({ id: c.id, action: 'redrive' });
        continue;
      }

      // 2b. Lead terminale (APPUNTAMENTO) senza inbound in sospeso: mai
      // riclassificare. La riga è stata riaperta dal webhook: richiudila per
      // farla uscire dal giro del cron (risana anche le righe già incastrate).
      if (c.bot_outcome === 'APPUNTAMENTO') {
        if (c.ai_status === 'active') {
          await supabase
            .from('conversations')
            .update({ ai_status: 'closed' })
            .eq('id', c.id)
            .eq('ai_status', 'active');
          report.push({ id: c.id, action: 'close_terminal' });
        }
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

      // phone non serve qui: sendOutcome fa solo callback CRM, non invia WhatsApp.
      const action = decideFollowupAction({ startedAtMs, nowMs: now, hasInbound, lastInboundAtMs, botOutcome: c.bot_outcome });

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

  // Follow-up agenda (singolo, idempotente) a chi ha ricevuto l'agenda e non ha preso.
  let agendaFollowup = { sent: 0, skipped: 0 };
  try {
    agendaFollowup = await runAgendaFollowups(supabase, new Date(now));
  } catch (e) {
    await supabase.from('event_log').insert({
      type: 'agenda_followup_error',
      payload: { error: e instanceof Error ? e.message : 'errore' } as never,
      message: `[bot-fissatore] errore follow-up agenda: ${e instanceof Error ? e.message : 'errore'}`,
      level: 'error',
    });
  }

  await supabase.from('event_log').insert({
    type: 'bot_followups_run',
    payload: { count: report.length } as never,
    message: `[bot-fissatore] cron backstop: ${report.length} azioni`,
    level: 'info',
  });

  return NextResponse.json({ ok: true, actions: report, agendaFollowup });
}
