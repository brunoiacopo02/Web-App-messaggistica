import { getSupabaseServer } from '@/lib/supabase/server';
import { signOutAction } from '@/app/(auth)/login/actions';
import { ThemeToggle } from '@/components/ThemeToggle';
import { MessagesSquare } from 'lucide-react';

export const dynamic = 'force-dynamic';

// Shell minima per l'utenza dedicata alle chat delle campagne Fenice: solo header,
// niente sidebar completa (a differenza di (app) e (fenice)). L'accesso è già
// gestito dal proxy, quindi qui non serve redirect logic.
export default async function CampagneLayout({ children }: { children: React.ReactNode }) {
  const supabase = await getSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  return (
    <div className="flex h-svh flex-col">
      <header className="flex items-center justify-between border-b px-4 py-2">
        <div className="flex items-center gap-2 font-medium">
          <MessagesSquare className="size-5 text-amber-600" />
          Chat campagne · Fenice Academy
        </div>
        <div className="flex items-center gap-3 text-xs text-zinc-500">
          <span className="truncate max-w-48" title={user?.email ?? ''}>{user?.email}</span>
          <ThemeToggle />
          <form action={signOutAction}>
            <button type="submit" className="text-red-600 hover:underline">Esci</button>
          </form>
        </div>
      </header>
      <div className="flex-1 min-h-0">{children}</div>
    </div>
  );
}
