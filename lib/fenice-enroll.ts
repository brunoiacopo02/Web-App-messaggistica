import type { getSupabaseAdmin } from './supabase/admin';
import { findOrCreateLeadConversation, sendTemplateAndLog } from './messaging';
import { feniceOpening } from './fenice-opening';
import { inSendWindow } from './sequence';
import { normalizeFunnel, variantIndexFor, openingEnvKey, openingBody } from './persona';

type Supa = ReturnType<typeof getSupabaseAdmin>;

export type EnrollArgs = {
  phone: string; // già E.164
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  crmLeadId?: string | null;
  crmFunnel?: string | null;
};

/**
 * Arruola un lead nel flusso di Mario: crea/aggiorna lead+conversazione, invia il
 * template di apertura, e marca la conversazione come gestita da Mario (active).
 * Se `crmLeadId` è presente, tagga la conversazione per il callback al CRM.
 * Fuori fascia 08:30–20:30 Europe/Rome l'apertura NON parte subito (`deferred:true`):
 * la conversazione resta attiva senza outbound e il cron sequence-touches la invierà
 * al primo run in fascia.
 */
export async function enrollLeadIntoMario(
  supabase: Supa,
  args: EnrollArgs,
): Promise<{ ok: boolean; conversationId: number; sid?: string; error?: string; deferred?: boolean }> {
  const templateSid = process.env.FENICE_OPENING_TEMPLATE_SID;
  const from = process.env.TWILIO_WHATSAPP_NUMBER_FENICE;
  if (!templateSid || !from) {
    throw new Error('FENICE_OPENING_TEMPLATE_SID o TWILIO_WHATSAPP_NUMBER_FENICE non configurati');
  }

  const firstName = args.firstName ?? undefined;
  const { conversationId } = await findOrCreateLeadConversation(supabase, {
    phone: args.phone,
    firstName,
    lastName: args.lastName ?? undefined,
    email: args.email ?? undefined,
  });

  const convUpdate = {
    ai_owner: 'mario',
    ai_status: 'active',
    ai_started_at: new Date().toISOString(),
    crm_lead_id: args.crmLeadId ?? null,
    crm_funnel: args.crmFunnel ?? null,
  };

  // Apertura differita: di notte i template aprono peggio (-10pt risposta) e
  // disturbano. La conv viene comunque presa in carico da Mario, senza outbound:
  // sarà il cron sequence-touches a inviare l'apertura al primo run in fascia.
  if (!inSendWindow(Date.now())) {
    await supabase.from('conversations').update(convUpdate).eq('id', conversationId);
    await supabase.from('event_log').insert({
      type: 'fenice_enroll_deferred',
      payload: { phone: args.phone, conversationId, crmLeadId: args.crmLeadId ?? null } as never,
      message: `Lead arruolato (Mario), apertura differita in fascia: ${args.phone}`,
      level: 'info',
    });
    return { ok: true, conversationId, deferred: true };
  }

  // Selezione apertura: legacy (Mario) di default; se NEW_OPENING_ENABLED === '1'
  // apertura per-funnel A/B (Marta) con variante per parità di conversationId.
  // SID env mancante → fallback INTERO al ramo legacy + event opening_config_error.
  let sendSid = templateSid;
  let sendLabel = 'Fenice apertura';
  let variables: Record<string, string> = firstName ? { '3': firstName } : {};
  let bodyOverride = feniceOpening(firstName);
  if (process.env.NEW_OPENING_ENABLED === '1') {
    const funnel = normalizeFunnel(args.crmFunnel);
    const variant = variantIndexFor(conversationId);
    const envKey = openingEnvKey(funnel, variant);
    const openingSid = process.env[envKey];
    if (openingSid) {
      sendSid = openingSid;
      sendLabel = `Apertura ${envKey}`;
      variables = { '1': firstName?.trim() || 'benvenuto' };
      bodyOverride = openingBody(funnel, variant, firstName);
    } else {
      await supabase.from('event_log').insert({
        type: 'opening_config_error',
        payload: { phone: args.phone, conversationId, envKey, funnel, variant } as never,
        message: `Apertura A/B: env ${envKey} mancante, fallback al template legacy per ${args.phone}`,
        level: 'error',
      });
    }
  }

  const res = await sendTemplateAndLog(
    supabase, conversationId, args.phone, sendSid, sendLabel, from, variables, bodyOverride,
  );

  await supabase.from('conversations').update(convUpdate).eq('id', conversationId);

  await supabase.from('event_log').insert({
    type: res.ok ? 'fenice_enroll' : 'send_error',
    payload: { phone: args.phone, conversationId, sid: res.sid, error: res.error, crmLeadId: args.crmLeadId ?? null } as never,
    message: res.ok ? `Lead arruolato (Mario): ${args.phone}` : `Arruolamento fallito ${args.phone}: ${res.error}`,
    level: res.ok ? 'info' : 'error',
  });

  return { ok: res.ok, conversationId, sid: res.sid, error: res.error };
}
