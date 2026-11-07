import type { getSupabaseAdmin } from './supabase/admin';
import { traduciTemplate } from './template-account';
import { credenzialiPerMittente } from './twilio-account';
import { sceltaAperturaBf, SETTING_MODO_APERTURA, type SceltaAperturaBf } from './black-friday';

type Supa = ReturnType<typeof getSupabaseAdmin>;

/**
 * Quale apertura per un lead Black Friday da questo numero (PO 07/11/2026): il template
 * BF (`BF_OPENING_TEMPLATE_SID`, ritrovato per nome sugli altri account) se Meta l'ha
 * approvato sull'account del numero; altrimenti stand-by, salvo `bf_apertura_modo` =
 * 'neutra'. Fallisce verso lo stand-by: un dubbio sull'approvazione non manda mai un
 * template non approvato.
 */
const CACHE_MS = 5 * 60_000;
const _approvato = new Map<string, { ok: boolean; at: number }>();

export async function templateBfApprovatoSu(numero: string): Promise<{ ok: boolean; sid: string | null }> {
  const sid = process.env.BF_OPENING_TEMPLATE_SID?.trim() || null;
  if (!sid) return { ok: false, sid: null };
  const tr = await traduciTemplate(sid, numero).catch(() => ({ sid, tradotto: false }));
  if (!tr.tradotto) return { ok: false, sid };
  const c = _approvato.get(tr.sid);
  if (c && Date.now() - c.at < CACHE_MS) return { ok: c.ok, sid };
  let ok = false;
  try {
    const cred = credenzialiPerMittente(numero);
    if (cred) {
      const r = await fetch(`https://content.twilio.com/v1/Content/${tr.sid}/ApprovalRequests`, {
        headers: { Authorization: 'Basic ' + Buffer.from(`${cred.sid}:${cred.token}`).toString('base64') },
      });
      const j = r.ok ? await r.json() : null;
      ok = j?.whatsapp?.status === 'approved';
    }
  } catch {
    ok = false;
  }
  _approvato.set(tr.sid, { ok, at: Date.now() });
  return { ok, sid };
}

export async function leggiModoAperturaBf(supabase: Supa): Promise<string | null> {
  try {
    const { data } = await supabase.from('app_settings').select('value').eq('key', SETTING_MODO_APERTURA).maybeSingle();
    const v = (data as { value?: unknown } | null)?.value;
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
}

export type AperturaBf = { scelta: SceltaAperturaBf; sid: string | null };

export async function aperturaBlackFriday(supabase: Supa, numero: string): Promise<AperturaBf> {
  const [ok, modo] = await Promise.all([templateBfApprovatoSu(numero), leggiModoAperturaBf(supabase)]);
  return { scelta: sceltaAperturaBf({ approvato: ok.ok, modo }), sid: ok.sid };
}
