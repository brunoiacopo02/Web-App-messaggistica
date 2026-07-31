import { NextResponse } from 'next/server';
import { getSupabaseServer } from '@/lib/supabase/server';
import { getFeniceCampaignIds } from '@/lib/campagne';
import { soloMondoFenice, mondoDi } from '@/lib/chat-perimetro';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type ConversationRow = {
  id: number;
  last_message_at: string | null;
  last_inbound_at: string | null;
  unread_count: number | null;
  campaign_id: number | null;
  last_message_preview: string | null;
  ai_owner: string | null;
  gdo_agenda_at: string | null;
  lead: { id: number; phone_e164: string | null; first_name: string | null; last_name: string | null } | null;
};

export async function GET(req: Request) {
  const supabase = await getSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return new NextResponse('unauthorized', { status: 401 });

  const url = new URL(req.url);
  const filter = url.searchParams.get('filter'); // 'all'|'unread'|'recent'
  const search = url.searchParams.get('q')?.trim() ?? '';

  const feniceIds = await getFeniceCampaignIds(supabase);

  let query = supabase
    .from('conversations')
    .select(`
      id, last_message_at, last_inbound_at, unread_count, campaign_id, last_message_preview,
      ai_owner, gdo_agenda_at,
      lead:leads ( id, phone_e164, first_name, last_name )
    `)
    .order('last_message_at', { ascending: false })
    .limit(200);
  query = soloMondoFenice(query, feniceIds);

  if (filter === 'unread') query = query.gt('unread_count', 0);
  if (filter === 'recent') query = query.gte('last_message_at', new Date(Date.now() - 7 * 86400_000).toISOString());

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // La ricerca è client-side sul risultato, come in /api/conversations.
  const filtered = !search
    ? ((data ?? []) as unknown as ConversationRow[])
    : ((data ?? []) as unknown as ConversationRow[]).filter((c) => {
        const s = search.toLowerCase();
        return (c.lead?.first_name ?? '').toLowerCase().includes(s)
          || (c.lead?.last_name ?? '').toLowerCase().includes(s)
          || (c.lead?.phone_e164 ?? '').toLowerCase().includes(s);
      });

  const out = filtered.map((c) => ({
    ...c,
    preview: c.last_message_preview ?? undefined,
    mondo: mondoDi(c),
  }));
  return NextResponse.json({ data: out });
}
