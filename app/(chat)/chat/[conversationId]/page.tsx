import { notFound } from 'next/navigation';
import { getSupabaseServer } from '@/lib/supabase/server';
import { MessageThread } from '@/components/MessageThread';
import { isConversazioneChat, mondoDi, mondoLabel } from '@/lib/chat-perimetro';
import { segmentOf, fermaReason } from '@/lib/lead-segments';
import { ChatStatusPill, ReasonPill, SegmentPill } from '@/components/fenice/status';
import { formatRomeDateTime } from '@/lib/rome-time';
import { isWindowOpen } from '@/lib/utils';
import { ChatTakeover } from './_components/ChatTakeover';

export const dynamic = 'force-dynamic';

// Sola lettura finché il bot governa la chat: nessuna scrittura su read_at/unread_count,
// e il Composer compare solo dopo il fermo manuale (vedi ChatTakeover).
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
      id, last_inbound_at, last_message_at, ai_owner, ai_status, ai_paused_at, gdo_agenda_at, gdo_video_sent_at,
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

  const now = new Date().toISOString();
  const seg = { bot_outcome: conv.bot_outcome, last_inbound_at: conv.last_inbound_at, ai_status: conv.ai_status };
  const mondo = mondoDi(conv);
  // Il bot decide un esito solo dove governa DAVVERO la conversazione: `ai_owner==='mario'`,
  // non `mondo !== 'CAMPAGNA'`. Quel proxy bastava prima del fix sul perimetro GDO
  // video-only, quando ogni chat GDO/Mario aveva per forza ai_owner='mario'; ora il
  // perimetro include anche le chat GDO servite dal solo script video (ai_owner e
  // ai_status nulli), che sono comunque mondo==='GDO' ma senza bot che le governi.
  // Su quelle, come sulle chat di campagna, bot_outcome/ai_status restano nulli e
  // segmentOf/chatStatusMeta tornerebbero comunque un esito (MAI_RISPOSTO, "Attivo")
  // inventato.
  const governataDalBot = conv.ai_owner === 'mario';
  const appuntamento = conv.bot_scheduled_at ? formatRomeDateTime(conv.bot_scheduled_at) : null;

  return (
    <div className="flex-1 flex flex-col h-full min-w-0">
      <header className="border-b px-4 py-3 space-y-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-base font-medium">{fullName}</span>
          <span className="text-[10px] uppercase tracking-wide rounded px-1.5 py-0.5 bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300">
            {mondoLabel(mondo, 'estesa')}
          </span>
        </div>
        <div className="flex items-center gap-2 flex-wrap text-xs text-zinc-500">
          <span>{conv.lead?.phone_e164}</span>
          {governataDalBot && (
            <>
              <SegmentPill segment={segmentOf(seg, now)} />
              <ReasonPill reason={fermaReason(seg, now)} />
              <ChatStatusPill status={conv.ai_status} />
            </>
          )}
          {conv.ai_paused_at && (
            <span className="rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-100">
              Bot fermo
            </span>
          )}
          {appuntamento && <span>Appuntamento: {appuntamento}</span>}
        </div>
      </header>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <MessageThread conversationId={id} initial={(msgsRes.data ?? []) as any} campaignNamesById={{}} apiBase="/api/chat/conversations" showSender />
      <ChatTakeover
        conversationId={id}
        paused={!!conv.ai_paused_at}
        windowOpen={isWindowOpen(conv.last_inbound_at)}
      />
    </div>
  );
}
