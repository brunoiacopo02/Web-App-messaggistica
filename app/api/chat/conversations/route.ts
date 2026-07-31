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
  gdo_video_sent_at: string | null;
  lead: { id: number; phone_e164: string | null; first_name: string | null; last_name: string | null } | null;
};

// Il perimetro conta ~2500 conversazioni: il limite(200) sotto taglia la ricerca fuori
// dalle più recenti. Con `q` valorizzato risolviamo prima gli id dei lead che
// corrispondono, poi filtriamo le conversazioni del perimetro su quegli id, senza
// passare dal limite. PostgREST wrappa il valore fra doppi apici per non spezzare
// l'espressione `.or()` se contiene virgole o parentesi.
async function leadIdsPerRicerca(
  supabase: Awaited<ReturnType<typeof getSupabaseServer>>,
  search: string,
): Promise<number[]> {
  const pattern = `"%${search.replace(/["\\]/g, '\\$&')}%"`;
  const { data } = await supabase
    .from('leads')
    .select('id')
    .or(`first_name.ilike.${pattern},last_name.ilike.${pattern},phone_e164.ilike.${pattern}`);
  return (data ?? []).map((l: { id: number }) => l.id);
}

export async function GET(req: Request) {
  const supabase = await getSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return new NextResponse('unauthorized', { status: 401 });

  const url = new URL(req.url);
  const filter = url.searchParams.get('filter'); // 'all'|'unread'|'recent'
  const search = url.searchParams.get('q')?.trim() ?? '';

  const feniceIds = await getFeniceCampaignIds(supabase);

  // Con `q` valorizzato risolviamo prima gli id dei lead che corrispondono, e filtriamo
  // le conversazioni su quegli id invece che sul limit(200) sotto — che con ~2500
  // conversazioni nel perimetro taglierebbe fuori un lead più vecchio delle 200 chat
  // più recenti. Nessun lead trovato ⇒ lista vuota: mai "tutte le conversazioni" (un
  // `in.()` vuoto su PostgREST sarebbe comunque SQL invalido).
  let leadIds: number[] | null = null;
  if (search) {
    leadIds = await leadIdsPerRicerca(supabase, search);
    if (leadIds.length === 0) return NextResponse.json({ data: [] });
  }

  let query = supabase
    .from('conversations')
    .select(`
      id, last_message_at, last_inbound_at, unread_count, campaign_id, last_message_preview,
      ai_owner, gdo_agenda_at, gdo_video_sent_at,
      lead:leads ( id, phone_e164, first_name, last_name )
    `)
    .order('last_message_at', { ascending: false });
  query = leadIds ? query.in('lead_id', leadIds) : query.limit(200);
  query = soloMondoFenice(query, feniceIds);

  if (filter === 'unread') query = query.gt('unread_count', 0);
  if (filter === 'recent') query = query.gte('last_message_at', new Date(Date.now() - 7 * 86400_000).toISOString());

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const out = ((data ?? []) as unknown as ConversationRow[]).map((c) => ({
    ...c,
    preview: c.last_message_preview ?? undefined,
    mondo: mondoDi(c),
  }));
  return NextResponse.json({ data: out });
}
