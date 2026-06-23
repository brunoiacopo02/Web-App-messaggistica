import { redirect } from 'next/navigation';
import { getSupabaseServer } from '@/lib/supabase/server';
import { FeniceSidebar } from '@/components/FeniceSidebar';

export default async function FeniceLayout({ children }: { children: React.ReactNode }) {
  const supabase = await getSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  return (
    <div className="fenice-shell flex h-svh flex-col md:flex-row">
      <FeniceSidebar userEmail={user.email ?? ''} />
      <main className="min-w-0 flex-1 overflow-hidden">{children}</main>
    </div>
  );
}
