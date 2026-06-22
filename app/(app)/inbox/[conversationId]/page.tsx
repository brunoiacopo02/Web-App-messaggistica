import { notFound } from 'next/navigation';
import { getSupabaseServer } from '@/lib/supabase/server';
import { MessageThread } from '@/components/MessageThread';
import { Composer } from '@/components/Composer';
import { isWindowOpen } from '@/lib/utils';

export const dynamic = 'force-dynamic';

export default async function ConversationPage({
  params,
}: { params: Promise<{ conversationId: string }> }) {
  const { conversationId } = await params;
  const id = parseInt(conversationId, 10);
  if (Number.isNaN(id)) notFound();

  const supabase = await getSupabaseServer();

  const [convRes, msgsRes, campsRes] = await Promise.all([
    supabase.from('conversations').select(`
      id, last_inbound_at, last_message_at, ai_owner,
      lead:leads(id, first_name, last_name, phone_e164, email)
    `).eq('id', id).single(),
    supabase.from('messages').select('*').eq('conversation_id', id).order('created_at', { ascending: true }).limit(500),
    supabase.from('campaigns').select('*').order('name'),
  ]);

  if (!convRes.data) notFound();
  const conv = (convRes as any).data as any;
  // Le chat di Mario (Fenice) non sono accessibili dal CRM, nemmeno via URL diretto.
  if (conv.ai_owner === 'mario') notFound();

  // Marca tutti gli inbound come letti (server side, fire and forget)
  await supabase.from('messages').update({ read_at: new Date().toISOString() })
    .eq('conversation_id', id).eq('direction', 'in').is('read_at', null);
  await supabase.from('conversations').update({ unread_count: 0 }).eq('id', id);

  const open = isWindowOpen(conv.last_inbound_at);
  const fullName = [conv.lead?.first_name, conv.lead?.last_name].filter(Boolean).join(' ') || conv.lead?.phone_e164 || 'Sconosciuto';

  return (
    <div className="flex-1 flex flex-col h-full min-w-0">
      <header className="border-b px-4 py-3">
        <div className="text-base font-medium">{fullName}</div>
        <div className="text-xs text-zinc-500">{conv.lead?.phone_e164}</div>
      </header>
      <MessageThread conversationId={id} initial={(msgsRes.data ?? []) as any} campaignNamesById={{}} />
      <Composer conversationId={id} windowOpen={open} campaigns={(campsRes.data ?? []) as any} />
    </div>
  );
}
