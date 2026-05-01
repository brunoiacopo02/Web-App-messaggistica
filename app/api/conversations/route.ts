import { NextResponse } from 'next/server';
import { getSupabaseServer } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const supabase = await getSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return new NextResponse('unauthorized', { status: 401 });

  const url = new URL(req.url);
  const filter = url.searchParams.get('filter'); // 'all'|'unread'|'recent'
  const search = url.searchParams.get('q')?.trim() ?? '';

  let query = supabase
    .from('conversations')
    .select(`
      id, last_message_at, last_inbound_at, unread_count, campaign_id,
      lead:leads ( id, phone_e164, first_name, last_name, email )
    `)
    .order('last_message_at', { ascending: false })
    .limit(200);

  if (filter === 'unread') query = query.gt('unread_count', 0);
  if (filter === 'recent') query = query.gte('last_message_at', new Date(Date.now() - 7 * 86400_000).toISOString());

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Filter client-side per search (su nome/numero)
  const filtered = !search
    ? data
    : (data ?? []).filter((c: any) => {
        const fn = (c.lead?.first_name ?? '').toLowerCase();
        const ln = (c.lead?.last_name ?? '').toLowerCase();
        const ph = (c.lead?.phone_e164 ?? '').toLowerCase();
        const s = search.toLowerCase();
        return fn.includes(s) || ln.includes(s) || ph.includes(s);
      });

  return NextResponse.json({ data: filtered });
}
