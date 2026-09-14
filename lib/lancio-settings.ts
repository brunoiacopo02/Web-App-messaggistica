import type { getSupabaseAdmin } from './supabase/admin';

type Supa = ReturnType<typeof getSupabaseAdmin>;

/**
 * Le impostazioni del lancio (spec §3.2) vivono in `app_settings`, come
 * `fenice_ai_autoreply`: Bruno le cambia dal pannello (B5) senza deploy, e i link del
 * video della live e dell'offerta esistono solo dopo la sera del 5.
 *
 * `lancio_attivo` e' l'interruttore del blocco B1: spento, l'intake prende in carico il
 * lead ma non manda il benvenuto (lo riprende il cron `lancio-aperture` quando si
 * accende). E' l'unico modo di avere un kill-switch sull'outbound senza perdere lead.
 */
export const LANCIO_SETTING_KEYS = [
  'lancio_attivo',
  'lancio_zoom_link',
  'lancio_video_live_link',
  'offerta_del_mese_link',
  'lancio_evento_at',
] as const;
export type LancioSettingKey = (typeof LANCIO_SETTING_KEYS)[number];

export type LancioSettings = {
  attivo: boolean;
  zoomLink: string | null;
  videoLiveLink: string | null;
  offertaDelMeseLink: string | null;
  eventoAt: string | null;
};

export const LANCIO_SETTINGS_DEFAULT: LancioSettings = {
  attivo: false,
  zoomLink: null,
  videoLiveLink: null,
  offertaDelMeseLink: null,
  eventoAt: null,
};

/** La spec dice `0/1`; il pannello scrivera' un booleano. Si accettano entrambi. */
export function isAttivo(value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (typeof value === 'string') return ['1', 'true', 'on'].includes(value.trim().toLowerCase());
  return false;
}

function stringaOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  return v === '' ? null : v;
}

export function parseLancioSettings(rows: { key: string; value: unknown }[]): LancioSettings {
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  return {
    attivo: isAttivo(byKey.get('lancio_attivo')),
    zoomLink: stringaOrNull(byKey.get('lancio_zoom_link')),
    videoLiveLink: stringaOrNull(byKey.get('lancio_video_live_link')),
    offertaDelMeseLink: stringaOrNull(byKey.get('offerta_del_mese_link')),
    eventoAt: stringaOrNull(byKey.get('lancio_evento_at')),
  };
}

export async function getLancioSettings(supabase: Supa): Promise<LancioSettings> {
  const { data } = await supabase
    .from('app_settings')
    .select('key, value')
    .in('key', [...LANCIO_SETTING_KEYS]);
  return parseLancioSettings((data ?? []) as { key: string; value: unknown }[]);
}

export async function setLancioSetting(
  supabase: Supa,
  key: LancioSettingKey,
  value: string | boolean,
): Promise<void> {
  await supabase
    .from('app_settings')
    .upsert({ key, value: value as never, updated_at: new Date().toISOString() }, { onConflict: 'key' });
}
