import { signPayload } from './bot-hmac';

/**
 * L'I/O dello spostamento della call di un lead GDO (regole in `gdo-spostamento.ts`):
 * la domanda "l'abbiamo già spostato?", la chiamata al CRM (esito `SPOSTAMENTO`,
 * contratto v1.9) e l'aggiornamento della chat dopo il sì del CRM.
 */

type Supa = {
  from: (t: string) => any;
};

const DEFAULT_CRM_URL = 'https://crm-sales-fenice.vercel.app/api/bot/outcome';

/** L'evento che segna lo spostamento fatto: serve anche a dire "una volta sola". */
export const EVENTO_SPOSTAMENTO = 'gdo_spostamento_bot';

/** Il bot ha già spostato la call di questa chat? Nel dubbio (errore) sì: non si sposta. */
export async function giaSpostatoDalBot(supabase: Supa, conversationId: number): Promise<boolean> {
  try {
    const { data, error } = await supabase
      .from('event_log')
      .select('id')
      .eq('type', EVENTO_SPOSTAMENTO)
      .eq('payload->>conversationId', String(conversationId))
      .limit(1);
    if (error) return true;
    return Array.isArray(data) && data.length > 0;
  } catch {
    return true;
  }
}

/** Lo stato del lead che il CRM ci ha già mandato (`crm_lead_status`), o `null`. */
export async function statoCrmLocale(
  supabase: Supa,
  crmLeadId: string,
): Promise<{ confermeOutcome: string | null; presented: boolean; salesOutcome: string | null } | null> {
  // Una lettura che fallisce non deve rompere il turno: senza stato locale decide il CRM.
  let data: { conferme_outcome?: string | null; presented?: boolean | null; sales_outcome?: string | null } | null = null;
  try {
    ({ data } = await supabase
      .from('crm_lead_status')
      .select('conferme_outcome, presented, sales_outcome')
      .eq('lead_id', crmLeadId)
      .maybeSingle());
  } catch {
    return null;
  }
  if (!data) return null;
  return {
    confermeOutcome: data.conferme_outcome ?? null,
    presented: !!data.presented,
    salesOutcome: data.sales_outcome ?? null,
  };
}

export type RispostaSpostamento =
  | { ok: true }
  | { ok: false; status?: number; motivo: string };

/** POST `SPOSTAMENTO` al CRM. Non lancia: ogni errore torna come `ok: false`. */
export async function inviaSpostamentoAlCrm(
  crmLeadId: string,
  dateIso: string,
  secret: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RispostaSpostamento> {
  const rawBody = JSON.stringify({ leadId: crmLeadId, outcome: 'SPOSTAMENTO', date: dateIso });
  const url = process.env.CRM_OUTCOME_URL ?? DEFAULT_CRM_URL;
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bot-signature': signPayload(rawBody, secret) },
      body: rawBody,
      signal: AbortSignal.timeout(15_000),
    });
    const testo = await res.text().catch(() => '');
    let corpo: { ok?: boolean; rescheduled?: boolean; motivo?: string; error?: string } = {};
    try { corpo = JSON.parse(testo); } catch { /* corpo non JSON */ }
    if (res.ok && corpo.rescheduled === true) return { ok: true };
    return { ok: false, status: res.status, motivo: corpo.motivo ?? corpo.error ?? (testo.slice(0, 200) || `http_${res.status}`) };
  } catch (e) {
    return { ok: false, motivo: e instanceof Error ? e.message : 'errore_rete' };
  }
}

/**
 * Dopo il sì del CRM: la chat prende la data nuova, così promemoria (T-24h con dedup su
 * `gdo_reminder24_for_at`, che per una data nuova si riapre da solo), "quando chiama
 * Noemi" (`gdo_appuntamento_set_at` = adesso, come uno spostamento che arriva dal CRM) e
 * recap usano la data nuova. Il recap lo vale già la conferma che mandiamo noi
 * (`gdo_recap_for_at`), e Noemi è spiegata lì dentro. `cancel_requested_at` torna nullo:
 * la data nuova è concordata, gli automatismi devono ripartire.
 */
export async function registraSpostamentoInChat(
  supabase: Supa,
  i: { conversationId: number; crmLeadId: string; da: string | null; a: string; now: Date },
): Promise<string | null> {
  const at = new Date(i.a).toISOString();
  const ora = i.now.toISOString();
  const { error } = await supabase
    .from('conversations')
    .update({
      gdo_appuntamento_at: at,
      gdo_appuntamento_set_at: ora,
      gdo_recap_for_at: at,
      gdo_recap_sent_at: ora,
      cancel_requested_at: null,
    })
    .eq('id', i.conversationId);
  await supabase
    .from('conversations')
    .update({ gdo_noemi_reminded_at: ora })
    .eq('id', i.conversationId)
    .is('gdo_noemi_reminded_at', null);
  await supabase.from('event_log').insert({
    type: EVENTO_SPOSTAMENTO,
    payload: { conversationId: i.conversationId, crmLeadId: i.crmLeadId, da: i.da, a: at, chatAggiornata: !error } as never,
    message: `[gdo] conv ${i.conversationId}: call spostata dal bot da ${i.da ?? '?'} a ${at}${error ? ` (chat NON aggiornata: ${error.message})` : ''}`,
    level: error ? 'error' : 'info',
  });
  return error ? error.message : null;
}
