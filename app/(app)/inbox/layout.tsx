import { getSupabaseServer } from '@/lib/supabase/server';
import { ConversationList } from '@/components/ConversationList';

export const dynamic = 'force-dynamic';

// La lista conversazioni vive nel layout: resta montata navigando tra le chat,
// così il filtro selezionato (es. "Non lette") non si resetta.
export default async function InboxLayout({ children }: { children: React.ReactNode }) {
  const supabase = await getSupabaseServer();
  const { data } = await supabase
    .from('conversations')
    .select(`
      id, last_message_at, last_inbound_at, unread_count, last_message_preview,
      lead:leads ( id, phone_e164, first_name, last_name )
    `)
    .order('last_message_at', { ascending: false })
    .limit(200);

  const initial = (data ?? []).map((c: any) => ({ ...c, preview: c.last_message_preview ?? undefined }));

  return (
    <div className="flex h-full">
      <ConversationList initial={initial as any} />
      {children}
    </div>
  );
}
