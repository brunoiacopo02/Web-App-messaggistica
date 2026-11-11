import type { getSupabaseAdmin } from './supabase/admin';
import { sendTemplate, getTemplateBody } from './twilio';
import { feniceOpening } from './fenice-opening';
import { normalizeFunnel, variantIndexFor, openingEnvKey, openingBody, openingWaysFor } from './persona';
import { firstNameOf, templateName } from './name';
import { aperturaBlackFridayText, isCrmFunnelBlackFriday } from './black-friday';
import { aperturaBlackFriday } from './black-friday-apertura';
import { isCrmFunnelProfessioni } from './professioni';
import { aperturaScheda, segnaSchedaDaTemplate } from './scheda-template-invio';
import { templateSchedaAcceso } from './scheda-template';
import { isChatDatabase } from './database-bot';

type Supa = ReturnType<typeof getSupabaseAdmin>;

/**
 * L'invio dell'apertura di Mario a una chat che esiste gia' ma a cui non e' mai partito
 * niente. Una sola strada per due chiamanti: l'apertura differita (cron
 * sequence-touches, lead arrivati fra le 23 e le 07) e il recupero delle aperture mai
 * partite (cron recupero-aperture, PO 06/11/2026). Stesso template, stesso testo in
 * cronologia, stessa gestione del frequency cap: il recupero non ha un testo suo.
 *
 * Spostato qui da app/api/cron/sequence-touches/route.ts senza cambiarne il
 * comportamento.
 */

/**
 * Come sendTemplateAndLog, ma con gestione del frequency cap Meta (63049):
 * in quel caso NON inserisce nessun messaggio (il touch non è consumato e
 * verrà ritentato al run successivo) e logga `sequence_freq_capped`.
 */
export async function sendSequenceTemplate(
  supabase: Supa,
  conversationId: number,
  phone: string,
  templateSid: string,
  label: string,
  from: string | undefined,
  variables: Record<string, string>,
  bodyOverride?: string,
): Promise<{ ok: boolean; capped?: boolean; error?: string }> {
  // `from` anche qui: il testo del template si legge dall'account che possiede il mittente.
  const tplBody = bodyOverride ?? (await getTemplateBody(templateSid, from)) ?? `[template] ${label}`;
  try {
    const sent = await sendTemplate({ to: phone, contentSid: templateSid, variables, from });
    await supabase.from('messages').insert({
      conversation_id: conversationId,
      direction: 'out',
      body: tplBody,
      twilio_sid: sent.sid,
      twilio_status: sent.status,
      template_sid: templateSid,
      is_template: true,
      sender: 'automazione',
    });
    await supabase
      .from('conversations')
      .update({ last_message_at: new Date().toISOString() })
      .eq('id', conversationId);
    return { ok: true };
  } catch (err: unknown) {
    const e = err as { message?: string; code?: number };
    if (e?.code === 63049) {
      await supabase.from('event_log').insert({
        type: 'sequence_freq_capped',
        payload: { conversationId, templateSid } as never,
        message: `[sequenza] frequency cap Meta su conv ${conversationId}: touch non consumato, ritento al prossimo run`,
        level: 'info',
      });
      return { ok: false, capped: true };
    }
    await supabase.from('messages').insert({
      conversation_id: conversationId,
      direction: 'out',
      body: tplBody,
      twilio_status: 'failed',
      twilio_error_code: e?.code ?? null,
      template_sid: templateSid,
      is_template: true,
      sender: 'automazione',
    });
    return { ok: false, error: e?.message ?? 'unknown' };
  }
}

export type EsitoAperturaMario =
  | { ok: boolean; capped?: boolean; error?: string; tentato: true }
  /** Nessun invio: manca il SID dell'apertura legacy (gia' segnalato con `logConfigError`). */
  | { ok: false; tentato: false; error: 'config_mancante' }
  /** Black Friday: si aspetta l'approvazione del template BF (`bf_apertura_attesa_fino`). */
  | { ok: false; tentato: false; error: 'attesa_template_bf' }
  /** Chat di un lead di database: la sua apertura parte solo dall'intake (lib/database-enroll.ts). */
  | { ok: false; tentato: false; error: 'chat_database' };

/**
 * L'apertura di Mario: con `NEW_OPENING_ENABLED=1` la variante per funnel (persona
 * Marta, A/B come all'arruolamento), con ripiego sul legacy se il SID della variante
 * manca; altrimenti il legacy `FENICE_OPENING_TEMPLATE_SID`.
 */
