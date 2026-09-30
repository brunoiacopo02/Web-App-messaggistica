import { getSupabaseServer } from '@/lib/supabase/server';
import { Campagne, type Campagna } from '@/components/console/sezioni/Campagne';

export const dynamic = 'force-dynamic';

/** Campagne WhatsApp legate alle liste ActiveCampaign: la stessa lettura di `/campagne`. */
export default async function CampagnePage() {
  const supabase = await getSupabaseServer();
  const { data } = await supabase.from('campaigns').select('*').order('created_at', { ascending: false });
  const campagne = (data ?? []) as unknown as Campagna[];
  return <Campagne campagne={campagne} />;
}
