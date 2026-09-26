import type { getSupabaseAdmin } from './supabase/admin';
import { parsePerimetroBlast, type PerimetroBlast } from './lancio-zoom-blast';
import { isoWithOffset } from './bot-contract';

type Supa = ReturnType<typeof getSupabaseAdmin>;

/**
 * Le impostazioni del lancio (spec §3.2) vivono in `app_settings`, come
 * `fenice_ai_autoreply`: Bruno le cambia dal pannello (B5) senza deploy, e i link del
 * video della live e dell'offerta esistono solo dopo la sera del 5.
 *
 * `lancio_attivo` e' l'interruttore del blocco B1: spento, l'intake prende in carico il
 * lead ma non manda il benvenuto (lo riprende il cron `lancio-aperture` quando si
 * accende). E' l'unico modo di avere un kill-switch sull'outbound senza perdere lead.
 *
 * `lancio_pulsante_attivo` e' l'interruttore del pulsante WhatsApp del webinar (B2):
 * spento, il marker viene trattato come ASSENTE ovunque — chi scrive quella frase resta
 * un inbound normale. Serve perche' il marker e' un testo, non un segnale: prima della
 * sera del 5/10 una frase qualunque che contenga "live web developer ai" porterebbe in
 * `post_pitch` un lead in `attesa`, e quel lead perderebbe il blast dello Zoom. Sta in
 * `app_settings` e non in una env perche' si accende la sera stessa, senza deploy:
 *   update app_settings set value='true'::jsonb where key='lancio_pulsante_attivo';
 * Chiave assente o valore strano = spento (si sbaglia dalla parte del silenzio).
 */
export const LANCIO_SETTING_KEYS = [
  'lancio_attivo',
  'lancio_pulsante_attivo',
  'lancio_zoom_link',
  'lancio_video_live_link',
  'offerta_del_mese_link',
  'lancio_evento_at',
  // §11 (delibera 16/09): le due manopole della sera del 5, da girare senza deploy.
  'lancio_blast_perimetro',
  'lancio_sender',
  // Delibera 19/09: il rivolo verso il numero nuovo, in percentuale. Vedi sotto.
  'lancio_quota_secondario',
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

/**
 * La quota dei benvenuti del lancio che parte dal numero NUOVO, in percentuale (0-100).
 *
 * E' il rapporto 1 a 10 chiesto dal PO (9 = uno dal nuovo ogni dieci dal vecchio):
 * scalda il numero nuovo senza esporlo, finche' non e' accertata la sua capacita'.
 * Non c'entra con la scelta ordinaria di un secondario (`scegliMittenteNuovo` in
 * lib/scelta-mittente.ts, tetti in `app_settings.tetti_numeri`), che e' un'altra regola
 * e non si tocca.
 *
 * Fail-closed, come tutte le manopole che spostano traffico su un numero che potrebbe
 * non essere pronto: assente, vuota, non intera o fuori da 0-100 vale **0**, cioe' tutto
 * dal numero storico. Sbagliare in quella direzione costa un riscaldamento piu' lento;
 * nell'altra costa il numero.
 */
export function parseQuotaSecondario(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw.trim() || NaN) : NaN;
  if (!Number.isInteger(n) || n < 0 || n > 100) return 0;
  return n;
}

export type LancioSettings = {
  attivo: boolean;
  /** Il pulsante del webinar e' riconosciuto? Spento = marker trattato come assente. */
  pulsanteAttivo: boolean;
  zoomLink: string | null;
  videoLiveLink: string | null;
  offertaDelMeseLink: string | null;
  eventoAt: string | null;
  blastPerimetro: PerimetroBlast;
  sender: LancioSender;
  /** % dei benvenuti del lancio dal numero nuovo (0-100). 0 = tutti dal numero storico. */
  quotaSecondario: number;
};

export const LANCIO_SETTINGS_DEFAULT: LancioSettings = {
  attivo: false,
  pulsanteAttivo: false,
  zoomLink: null,
  videoLiveLink: null,
  offertaDelMeseLink: null,
  eventoAt: null,
  blastPerimetro: 'tutti',
  sender: 'principale',
  quotaSecondario: 0,
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
    pulsanteAttivo: isAttivo(byKey.get('lancio_pulsante_attivo')),
    zoomLink: stringaOrNull(byKey.get('lancio_zoom_link')),
    videoLiveLink: stringaOrNull(byKey.get('lancio_video_live_link')),
    offertaDelMeseLink: stringaOrNull(byKey.get('offerta_del_mese_link')),
    eventoAt: stringaOrNull(byKey.get('lancio_evento_at')),
    blastPerimetro: parsePerimetroBlast(normalizza(byKey.get('lancio_blast_perimetro'))),
    sender: parseSender(byKey.get('lancio_sender')),
    quotaSecondario: parseQuotaSecondario(byKey.get('lancio_quota_secondario')),
  };
}

