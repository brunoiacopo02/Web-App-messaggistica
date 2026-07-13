import { getSupabaseServer } from '@/lib/supabase/server';
import { ConversationList } from '@/components/ConversationList';
import { getFeniceCampaignIds } from '@/lib/campagne';

export const dynamic = 'force-dynamic';

// La lista conversazioni vive nel layout: resta montata navigando tra le chat,
// così il filtro selezionato (es. "Non lette") non si resetta. Mirror di
// (app)/inbox/layout.tsx ma ristretto alle sole campagne di proprietà Fenice.
export default async function CampagneChatLayout({ children }: { children: React.ReactNode }) {
  const supabase = await getSupabaseServer();
  const feniceIds = await getFeniceCampaignIds(supabase);
  const { data } = feniceIds.length === 0
    ? { data: [] as unknown[] }
    : await supabase
        .from('conversations')
        .select(`
          id, last_message_at, last_inbound_at, unread_count, last_message_preview,
          lead:leads ( id, phone_e164, first_name, last_name )
        `)
        .in('campaign_id', feniceIds)
        .order('last_message_at', { ascending: false })
        .limit(200);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const initial = (data ?? []).map((c: any) => ({ ...c, preview: c.last_message_preview ?? undefined }));

  return (
    <div className="flex h-full">
      <ConversationList
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        initial={initial as any}
        apiPath="/api/campagne-chat/conversations"
        basePath="/campagne-chat"
        channelName="campagne-list"
      />
      {children}
    </div>
  );
}
