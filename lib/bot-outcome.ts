import type { getSupabaseAdmin } from './supabase/admin';
import { signPayload } from './bot-hmac';
import { validateOutcomeBody, type BotOutcome, type BotOutcomeBody, type BotReport } from './bot-contract';

type Supa = ReturnType<typeof getSupabaseAdmin>;

const DEFAULT_CRM_URL = 'https://crm-sales-fenice.vercel.app/api/bot/outcome';

export type SendOutcomeArgs = {
  outcome: BotOutcome;
  date?: string;
  note?: string;
  discardReason?: string;
  report?: BotReport;
};

/**
 * Invia l'esito al CRM per una conversazione CRM-linked. No-op per lead non-CRM.
 * Su 2xx persiste bot_outcome/at/scheduled/report e chiude la conversazione.
 */
export async function sendOutcome(
  supabase: Supa,
  conversationId: number,
  args: SendOutcomeArgs,
): Promise<{ sent: boolean; status?: number; error?: string }> {
  const secret = process.env.BOT_WEBHOOK_SECRET;
  if (!secret) return { sent: false, error: 'not_configured' };

  const { data: conv } = await supabase
    .from('conversations')
    .select('crm_lead_id')
    .eq('id', conversationId)
    .maybeSingle();
  const crmLeadId = (conv as { crm_lead_id: string | null } | null)?.crm_lead_id ?? null;
  if (!crmLeadId) return { sent: false, error: 'not_crm_lead' };

  const body: BotOutcomeBody = {
    leadId: crmLeadId,
    outcome: args.outcome,
    ...(args.date ? { date: args.date } : {}),
    ...(args.note ? { note: args.note } : {}),
    ...(args.discardReason ? { discardReason: args.discardReason } : {}),
    ...(args.report ? { report: args.report } : {}),
  };

  const valid = validateOutcomeBody(body);
  if (!valid.ok) {
    await supabase.from('event_log').insert({
      type: 'bot_outcome_error',
      payload: { conversationId, crmLeadId, reason: valid.reason } as never,
      message: `[bot-fissatore] outcome non valido per lead ${crmLeadId}: ${valid.reason}`,
      level: 'error',
    });
    return { sent: false, error: valid.reason };
  }

  const rawBody = JSON.stringify(body);
  const url = process.env.CRM_OUTCOME_URL ?? DEFAULT_CRM_URL;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bot-signature': signPayload(rawBody, secret) },
      body: rawBody,
    });
    if (res.ok) {
      await supabase.from('conversations').update({
        bot_outcome: args.outcome,
        bot_outcome_at: new Date().toISOString(),
        bot_scheduled_at: args.date ?? null,
        bot_report: (args.report ?? null) as never,
        ai_status: 'closed',
      }).eq('id', conversationId);
      await supabase.from('event_log').insert({
        type: 'bot_outcome_sent',
        payload: { conversationId, crmLeadId, outcome: args.outcome } as never,
        message: `[bot-fissatore] esito ${args.outcome} inviato per lead ${crmLeadId}`,
        level: 'info',
      });
      return { sent: true, status: res.status };
    }
    const text = await res.text().catch(() => '');
    await supabase.from('event_log').insert({
      type: 'bot_outcome_error',
      payload: { conversationId, crmLeadId, status: res.status, body: text } as never,
      message: `[bot-fissatore] callback CRM ha risposto ${res.status} per lead ${crmLeadId}`,
      level: 'error',
    });
    return { sent: false, status: res.status, error: text || `http_${res.status}` };
  } catch (e) {
    await supabase.from('event_log').insert({
      type: 'bot_outcome_error',
      payload: { conversationId, crmLeadId, error: e instanceof Error ? e.message : 'errore' } as never,
      message: `[bot-fissatore] callback CRM fallito (rete) per lead ${crmLeadId}`,
      level: 'error',
    });
    return { sent: false, error: e instanceof Error ? e.message : 'errore' };
  }
}
