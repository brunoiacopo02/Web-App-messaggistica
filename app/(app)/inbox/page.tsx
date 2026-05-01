import { getSupabaseServer } from '@/lib/supabase/server';
import { ConversationList } from '@/components/ConversationList';
import { Inbox } from 'lucide-react';

export const dynamic = 'force-dynamic';

export default async function InboxPage() {
  const supabase = await getSupabaseServer();
  const { data } = await supabase.from('conversations')
    .select(`
      id, last_message_at, last_inbound_at, unread_count,
      lead:leads ( id, phone_e164, first_name, last_name )
    `)
    .order('last_message_at', { ascending: false })
    .limit(200);
  return (
    <div className="flex h-full">
      <ConversationList initial={(data ?? []) as any} />
      <div className="hidden md:flex flex-1 items-center justify-center text-zinc-400">
        <div className="text-center">
          <Inbox className="size-10 mx-auto mb-2" />
          <p>Seleziona una conversazione</p>
        </div>
      </div>
    </div>
  );
}
