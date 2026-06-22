import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseServer } from '@/lib/supabase/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { segmentOf, type LeadSegment } from '@/lib/lead-segments';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function requireUser() {
  const authed = await getSupabaseServer();
  const { data: { user } } = await authed.auth.getUser();
  return user;
}

function periodStartIso(period: string): string | null {
  if (period === '7') return new Date(Date.now() - 7 * 86400_000).toISOString();
  if (period === '30') return new Date(Date.now() - 30 * 86400_000).toISOString();
  return null;
}

export async function GET(req: NextRequest) {
  if (!(await requireUser())) return new NextResponse('unauthorized', { status: 401 });

  const period = req.nextUrl.searchParams.get('period') ?? 'all';
  const now = new Date().toISOString();
  const admin = getSupabaseAdmin();

  let query = admin
    .from('conversations')
    .select('ai_status, bot_outcome, last_inbound_at, crm_funnel, created_at')
    .eq('ai_owner', 'mario')
    .limit(5000);
  const since = periodStartIso(period);
  if (since) query = query.gte('created_at', since);

  const { data, error } = await query;
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  const bySegment = { PRESO: 0, MAI_RISPOSTO: 0, ATTIVA: 0, FERMA: 0 } as Record<LeadSegment, number>;
  const funnelMap = new Map<string, { total: number; presi: number }>();

  for (const c of (data ?? []) as any[]) {
    const seg = segmentOf({ bot_outcome: c.bot_outcome ?? null, last_inbound_at: c.last_inbound_at ?? null, ai_status: c.ai_status ?? null }, now);
    bySegment[seg]++;
    const funnel = (c.crm_funnel ?? '—') as string;
    const f = funnelMap.get(funnel) ?? { total: 0, presi: 0 };
    f.total++;
    if (seg === 'PRESO') f.presi++;
    funnelMap.set(funnel, f);
  }

  const total = bySegment.PRESO + bySegment.MAI_RISPOSTO + bySegment.ATTIVA + bySegment.FERMA;
  const presi = bySegment.PRESO;
  const nonPresi = total - presi;
  const byFunnel = [...funnelMap.entries()].map(([funnel, v]) => ({ funnel, total: v.total, presi: v.presi }))
    .sort((a, b) => b.total - a.total);

  return NextResponse.json({
    ok: true, period, total, presi, nonPresi,
    conversionRate: total ? presi / total : 0,
    maiRisposto: bySegment.MAI_RISPOSTO,
    maiRispostoShareOfNonPresi: nonPresi ? bySegment.MAI_RISPOSTO / nonPresi : 0,
    bySegment, byFunnel,
  });
}
