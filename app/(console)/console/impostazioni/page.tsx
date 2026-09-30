import { getSupabaseServer } from '@/lib/supabase/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { getLancioSettings } from '@/lib/lancio-settings';
import { getAutoReply } from '@/lib/fenice-settings';
import { puoModificareLancio } from '@/lib/access';
import { ultimiCambi } from '@/lib/console/impostazioni';
import { Impostazioni } from '@/components/console/sezioni/Impostazioni';

export const dynamic = 'force-dynamic';

/** Impostazioni del lancio e interruttore di Mario: letture lato server, come `/fenice/impostazioni`. */
export default async function ImpostazioniPage() {
  const supabase = await getSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  const admin = getSupabaseAdmin();
  const [settings, autoReply, cambi] = await Promise.all([getLancioSettings(admin), getAutoReply(admin), ultimiCambi(admin)]);
  return <Impostazioni initial={settings} autoReply={autoReply} cambi={cambi} puoModificare={puoModificareLancio(user?.email)} />;
}
