import { notFound } from 'next/navigation';
import { getSupabaseServer } from '@/lib/supabase/server';
import { MessageThread } from '@/components/MessageThread';
import { isConversazioneChat } from '@/lib/chat-perimetro';

export const dynamic = 'force-dynamic';

// Sola lettura: nessun Composer, e nessuna scrittura su read_at/unread_count.
export default async function ChatConversationPage({
  params,
}: { params: Promise<{ conversationId: string }> }) {
  const { conversationId } = await params;
  const id = parseInt(conversationId, 10);
  if (Number.isNaN(id)) notFound();

  const supabase = await getSupabaseServer();
  if (!(await isConversazioneChat(supabase, id))) notFound();

  const [convRes, msgsRes] = await Promise.all([
    supabase.from('conversations').select(`
      id, last_inbound_at, last_message_at, ai_owner, ai_status, gdo_agenda_at,
      bot_outcome, bot_scheduled_at,
      lead:leads(id, first_name, last_name, phone_e164)
    `).eq('id', id).single(),
    // Storia intera: nessun taglio a ai_started_at, a differenza di /fenice/conversazioni.
    supabase.from('messages').select('*').eq('conversation_id', id)
      .order('created_at', { ascending: true }).limit(500),
  ]);

  if (!convRes.data) notFound();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const conv = convRes.data as any;
  const fullName = [conv.lead?.first_name, conv.lead?.last_name].filter(Boolean).join(' ')
    || conv.lead?.phone_e164 || 'Sconosciuto';

  return (
    <div className="flex-1 flex flex-col h-full min-w-0">
      <header className="border-b px-4 py-3">
        <div className="text-base font-medium">{fullName}</div>
        <div className="text-xs text-zinc-500">{conv.lead?.phone_e164}</div>
      </header>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <MessageThread conversationId={id} initial={(msgsRes.data ?? []) as any} campaignNamesById={{}} apiBase="/api/chat/conversations" />
    </div>
  );
}
