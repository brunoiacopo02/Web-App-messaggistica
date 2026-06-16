import { getSupabaseServer } from '@/lib/supabase/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { getAutoReply } from '@/lib/fenice-settings';
import { LivePanel } from './_components/LivePanel';

export const dynamic = 'force-dynamic';

export default async function FeniceLivePage() {
  const supabase = await getSupabaseServer();
  await supabase.auth.getUser();

  const admin = getSupabaseAdmin();
  const autoReply = await getAutoReply(admin);
  const { data: convs } = await admin
    .from('conversations')
    .select('id, ai_status, last_message_at, leads(phone_e164, first_name)')
    .eq('ai_owner', 'mario')
    .order('last_message_at', { ascending: false })
    .limit(100);

  const rows = (convs ?? []).map((c: any) => ({
    id: c.id,
    status: c.ai_status as string | null,
    phone: c.leads?.phone_e164 ?? '',
    name: c.leads?.first_name ?? '',
    lastMessageAt: c.last_message_at as string,
  }));

  return (
    <div className="h-full overflow-y-auto p-6">
      <h1 className="text-lg font-semibold mb-4">Live — Mario su WhatsApp</h1>
      <LivePanel initialAutoReply={autoReply} initialRows={rows} />
    </div>
  );
}
