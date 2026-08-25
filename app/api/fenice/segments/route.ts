import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseServer } from '@/lib/supabase/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { fetchAllRows } from '@/lib/supabase/paginate';
import { segmentOf, fermaReason, type LeadSegment } from '@/lib/lead-segments';

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

  const sp = req.nextUrl.searchParams;
  const segment = sp.get('segment') as LeadSegment | null;
  const period = sp.get('period') ?? 'all';
  const q = (sp.get('q') ?? '').trim().toLowerCase();
  const now = new Date().toISOString();

  const admin = getSupabaseAdmin();
  // Paginato: al tetto di 1.000 righe i conteggi per segmento erano tagliati e le
  // conversazioni più vecchie sparivano dall'elenco senza dirlo.
  const since = periodStartIso(period);
  let data: any[];
  try {
    data = await fetchAllRows<any>((from, to) => {
      let q = admin
        .from('conversations')
        .select('id, ai_status, bot_outcome, bot_scheduled_at, last_message_at, last_inbound_at, created_at, leads(phone_e164, first_name, last_name)')
        .eq('ai_owner', 'mario')
        .order('last_message_at', { ascending: false })
        .order('id', { ascending: false })
        .range(from, to);
      if (since) q = q.gte('created_at', since);
      return q;
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : 'errore' }, { status: 500 });
  }

  const counts = { PRESO: 0, MAI_RISPOSTO: 0, ATTIVA: 0, FERMA: 0, total: 0 };
  const rows: Array<{ id: number; phone: string; name: string; segment: LeadSegment; reason: string | null; lastMessageAt: string; lastInboundAt: string | null; status: string | null; scheduledAt: string | null }> = [];

  for (const c of data) {
    const input = { bot_outcome: c.bot_outcome ?? null, last_inbound_at: c.last_inbound_at ?? null, ai_status: c.ai_status ?? null };
    const seg = segmentOf(input, now);
    counts[seg]++;
    counts.total++;

    const phone = c.leads?.phone_e164 ?? '';
    const name = [c.leads?.first_name, c.leads?.last_name].filter(Boolean).join(' ');
    if (segment && seg !== segment) continue;
    if (q && !(`${phone} ${name}`.toLowerCase().includes(q))) continue;

    rows.push({
      id: c.id, phone, name, segment: seg,
      reason: fermaReason(input, now),
      lastMessageAt: c.last_message_at, lastInboundAt: c.last_inbound_at ?? null,
      status: c.ai_status ?? null,
      scheduledAt: c.bot_scheduled_at ?? null,
    });
  }

  return NextResponse.json({ ok: true, counts, rows });
}
