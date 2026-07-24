import type { getSupabaseAdmin } from './supabase/admin';
import { signPayload } from './bot-hmac';
import { validateOutcomeBody, type BotOutcome, type BotOutcomeBody, type BotReport } from './bot-contract';
import { resolveOutcomeAction } from './bot-outcome-rules';

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
export type SendOutcomeOpts = {
  /** RICHIAMO non-terminale: POST al CRM per visibilità, ma la conversazione resta
   * aperta e bot_outcome non viene toccato (la sequenza continua). */
  interim?: boolean;
};

export async function sendOutcome(
  supabase: Supa,
  conversationId: number,
  args: SendOutcomeArgs,
  opts: SendOutcomeOpts = {},
): Promise<{ sent: boolean; status?: number; error?: string }> {
  const interim = opts.interim === true && args.outcome === 'RICHIAMO';
  const secret = process.env.BOT_WEBHOOK_SECRET;
  if (!secret) return { sent: false, error: 'not_configured' };

  const { data: conv } = await supabase
    .from('conversations')
    .select('crm_lead_id, bot_outcome, bot_scheduled_at')
    .eq('id', conversationId)
    .maybeSingle();
  const row = conv as { crm_lead_id: string | null; bot_outcome: string | null; bot_scheduled_at: string | null } | null;
  const crmLeadId = row?.crm_lead_id ?? null;
  if (!crmLeadId) return { sent: false, error: 'not_crm_lead' };

  const action = resolveOutcomeAction(
    (row?.bot_outcome ?? null) as BotOutcome | null,
    args,
    row?.bot_scheduled_at ?? null,
  );

  // RICHIAMO interim: mai su lead già esitati (un RICHIAMO su un APPUNTAMENTO lo
  // riporterebbe indietro di stato lato CRM — avvertenza esplicita del loro team).
  if (interim && action.kind !== 'normal') {
    return { sent: false, error: 'interim_skipped_locked' };
  }

  // Lead già fissato ma senza data originale: non possiamo re-inviare APPUNTAMENTO
  // (la data è obbligatoria). Non declassiamo: logghiamo un warning ed usciamo.
  if (action.kind === 'locked' && !action.date) {
    await supabase.from('event_log').insert({
      type: 'bot_outcome_locked',
      level: 'warn',
      payload: { conversationId, crmLeadId, attemptedOutcome: args.outcome, keptOutcome: 'APPUNTAMENTO' } as never,
      message: `[bot-fissatore] esito ${args.outcome} ignorato: lead ${crmLeadId} già APPUNTAMENTO senza data`,
    });
    return { sent: true };
  }

  const body: BotOutcomeBody = action.kind === 'locked'
    ? {
        leadId: crmLeadId,
        outcome: 'APPUNTAMENTO',
        date: action.date as string,
        note: action.note,
        ...(args.report ? { report: args.report } : {}),
      }
    : {
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
      if (interim) {
        // Visibilità sul cruscotto CRM, ma la lavorazione continua: niente
        // bot_outcome, niente chiusura.
        await supabase.from('event_log').insert({
          type: 'bot_outcome_sent',
          payload: { conversationId, crmLeadId, outcome: args.outcome, interim: true } as never,
          message: `[bot-fissatore] RICHIAMO interim inviato per lead ${crmLeadId} (sequenza in corso)`,
          level: 'info',
        });
        return { sent: true, status: res.status };
      }
      if (action.kind === 'normal') {
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
      } else {
        // Lead terminale: l'esito resta congelato (niente bot_outcome/date), ma la
        // conversazione va richiusa: se restasse 'active' il cron backstop la
        // riclassificherebbe a ogni run, ri-inviando l'APPUNTAMENTO al CRM.
        await supabase.from('conversations').update({ ai_status: 'closed' }).eq('id', conversationId);
        await supabase.from('event_log').insert({
          type: 'bot_outcome_locked',
          payload: { conversationId, crmLeadId, attemptedOutcome: args.outcome, keptOutcome: 'APPUNTAMENTO', note: action.note } as never,
          message: `[bot-fissatore] esito ${args.outcome} intercettato (lead ${crmLeadId} già APPUNTAMENTO) → nota CRM`,
          level: 'info',
        });
      }
      return { sent: true, status: res.status };
    }
    const text = await res.text().catch(() => '');
    if (res.status === 403) {
      // Il CRM rifiuta l'esito (lead non più assegnato al bot, es. già richiamato
      // nel pool umano): ritentare non può che ridare 403, quindi registra l'esito
      // localmente e chiudi la conversazione per fermare il loop del cron.
      // (Per gli interim niente persistenza: RICHIAMO non è un esito nostro.)
      if (action.kind === 'normal' && !interim) {
        await supabase.from('conversations').update({
          bot_outcome: args.outcome,
          bot_outcome_at: new Date().toISOString(),
          bot_scheduled_at: args.date ?? null,
          bot_report: (args.report ?? null) as never,
          ai_status: 'closed',
        }).eq('id', conversationId);
      } else if (!interim) {
        // Lead terminale: mai declassare bot_outcome, chiudi soltanto.
        await supabase.from('conversations').update({ ai_status: 'closed' }).eq('id', conversationId);
      }
      await supabase.from('event_log').insert({
        type: 'bot_outcome_rejected',
        payload: { conversationId, crmLeadId, outcome: args.outcome, status: res.status, body: text } as never,
        message: `[bot-fissatore] CRM ha rifiutato (403) l'esito ${args.outcome} per lead ${crmLeadId}: chiuso localmente`,
        level: 'warn',
      });
      return { sent: false, status: res.status, error: text || 'http_403' };
    }
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
