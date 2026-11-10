import type { getSupabaseAdmin } from './supabase/admin';
import { traduciTemplate } from './template-account';
import { credenzialiPerMittente } from './twilio-account';
import { spedibileDa } from './spedibilita';
import { isSlugProfessione, type SlugProfessione } from './professioni';
import { templateName } from './name';
import { templateSchedaAcceso, templateSchedaPer, type SceltaTemplateScheda } from './scheda-template';

type Supa = ReturnType<typeof getSupabaseAdmin>;

/**
 * Apertura con il template della scheda (campagna brochure, PO 10/11/2026), al posto del
 * neutro `aperturabotchat` per i lead PROFESSIONI arrivati dal CRM. SPENTA di default:
 * serve `SCHEDA_TEMPLATE_ENABLED=1` e il template della variante approvato da Meta E
 * spedibile (presidio UTILITY_ONLY) dall'account del numero. Ogni dubbio = null, e chi
 * chiama manda il neutro di sempre: un template non approvato non parte mai.
 */
const CACHE_MS = 5 * 60_000;
const _approvato = new Map<string, { ok: boolean; at: number }>();

export async function templateApprovatoSu(sid: string, numero: string): Promise<boolean> {
  const tr = await traduciTemplate(sid, numero).catch(() => ({ sid, tradotto: false }));
  if (!tr.tradotto) return false;
  const c = _approvato.get(tr.sid);
  if (c && Date.now() - c.at < CACHE_MS) return c.ok;
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
    // Approvato non basta: se Meta lo classifica MARKETING il presidio lo rifiuta.
    if (ok) ok = (await spedibileDa(sid, numero)).ok;
  } catch {
    ok = false;
  }
  _approvato.set(tr.sid, { ok, at: Date.now() });
  return ok;
}

export type AperturaScheda = SceltaTemplateScheda & { sid: string };

/** La variante da mandare da `from`, o null (spento, SID mancante, non approvato). */
export async function aperturaScheda(
  a: { from: string; firstName: string | null | undefined; professione: string | null | undefined },
  env: Record<string, string | undefined> = process.env,
): Promise<AperturaScheda | null> {
  if (!templateSchedaAcceso(env)) return null;
  const slug: SlugProfessione | null = isSlugProfessione(a.professione) ? a.professione : null;
  const scelta = templateSchedaPer(templateName(a.firstName), slug);
  const sid = env[scelta.envKey]?.trim();
  if (!sid) return null;
  if (!(await templateApprovatoSu(sid, a.from))) return null;
  return { ...scelta, sid };
}

/**
 * Dopo un invio riuscito della variante col PDF: la scheda e' in chat, `scheda_inviata_at`
 * si segna (CAS come `inviaScheda`), cosi' alla prima risposta non riparte.
 */
export async function segnaSchedaDaTemplate(
  supabase: Supa,
  a: { conversationId: number; apertura: AperturaScheda },
): Promise<void> {
  if (a.apertura.tipo !== 'scheda') return;
  await supabase.from('conversations').update({ scheda_inviata_at: new Date().toISOString() })
    .eq('id', a.conversationId).is('scheda_inviata_at', null);
  await supabase.from('event_log').insert({
    type: 'scheda_inviata',
    payload: { conversationId: a.conversationId, slug: a.apertura.slug, momento: 'template_apertura' } as never,
    message: `[professioni] conv ${a.conversationId}: scheda ${a.apertura.slug} inviata col template di apertura`,
    level: 'info',
  });
}
