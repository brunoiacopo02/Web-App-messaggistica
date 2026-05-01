import { getSupabaseServer } from '@/lib/supabase/server';
import { StatCard } from '@/components/StatCard';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatRelativeShort } from '@/lib/utils';
import Link from 'next/link';
import { DashboardChart } from './_components/DashboardChart';

export const dynamic = 'force-dynamic';

async function fetchStats() {
  const supabase = await getSupabaseServer();
  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);

  const [todayOut, totalOut, unreadConv, lastError, daily, latest] = await Promise.all([
    supabase.from('messages').select('id', { count: 'exact', head: true }).eq('direction', 'out').gte('created_at', startOfDay.toISOString()),
    supabase.from('messages').select('id', { count: 'exact', head: true }).eq('direction', 'out'),
    supabase.from('conversations').select('unread_count').gt('unread_count', 0),
    supabase.from('event_log').select('*').eq('level', 'error').gte('created_at', new Date(Date.now() - 3600_000).toISOString()).order('created_at', { ascending: false }).limit(1),
    supabase.from('messages').select('created_at').eq('direction', 'out').gte('created_at', new Date(Date.now() - 14 * 86400_000).toISOString()),
    supabase.from('messages').select(`
      id, body, created_at, conversation:conversations!inner(
        id, lead:leads(first_name, last_name, phone_e164)
      )
    `).eq('direction', 'in').order('created_at', { ascending: false }).limit(5),
  ]);

  const unreadTotal = (unreadConv.data ?? []).reduce((s: number, c: any) => s + (c.unread_count ?? 0), 0);

  const buckets: Record<string, number> = {};
  for (let i = 13; i >= 0; i--) {
    const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - i);
    buckets[d.toISOString().slice(0, 10)] = 0;
  }
  (daily.data ?? []).forEach((m: any) => {
    const k = (new Date(m.created_at)).toISOString().slice(0, 10);
    if (k in buckets) buckets[k] += 1;
  });

  return {
    sentToday: todayOut.count ?? 0,
    sentTotal: totalOut.count ?? 0,
    unreadTotal,
    lastError: lastError.data?.[0] ?? null,
    daily: Object.entries(buckets).map(([date, count]) => ({ date, count })),
    latestInbound: latest.data ?? [],
  };
}

export default async function DashboardPage() {
  const stats = await fetchStats();
  const ok = !stats.lastError;
  return (
    <div className="p-6 space-y-6 overflow-auto h-full">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <StatCard title="Inviati oggi" value={stats.sentToday} />
        <StatCard title="Inviati totali" value={stats.sentTotal} />
        <StatCard title="Non lette" value={stats.unreadTotal} href="/inbox" accent="green" />
      </div>

      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle className="text-base">Stato sistema</CardTitle>
          <span className={`size-3 rounded-full ${ok ? 'bg-emerald-500' : 'bg-red-500'}`} />
        </CardHeader>
        <CardContent>
          {ok
            ? <p className="text-sm text-zinc-500">Nessun errore nell'ultima ora.</p>
            : <p className="text-sm text-red-600">{(stats.lastError as any)?.message}</p>}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="lg:col-span-2">
          <CardHeader><CardTitle className="text-base">Invii ultimi 14 giorni</CardTitle></CardHeader>
          <CardContent><DashboardChart data={stats.daily} /></CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-base">Ultime risposte</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {stats.latestInbound.length === 0 && <p className="text-sm text-zinc-500">Nessuna risposta ancora.</p>}
            {stats.latestInbound.map((m: any) => (
              <Link key={m.id} href={`/inbox/${m.conversation.id}`} className="block text-sm hover:bg-zinc-50 dark:hover:bg-zinc-900 p-2 rounded-md">
                <div className="flex justify-between">
                  <span className="font-medium truncate">
                    {m.conversation.lead?.first_name ?? m.conversation.lead?.phone_e164}
                  </span>
                  <span className="text-zinc-500 text-xs">{formatRelativeShort(m.created_at)}</span>
                </div>
                <div className="text-zinc-500 truncate">{m.body}</div>
              </Link>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