export async function getLancioSettings(supabase: Supa): Promise<LancioSettings> {
  const { data } = await supabase
    .from('app_settings')
    .select('key, value')
    .in('key', [...LANCIO_SETTING_KEYS]);
  return parseLancioSettings((data ?? []) as { key: string; value: unknown }[]);
}

/** L'esito di una scrittura: queste chiavi sono manopole d'emergenza, e una scrittura
 *  che non e' andata a segno non puo' passare per fatta (ne' al pannello ne' al freno). */
export type EsitoScrittura = { ok: true } | { ok: false; error: string };

export async function setLancioSetting(
  supabase: Supa,
  key: LancioSettingKey,
  value: string | boolean,
): Promise<EsitoScrittura> {
  const { error } = await supabase
    .from('app_settings')
    .upsert({ key, value: value as never, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  return error ? { ok: false, error: error.message ?? String(error) } : { ok: true };
}

/**
 * Il valore grezzo di una chiave, cosi' com'e' nel DB. Serve all'audit del pannello:
 * accanto al "dopo" va scritto il "prima", altrimenti la sera del 5 ottobre un evento
 * dice solo che qualcosa e' cambiato, non da cosa. Chiave assente = `null`.
 */
export async function getLancioSettingValue(supabase: Supa, key: LancioSettingKey): Promise<unknown> {
  const { data } = await supabase.from('app_settings').select('value').eq('key', key).maybeSingle();
  return (data as { value: unknown } | null)?.value ?? null;
}

/** Le chiavi che la pagina /fenice/impostazioni puo' scrivere: tutte (ruling B5). */
export const LANCIO_EDITABLE_KEYS: readonly LancioSettingKey[] = LANCIO_SETTING_KEYS;

export type SettingValidation =
  | { ok: true; value: string | boolean }
  | { ok: false; reason: 'chiave_non_modificabile' | 'link_non_https' | 'data_non_valida' | 'valore_non_valido' };

/**
 * Le regole di scrittura dalla pagina. I valori scritti sono quelli che
 * `parseLancioSettings` sa leggere: booleani per i due interruttori (come li scrive il
 * freno), stringhe per il resto, stringa vuota per azzerare un link (letta come null).
 * `lancio_evento_at` non si azzera: blast, follow-up e restituzioni ne derivano le date.
 */
export function validateLancioSettingInput(key: string, raw: unknown): SettingValidation {
  if (!(LANCIO_EDITABLE_KEYS as readonly string[]).includes(key)) return { ok: false, reason: 'chiave_non_modificabile' };
  const k = key as LancioSettingKey;
  if (k === 'lancio_attivo' || k === 'lancio_pulsante_attivo') {
    if (raw === true || raw === false) return { ok: true, value: raw };
    const s = normalizza(raw);
    if (s === null || ['0', 'false', 'off'].includes(s)) return { ok: true, value: false };
    if (['1', 'true', 'on'].includes(s)) return { ok: true, value: true };
    return { ok: false, reason: 'valore_non_valido' };
  }
  if (k === 'lancio_blast_perimetro') {
    const s = normalizza(raw);
    if (s === null || s === 'tutti') return { ok: true, value: 'tutti' };
    if (s === 'risposto') return { ok: true, value: 'risposto' };
    return { ok: false, reason: 'valore_non_valido' };
  }
  if (k === 'lancio_sender') {
    const s = normalizza(raw);
    if (s === null || s === 'principale') return { ok: true, value: 'principale' };
    if (s === 'secondario') return { ok: true, value: 'secondario' };
    return { ok: false, reason: 'valore_non_valido' };
  }
  if (k === 'lancio_quota_secondario') {
    // Vuoto = 0 (il default fail-closed), non "valore non valido": azzerare la quota e'
    // il gesto d'emergenza, e deve funzionare anche svuotando il campo.
    if (raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '')) {
      return { ok: true, value: '0' };
    }
    const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw.trim()) : NaN;
    if (!Number.isInteger(n) || n < 0 || n > 100) return { ok: false, reason: 'valore_non_valido' };
    // Si scrive come stringa: `setLancioSetting` accetta stringhe e booleani, e
    // `parseQuotaSecondario` rilegge indifferentemente numero o stringa.
    return { ok: true, value: String(n) };
  }
  const v = stringaOrNull(raw);
  if (k === 'lancio_evento_at') {
    if (v === null || !isoWithOffset(v)) return { ok: false, reason: 'data_non_valida' };
    return { ok: true, value: v };
  }
  if (v === null) return { ok: true, value: '' };
  // Lo schema si accetta anche urlato (un link incollato dal cellulare arriva cosi') e
  // si normalizza minuscolo; il resto dell'URL resta com'e', perche' i path di Zoom e
  // del corso distinguono maiuscole e minuscole.
  const link = /^https:\/\/([^\s]+)$/i.exec(v);
  if (!link) return { ok: false, reason: 'link_non_https' };
  return { ok: true, value: `https://${link[1]}` };
}
