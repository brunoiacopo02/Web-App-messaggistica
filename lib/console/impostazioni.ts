import type { getSupabaseAdmin } from '@/lib/supabase/admin';
import { LANCIO_SETTING_KEYS, type LancioSettingKey } from '@/lib/lancio-settings';

type Supa = ReturnType<typeof getSupabaseAdmin>;

/** Le chiavi della pagina Impostazioni: quelle del lancio più l'interruttore generale di Mario. */
export type ChiaveImpostazione = LancioSettingKey | 'fenice_ai_autoreply';

export type UltimoCambio = { at: string; who: string | null };

function quando(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  // Formattata sul server e passata come stringa: niente differenze di fuso fra server e browser.
  return new Date(t).toLocaleString('it-IT', {
    timeZone: 'Europe/Rome',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * L'ultimo cambio di ogni chiave, come in `/fenice/impostazioni`: chi e quando dall'`event_log`
 * che scrive la rotta del lancio (le ultime 80 righe di `lancio_setting_cambiata`, sull'indice
 * `(type, created_at desc)`); per le chiavi senza evento, e per l'auto-risposta di Mario che non
 * ne scrive, resta l'`updated_at` della riga di `app_settings`, senza nome.
 */
export async function ultimiCambi(admin: Supa): Promise<Partial<Record<ChiaveImpostazione, UltimoCambio>>> {
  const out: Partial<Record<ChiaveImpostazione, UltimoCambio>> = {};

  const { data: righe } = await admin
    .from('app_settings')
    .select('key, updated_at')
    .in('key', [...LANCIO_SETTING_KEYS, 'fenice_ai_autoreply']);
  for (const r of (righe ?? []) as { key: string; updated_at: string | null }[]) {
    const at = quando(r.updated_at);
    if (at) out[r.key as ChiaveImpostazione] = { at, who: null };
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
