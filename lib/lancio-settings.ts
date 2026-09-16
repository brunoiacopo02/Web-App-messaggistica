import type { getSupabaseAdmin } from './supabase/admin';
import { parsePerimetroBlast, type PerimetroBlast } from './lancio-zoom-blast';

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
  // §11 (delibera 16/09): le due manopole della sera del 5, da girare senza deploy.
  'lancio_blast_perimetro',
  'lancio_sender',
] as const;
export type LancioSettingKey = (typeof LANCIO_SETTING_KEYS)[number];

/**
 * Da quale numero WhatsApp parte l'outbound del lancio (spec §11.1). Il client del
 * secondario arriva col task "Mittente secondario": fino ad allora `secondario` e' una
 * scelta dichiarata ma non eseguibile, e chi legge questa impostazione deve accorgersene
 * invece di mandare 3.000 messaggi dal numero sbagliato in silenzio.
 */
export type LancioSender = 'principale' | 'secondario';

export function parseSender(raw: unknown): LancioSender {
  return normalizza(raw) === 'secondario' ? 'secondario' : 'principale';
}

export type LancioSettings = {
  attivo: boolean;
  zoomLink: string | null;
  videoLiveLink: string | null;
  offertaDelMeseLink: string | null;
  eventoAt: string | null;
  blastPerimetro: PerimetroBlast;
  sender: LancioSender;
};

export const LANCIO_SETTINGS_DEFAULT: LancioSettings = {
  attivo: false,
  zoomLink: null,
  videoLiveLink: null,
  offertaDelMeseLink: null,
  eventoAt: null,
  blastPerimetro: 'tutti',
  sender: 'principale',
};

/** La spec dice `0/1`; il pannello scrivera' un booleano. Si accettano entrambi. */
export function isAttivo(value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (typeof value === 'string') return ['1', 'true', 'on'].includes(value.trim().toLowerCase());
  return false;
}

/** Le manopole del pannello si scrivono a mano: spazi e maiuscole non devono cambiarne
 *  il significato. Quello che non e' una stringa resta `null` e cade sul default. */
function normalizza(value: unknown): string | null {
  return typeof value === 'string' ? value.trim().toLowerCase() || null : null;
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
    blastPerimetro: parsePerimetroBlast(normalizza(byKey.get('lancio_blast_perimetro'))),
    sender: parseSender(byKey.get('lancio_sender')),
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
