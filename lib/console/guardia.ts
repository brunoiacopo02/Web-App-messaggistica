import { NextResponse } from 'next/server';
import { getSupabaseServer } from '@/lib/supabase/server';
import { puoUsareConsole } from '@/lib/access';

/**
 * Guardia comune delle rotte `/api/console/*`: 401 senza sessione, 403 se l'account non
 * è nell'area `all` (l'unica nozione di "admin" del repo, vedi `lib/access.ts`).
 */
export async function richiediAdmin(): Promise<{ ok: true; email: string } | { ok: false; risposta: Response }> {
  const s = await getSupabaseServer();
  const {
    data: { user },
  } = await s.auth.getUser();
  if (!user) return { ok: false, risposta: new NextResponse('unauthorized', { status: 401 }) };
  if (!puoUsareConsole(user.email)) {
    return { ok: false, risposta: NextResponse.json({ error: 'solo_admin' }, { status: 403 }) };
  }
  return { ok: true, email: user.email! };
}
