import { notFound } from 'next/navigation';
import { getSupabaseServer } from '@/lib/supabase/server';
import { MessageThread } from '@/components/MessageThread';
import { Composer } from '@/components/Composer';
import { isWindowOpen } from '@/lib/utils';
import { ConversationList } from '@/components/ConversationList';

export const dynamic = 'force-dynamic';

export default async function ConversationPage({
  params,
}: { params: Promise<{ conversationId: string }> }) {
  const { conversationId } = await params;
  const id = parseInt(conversationId, 10);
  if (Number.isNaN(id)) notFound();

  const supabase = await getSupabaseServer();

  const [convRes, msgsRes, campsRes, listRes] = await Promise.all([
    supabase.from('conversations').select(`
      id, last_inbound_at, last_message_at,
      lead:leads(id, first_name, last_name, phone_e164, email)
    `).eq('id', id).single(),
    supabase.from('messages').select('*').eq('conversation_id', id).order('created_at', { ascending: true }).limit(500),
    supabase.from('campaigns').select('*').order('name'),
    supabase.from('conversations').select(`
      id, last_message_at, last_inbound_at, unread_count,
      lead:leads(id, phone_e164, first_name, last_name)
    `).order('last_message_at', { ascending: false }).limit(200),
  ]);

  if (!convRes.data) notFound();
  const conv = (convRes as any).data as any;

  // Marca tutti gli inbound come letti (server side, fire and forget)
  await supabase.from('messages').update({ read_at: new Date().toISOString() })
    .eq('conversation_id', id).eq('direction', 'in').is('read_at', null);
  await supabase.from('conversations').update({ unread_count: 0 }).eq('id', id);

  const open = isWindowOpen(conv.last_inbound_at);
  const fullName = [conv.lead?.first_name, conv.lead?.last_name].filter(Boolean).join(' ') || conv.lead?.phone_e164 || 'Sconosciuto';

  return (
    <div className="flex h-full">
      <ConversationList initial={(listRes.data ?? []) as any} />
      <div className="flex-1 flex flex-col">
        <header className="border-b px-4 py-3">
          <div className="text-base font-medium">{fullName}</div>
          <div className="text-xs text-zinc-500">{conv.lead?.phone_e164}</div>
        </header>
        <MessageThread conversationId={id} initial={(msgsRes.data ?? []) as any} campaignNamesById={{}} />
        <Composer conversationId={id} windowOpen={open} campaigns={(campsRes.data ?? []) as any} />
      </div>
    </div>
  );
}
