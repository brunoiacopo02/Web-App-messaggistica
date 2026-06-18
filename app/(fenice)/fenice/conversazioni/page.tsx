import { getSupabaseServer } from '@/lib/supabase/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { ConversationsPanel } from './_components/ConversationsPanel';

export const dynamic = 'force-dynamic';

export default async function FeniceConversazioniPage() {
  const supabase = await getSupabaseServer();
  await supabase.auth.getUser();

  const admin = getSupabaseAdmin();
  const { data: convs } = await admin
    .from('conversations')
    .select('id, ai_status, last_message_at, ai_summary_at, leads(phone_e164, first_name, last_name)')
    .eq('ai_owner', 'mario')
    .order('last_message_at', { ascending: false })
    .limit(200);

  const rows = (convs ?? []).map((c: any) => ({
    id: c.id as number,
    status: c.ai_status as string | null,
    phone: c.leads?.phone_e164 ?? '',
    name: [c.leads?.first_name, c.leads?.last_name].filter(Boolean).join(' '),
    lastMessageAt: c.last_message_at as string,
    hasSummary: Boolean(c.ai_summary_at),
  }));

  return (
    <div className="h-full">
      <ConversationsPanel rows={rows} />
    </div>
  );
}
