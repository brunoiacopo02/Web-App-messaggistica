import { notFound } from 'next/navigation';
import { getSupabaseServer } from '@/lib/supabase/server';
import { MessageThread } from '@/components/MessageThread';
import { Composer } from '@/components/Composer';
import { isWindowOpen } from '@/lib/utils';
import { isFeniceConversation } from '@/lib/campagne';

export const dynamic = 'force-dynamic';

export default async function CampagneConversationPage({
  params,
}: { params: Promise<{ conversationId: string }> }) {
  const { conversationId } = await params;
  const id = parseInt(conversationId, 10);
  if (Number.isNaN(id)) notFound();

  const supabase = await getSupabaseServer();
  // Guardia fenice: anche via URL diretto, questa sezione mostra solo le chat
  // delle campagne di proprietà Fenice.
  if (!(await isFeniceConversation(supabase, id))) notFound();

  const [convRes, msgsRes, campsRes] = await Promise.all([
    supabase.from('conversations').select(`
      id, last_inbound_at, last_message_at,
      lead:leads(id, first_name, last_name, phone_e164, email)
    `).eq('id', id).single(),
    supabase.from('messages').select('*').eq('conversation_id', id).order('created_at', { ascending: true }).limit(500),
    // `owner` esiste in DB (migration 20260713000001) ma non è ancora nei tipi generati:
    // stesso workaround di lib/campagne.ts (cast mirato, non tutto il client).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    supabase.from('campaigns').select('*').eq('owner' as any, 'fenice').order('name'),
  ]);

  if (!convRes.data) notFound();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const conv = convRes.data as any;

  // Marca gli inbound come letti (come /inbox)
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
      {/* eslint-disable @typescript-eslint/no-explicit-any -- Row DB (direction: string) vs union stretta di MessageThread/Composer, stesso cast di /inbox */}
      <MessageThread conversationId={id} initial={(msgsRes.data ?? []) as any} campaignNamesById={{}} apiBase="/api/campagne-chat/conversations" />
      <Composer conversationId={id} windowOpen={open} campaigns={(campsRes.data ?? []) as any} sendPath="/api/campagne-chat/messages" />
      {/* eslint-enable @typescript-eslint/no-explicit-any */}
    </div>
  );
}
