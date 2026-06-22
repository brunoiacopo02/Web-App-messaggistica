import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { segmentOf } from '@/lib/lead-segments';
import { extractLeadInsight, aggregateInsights, type LeadInsight, type ObjectionCategory } from '@/lib/lead-analysis';
import type { MarioTurn } from '@/lib/mario';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const MAX_PER_RUN = 40;

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  if (req.headers.get('authorization') === `Bearer ${secret}`) return true;
  if (req.nextUrl.searchParams.get('secret') === secret) return true;
  return false;
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return new NextResponse('unauthorized', { status: 401 });

  const admin = getSupabaseAdmin();
  const now = new Date().toISOString();

  // Tutte le conversazioni Mario per conteggi + selezione estrazioni
  const { data: convs, error } = await admin
    .from('conversations')
    .select('id, ai_status, bot_outcome, last_inbound_at, last_message_at, ai_started_at, ai_insight_at, ai_dropoff_stage, ai_objection_category, ai_objection_note')
    .eq('ai_owner', 'mario')
    .limit(5000);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  const respondedNotTaken = (convs ?? []).filter((c: any) =>
    c.last_inbound_at && c.bot_outcome !== 'APPUNTAMENTO');
  const maiRisposto = (convs ?? []).filter((c: any) =>
    segmentOf({ bot_outcome: c.bot_outcome ?? null, last_inbound_at: c.last_inbound_at ?? null, ai_status: c.ai_status ?? null }, now) === 'MAI_RISPOSTO').length;

  // Selezione da (ri)analizzare
  const stale = respondedNotTaken.filter((c: any) =>
    !c.ai_insight_at || (c.last_message_at && c.last_message_at > c.ai_insight_at)).slice(0, MAX_PER_RUN);

  let extracted = 0;
  for (const c of stale as any[]) {
    const { data: msgs } = await admin
      .from('messages')
      .select('direction, body, created_at')
      .eq('conversation_id', c.id)
      .gte('created_at', c.ai_started_at ?? '1970-01-01')
      .order('created_at', { ascending: true })
      .limit(200);
    const history: MarioTurn[] = (msgs ?? []).map((m: any) => ({ role: m.direction === 'in' ? 'user' : 'assistant', content: m.body }));
    if (history.length === 0) continue;
    try {
      const insight = await extractLeadInsight(history);
      await admin.from('conversations').update({
        ai_dropoff_stage: insight.dropoffStage,
        ai_objection_category: insight.objectionCategory,
        ai_objection_note: insight.objectionNote,
        ai_insight_at: new Date().toISOString(),
      }).eq('id', c.id);
      extracted++;
    } catch { /* salta questa conversazione, riprova al prossimo run */ }
  }

  // Rileggi gli insight in cache (dopo gli update) per l'aggregato
  const { data: cached } = await admin
    .from('conversations')
    .select('ai_dropoff_stage, ai_objection_category, ai_objection_note, last_inbound_at, bot_outcome')
    .eq('ai_owner', 'mario')
    .not('ai_insight_at', 'is', null);

  const insights: LeadInsight[] = (cached ?? [])
    .filter((c: any) => c.last_inbound_at && c.bot_outcome !== 'APPUNTAMENTO' && c.ai_objection_category)
    .map((c: any) => ({
      dropoffStage: c.ai_dropoff_stage ?? 'non chiaro',
      objectionCategory: (c.ai_objection_category ?? 'altro') as ObjectionCategory,
      objectionNote: c.ai_objection_note ?? '',
    }));

  const report = await aggregateInsights({ insights, maiRisposto, respondedNotTaken: respondedNotTaken.length });

  await admin.from('lead_analysis_reports').insert({ period: 'all', payload: report as any });
  await admin.from('event_log').insert({
    type: 'lead_analysis', level: 'info',
    message: `analisi lead: ${extracted} estratti, ${insights.length} in aggregato`,
    payload: { extracted, insights: insights.length, capped: stale.length === MAX_PER_RUN },
  });

  return NextResponse.json({ ok: true, extracted, aggregated: insights.length, capped: stale.length === MAX_PER_RUN });
}
