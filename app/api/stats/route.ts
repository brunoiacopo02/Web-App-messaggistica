import { NextResponse } from 'next/server';
import { getSupabaseServer } from '@/lib/supabase/server';

export const runtime = 'nodejs';

export async function GET() {
  const supabase = await getSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return new NextResponse('unauthorized', { status: 401 });

  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);

  const [todayOut, totalOut, unread, lastError, dailySeries, latestInbound] = await Promise.all([
    // Conteggi outbound del CRM: escludono il traffico di Mario (Fenice) via inner-join su ai_owner null.
    supabase.from('messages').select('id, conversations!inner(ai_owner)', { count: 'exact', head: true }).eq('direction', 'out').is('conversations.ai_owner', null).gte('created_at', startOfDay.toISOString()),
    supabase.from('messages').select('id, conversations!inner(ai_owner)', { count: 'exact', head: true }).eq('direction', 'out').is('conversations.ai_owner', null),
    supabase.from('conversations').select('unread_count').gt('unread_count', 0).is('ai_owner', null),
    supabase.from('event_log').select('*').eq('level', 'error').gte('created_at', new Date(Date.now() - 60 * 60_000).toISOString()).order('created_at', { ascending: false }).limit(1),
    supabase.from('messages').select('created_at, conversations!inner(ai_owner)').eq('direction', 'out').is('conversations.ai_owner', null).gte('created_at', new Date(Date.now() - 14 * 86400_000).toISOString()).order('created_at', { ascending: true }),
    supabase.from('messages').select(`
      id, body, created_at, conversation:conversations!inner(
        id, ai_owner, lead:leads(first_name, last_name, phone_e164)
      )
    `).eq('direction', 'in').order('created_at', { ascending: false }).limit(15),
  ]);

  // Escludi gli inbound delle chat di Mario (Fenice) dagli ultimi messaggi del CRM.
  const latestInboundCrm = (latestInbound.data ?? [])
    .filter((m: any) => (m.conversation?.ai_owner ?? null) === null)
    .slice(0, 5);

  // Daily series → conta per giorno (ultimi 14)
  const buckets: Record<string, number> = {};
  for (let i = 13; i >= 0; i--) {
    const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - i);
    buckets[d.toISOString().slice(0, 10)] = 0;
  }
  (dailySeries.data ?? []).forEach((m: any) => {
    const k = (new Date(m.created_at)).toISOString().slice(0, 10);
    if (k in buckets) buckets[k] += 1;
  });

  const unreadTotal = (unread.data ?? []).reduce((s, c: any) => s + (c.unread_count ?? 0), 0);

  return NextResponse.json({
    sentToday: todayOut.count ?? 0,
    sentTotal: totalOut.count ?? 0,
    unreadTotal,
    lastError: lastError.data?.[0] ?? null,
    daily: Object.entries(buckets).map(([date, count]) => ({ date, count })),
    latestInbound: latestInboundCrm,
  });
}