export async function inviaAperturaMario(
  supabase: Supa,
  a: {
    conversationId: number;
    phone: string;
    firstName: string | null;
    funnel: string | null | undefined;
    /** Corso della chat (`conversations.professione`), per il template della scheda. */
    professione?: string | null;
    from: string;
    logConfigError: (key: string) => Promise<void>;
    logOpeningConfigError: (key: string) => Promise<void>;
  },
): Promise<EsitoAperturaMario> {
  // Lead di database (PO 10/11/2026): la loro apertura parte SOLO dall'intake, col template
  // database e dentro i suoi tetti. Qui (apertura differita, recupero) non si manda mai
  // l'apertura di Mario a una chat database rimasta senza messaggio.
  if (isChatDatabase(a.funnel)) return { ok: false, tentato: false, error: 'chat_database' };
  if (isCrmFunnelBlackFriday(a.funnel)) {
    const bf = await aperturaBlackFriday(supabase, a.from);
    if (bf.scelta === 'attesa') return { ok: false, tentato: false, error: 'attesa_template_bf' };
    if (bf.scelta === 'template_bf' && bf.sid) {
      const r = await sendSequenceTemplate(
        supabase, a.conversationId, a.phone, bf.sid, 'Apertura Black Friday', a.from,
        { '1': templateName(a.firstName) }, aperturaBlackFridayText(templateName(a.firstName)),
      );
      return { ...r, tentato: true };
    }
  }
  // Professioni dalla campagna brochure (PO 10/11/2026): il template della scheda se acceso
  // e approvato sul numero (vedi scheda-template-invio.ts), altrimenti il neutro qui sotto.
  if (isCrmFunnelProfessioni(a.funnel) && templateSchedaAcceso()) {
    // Il corso si rilegge dalla chat se il chiamante non lo passa (cron e recupero).
    let professione = a.professione;
    if (professione === undefined) {
      const { data } = await supabase.from('conversations').select('professione').eq('id', a.conversationId).maybeSingle();
      professione = (data as { professione?: string | null } | null)?.professione ?? null;
    }
    const apSch = await aperturaScheda({ from: a.from, firstName: a.firstName, professione }).catch(() => null);
    if (apSch) {
      const r = await sendSequenceTemplate(
        supabase, a.conversationId, a.phone, apSch.sid,
        apSch.tipo === 'scheda' ? 'Apertura scheda del corso' : 'Apertura scelta del corso', a.from,
        apSch.variabili, apSch.testo,
      );
      if (r.ok) await segnaSchedaDaTemplate(supabase, { conversationId: a.conversationId, apertura: apSch });
      return { ...r, tentato: true };
    }
  }
  // Black Friday dalle inserzioni (PO 07/11/2026): l'apertura neutra legacy, mai quelle
  // per funnel (10 ore / Telegram / simulatore). Vedi fenice-enroll.ts.
  // Professioni dalle inserzioni della brochure (PO 10/11/2026): la stessa neutra.
  if (process.env.NEW_OPENING_ENABLED === '1' && !isCrmFunnelBlackFriday(a.funnel) && !isCrmFunnelProfessioni(a.funnel)) {
    const funnel = normalizeFunnel(a.funnel);
    const ways = openingWaysFor(funnel, (k) => Boolean(process.env[k]));
    const variant = variantIndexFor(a.conversationId, ways);
    const envKey = openingEnvKey(funnel, variant);
    const newSid = process.env[envKey];
    if (newSid) {
      const r = await sendSequenceTemplate(
        supabase, a.conversationId, a.phone, newSid, `Apertura ${envKey}`, a.from,
        { '1': templateName(a.firstName) },
        openingBody(funnel, variant, a.firstName),
      );
      return { ...r, tentato: true };
    }
    // SID mancante → una volta per run l'errore, poi fallback all'apertura legacy.
    await a.logOpeningConfigError(envKey);
  }
  const openingSid = process.env.FENICE_OPENING_TEMPLATE_SID;
  if (!openingSid) {
    await a.logConfigError('FENICE_OPENING_TEMPLATE_SID');
    return { ok: false, tentato: false, error: 'config_mancante' };
  }
  const cleanName = firstNameOf(a.firstName);
  const variables: Record<string, string> = cleanName ? { '3': cleanName } : {};
  const r = await sendSequenceTemplate(
    supabase, a.conversationId, a.phone, openingSid, 'Fenice apertura', a.from, variables, feniceOpening(a.firstName),
  );
  return { ...r, tentato: true };
}
