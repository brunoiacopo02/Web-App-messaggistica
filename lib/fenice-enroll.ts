import type { getSupabaseAdmin } from './supabase/admin';
import { findOrCreateLeadConversation, sendTemplateAndLog } from './messaging';
import { feniceOpening } from './fenice-opening';
import { inSendWindow } from './sequence';
import { normalizeFunnel, variantIndexFor, openingEnvKey, openingBody } from './persona';
import { firstNameOf, templateName } from './name';
import type { GdoVariant } from './bot-contract';
import { gdoAgendaText, videoLinkForVariant } from './gdo-agenda';

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
  // Il CRM manda nome+cognome in un campo solo: negli invii va solo il nome proprio.
  const cleanName = firstNameOf(firstName);
  let variables: Record<string, string> = cleanName ? { '3': cleanName } : {};
  let bodyOverride = feniceOpening(firstName);
  if (process.env.NEW_OPENING_ENABLED === '1') {
    const funnel = normalizeFunnel(args.crmFunnel);
    const variant = variantIndexFor(conversationId);
    const envKey = openingEnvKey(funnel, variant);
    const openingSid = process.env[envKey];
    if (openingSid) {
      sendSid = openingSid;
      sendLabel = `Apertura ${envKey}`;
      variables = { '1': templateName(firstName) };
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

export type GdoEnrollArgs = {
  phone: string; // già E.164
  name?: string | null;
  email?: string | null;
  crmLeadId: string;
  crmFunnel?: string | null;
  variant: GdoVariant;
};

/**
 * Arruola in modalità POSTINO un lead che resta di proprietà del GDO: manda il
 * template agenda e prepara la conversazione per il video, che partirà alla prima
 * risposta del lead (vedi `drainMarioReplies`).
 *
 * Tre differenze dall'arruolamento normale, tutte volute:
 * - si invia SEMPRE, anche fuori dalla fascia 08:30–20:30: il GDO è al telefono col
 *   lead proprio adesso, un'apertura differita gli farebbe dire una cosa falsa;
 * - la conversazione viene RIAPERTA anche se era chiusa/booked con un esito nostro:
 *   sui lead già passati dal bot, all'arrivo dell'agenda vince il GDO;
 * - `ai_started_at` riparte da adesso, così Mario legge solo la parte postino della
 *   cronologia e non ricomincia il vecchio pitch.
 *
 * `gdo_agenda_at` è anche il marcatore che tiene questi lead fuori dalla sequenza,
 * dal follow-up agenda e dalla classificazione a 14 giorni.
 */
export async function enrollGdoLeadAsPostino(
  supabase: Supa,
  args: GdoEnrollArgs,
): Promise<{ ok: boolean; conversationId: number; sid?: string; error?: string }> {
  const templateSid = process.env.AGENDA_GDO_TEMPLATE_SID;
  const from = process.env.TWILIO_WHATSAPP_NUMBER_FENICE;
  if (!templateSid) throw new Error('AGENDA_GDO_TEMPLATE_SID non configurato');
  if (!from) throw new Error('TWILIO_WHATSAPP_NUMBER_FENICE non configurato');

  const { conversationId } = await findOrCreateLeadConversation(supabase, {
    phone: args.phone,
    firstName: args.name ?? undefined,
    email: args.email ?? undefined,
  });

  const res = await sendTemplateAndLog(
    supabase,
    conversationId,
    args.phone,
    templateSid,
    'Agenda GDO',
    from,
    { '1': templateName(args.name) },
    gdoAgendaText(args.name),
  );

  const now = new Date().toISOString();
  await supabase
    .from('conversations')
    .update({
      ai_owner: 'mario',
      ai_status: 'active',
      ai_started_at: now,
      ai_lock_at: null,
      crm_lead_id: args.crmLeadId,
      crm_funnel: args.crmFunnel ?? null,
      gdo_agenda_at: now,
      // Esito provvisorio: la route lo aggiorna dopo l'attesa di consegna. Se il
      // processo muore prima, la deduplica trova comunque un esito coerente.
      gdo_agenda_esito: res.ok ? 'inviato' : 'fallito',
      gdo_video_url: videoLinkForVariant(args.variant),
      // Nuova agenda = nuovo appuntamento: il video deve poter ripartire, e con lui i
      // suoi due solleciti. Senza questo azzeramento un lead ri-arruolato (il GDO
      // sposta la call, cosa ordinaria) resterebbe a followups 2 e con la conferma
      // del video vecchia: decideGdoVideoFollowup direbbe 'none' per sempre.
      gdo_video_sent_at: null,
      gdo_video_followups_sent: 0,
      gdo_video_watched_at: null,
      // gdo_noemi_reminded_at NO: chi è Noemi e cosa fa la sua chiamata si spiega una
      // volta per lead, non a ogni appuntamento. Ripeterlo suonerebbe come un disco.
    })
    .eq('id', conversationId);

  await supabase.from('event_log').insert({
    type: res.ok ? 'gdo_agenda_sent' : 'send_error',
    payload: { phone: args.phone, conversationId, sid: res.sid, error: res.error, crmLeadId: args.crmLeadId } as never,
    message: res.ok
      ? `[gdo] agenda inviata per conto del GDO a ${args.phone}`
      : `[gdo] agenda fallita per ${args.phone}: ${res.error}`,
    level: res.ok ? 'info' : 'error',
  });

  return { ok: res.ok, conversationId, sid: res.sid, error: res.error };
}
