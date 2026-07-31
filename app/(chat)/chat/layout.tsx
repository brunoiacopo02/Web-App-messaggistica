import { getSupabaseServer } from '@/lib/supabase/server';
import { ConversationList } from '@/components/ConversationList';
import { getFeniceCampaignIds } from '@/lib/campagne';
import { soloMondoFenice, mondoDi } from '@/lib/chat-perimetro';

export const dynamic = 'force-dynamic';

// La lista vive nel layout: resta montata navigando tra le chat, così il filtro
// selezionato non si resetta. Mirror di (campagne)/campagne-chat/layout.tsx.
export default async function ChatListLayout({ children }: { children: React.ReactNode }) {
  const supabase = await getSupabaseServer();
  const feniceIds = await getFeniceCampaignIds(supabase);

  let query = supabase
    .from('conversations')
    .select(`
      id, last_message_at, last_inbound_at, unread_count, last_message_preview,
      ai_owner, gdo_agenda_at,
      lead:leads ( id, phone_e164, first_name, last_name )
    `)
    .order('last_message_at', { ascending: false })
    .limit(200);
  query = soloMondoFenice(query, feniceIds);
  const { data } = await query;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const initial = (data ?? []).map((c: any) => ({
    ...c,
    preview: c.last_message_preview ?? undefined,
    mondo: mondoDi(c),
  }));

  return (
    <div className="flex h-full">
      <ConversationList
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        initial={initial as any}
        apiPath="/api/chat/conversations"
        basePath="/chat"
        channelName="chat-list"
      />
      {children}
    </div>
  );
}
