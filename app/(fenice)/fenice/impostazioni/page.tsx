import { Settings } from 'lucide-react';
import { getSupabaseServer } from '@/lib/supabase/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { getLancioSettings, LANCIO_SETTING_KEYS, type LancioSettingKey } from '@/lib/lancio-settings';
import { puoModificareLancio } from '@/lib/access';
import { PageHeader } from '@/components/fenice/PageHeader';
import { ImpostazioniLancioPanel, type UltimoCambio } from './_components/ImpostazioniLancioPanel';

export const dynamic = 'force-dynamic';

function quando(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  // Formattata sul server e passata come stringa: il client non riformatta nulla,
  // quindi non c'è modo che l'orario renderizzato diverga fra server e browser.
  return new Date(t).toLocaleString('it-IT', {
    timeZone: 'Europe/Rome',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * L'ultimo cambio di ogni chiave: chi e quando. Viene dall'`event_log` che scrive la
 * rotta; per le chiavi cambiate a mano in SQL (o mai cambiate) resta l'`updated_at`
 * della riga, senza un nome accanto.
 */
async function ultimiCambi(
  admin: ReturnType<typeof getSupabaseAdmin>,
): Promise<Partial<Record<LancioSettingKey, UltimoCambio>>> {
  const out: Partial<Record<LancioSettingKey, UltimoCambio>> = {};

  const { data: righe } = await admin
    .from('app_settings')
    .select('key, updated_at')
    .in('key', [...LANCIO_SETTING_KEYS]);
  for (const r of (righe ?? []) as { key: string; updated_at: string | null }[]) {
    const at = quando(r.updated_at);
    if (at) out[r.key as LancioSettingKey] = { at, who: null };
  }

  const { data: eventi } = await admin
    .from('event_log')
    .select('payload, created_at')
    .eq('type', 'lancio_setting_cambiata')
    .order('created_at', { ascending: false })
    .limit(80);
  for (const e of (eventi ?? []) as { payload: unknown; created_at: string }[]) {
    const p = (e.payload ?? {}) as { key?: unknown; who?: unknown };
    const key = typeof p.key === 'string' ? (p.key as LancioSettingKey) : null;
    if (!key || out[key]?.who) continue; // le righe arrivano dalla più recente
    const at = quando(e.created_at);
    if (at) out[key] = { at, who: typeof p.who === 'string' ? p.who : null };
  }

  return out;
}

export default async function FeniceImpostazioniPage() {
  const supabase = await getSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();

  const admin = getSupabaseAdmin();
  const settings = await getLancioSettings(admin);
  const cambi = await ultimiCambi(admin);

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        icon={Settings}
        kicker="Lancio Web Developer AI"
        title="Impostazioni"
        description="Interruttori, link e mittente del lancio si cambiano da qui, senza deploy: il video della live editata e l’offerta del mese arrivano dopo il 5 ottobre."
      />
      <div className="flex-1 overflow-y-auto px-4 py-6 md:px-8">
        <ImpostazioniLancioPanel
          initial={settings}
          cambi={cambi}
          puoModificare={puoModificareLancio(user?.email)}
        />
      </div>
    </div>
  );
}
