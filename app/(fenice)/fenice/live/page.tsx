import { Radio } from 'lucide-react';
import { getSupabaseServer } from '@/lib/supabase/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { getAutoReply } from '@/lib/fenice-settings';
import { PageHeader } from '@/components/fenice/PageHeader';
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
    <div className="flex h-full flex-col">
      <PageHeader
        icon={Radio}
        kicker="Mario su WhatsApp"
        title="Live"
        description="Attiva l’auto-risposta, avvia nuovi lead e tieni d’occhio chi Mario sta seguendo proprio ora."
        actions={
          <span className="inline-flex items-center gap-1.5 rounded-full border border-brand/30 bg-brand/10 px-3 py-1 text-[0.7rem] font-bold uppercase tracking-[0.14em] text-brand">
            <span className="fenice-pulse size-1.5 rounded-full bg-brand" />
            Live
          </span>
        }
      />
      <div className="flex-1 overflow-y-auto px-4 py-6 md:px-8">
        <LivePanel initialAutoReply={autoReply} initialRows={rows} />
      </div>
    </div>
  );
}
