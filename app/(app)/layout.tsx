import { redirect } from 'next/navigation';
import { getSupabaseServer } from '@/lib/supabase/server';
import { Sidebar } from '@/components/Sidebar';
import { RealtimeProvider } from '@/components/RealtimeProvider';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = await getSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: convs } = await supabase
    .from('conversations')
    .select('unread_count')
    .gt('unread_count', 0);
  const unread = (convs ?? []).reduce(
    (s: number, c: any) => s + (c.unread_count ?? 0),
    0,
  );

  return (
    <div className="flex h-svh">
      <Sidebar unreadCount={unread} userEmail={user.email ?? ''} />
      <main className="flex-1 overflow-hidden">
        <RealtimeProvider>{children}</RealtimeProvider>
      </main>
    </div>
  );
}
