import type { getSupabaseAdmin } from './supabase/admin';
import type { AppointmentSetPayload } from './bot-contract';
import { sameInstant } from './rome-time';

type Supa = ReturnType<typeof getSupabaseAdmin>;

export type AppointmentSetEsito = 'registrato' | 'spostato' | 'invariato' | 'lead_sconosciuto';

export type AppointmentSetResult = {
  ok: boolean;
  esito: AppointmentSetEsito;
  conversationId?: number;
  precedente?: string | null;
};

/**
 * Il CRM ci comunica data e ora della call, al primo fissaggio e a ogni spostamento.
 * Sui loro dati la data arriva quasi sempre DOPO l'agenda (265 casi su 274, in media 65
 * secondi dopo): il primo set e lo spostamento sono lo stesso gesto, e vince sempre
 * l'ultima data ricevuta.
 *
 * Con questa data `lib/gdo-video-followup.ts` smette di indovinare: oggi usa
 * ORA_AGENDA_TARDI=18 come ripiego e tace del tutto se l'agenda arriva a sera.
 *
 * Scrive solo `gdo_appuntamento_at`. `bot_scheduled_at` resta il registro del NOSTRO
 * esito: riscriverlo qui cambierebbe il significato delle note di spostamento e la
 * logica del lead terminale in `resolveOutcomeAction`.
 */
export async function runAppointmentSet(
  supabase: Supa,
  payload: AppointmentSetPayload,
): Promise<AppointmentSetResult> {
  const { data } = await supabase
    .from('conversations')
    .select('id, gdo_appuntamento_at')
    .eq('crm_lead_id', payload.leadId)
    .order('id', { ascending: false })
    .limit(1);
  const conv = ((data ?? []) as unknown as { id: number; gdo_appuntamento_at: string | null }[])[0];

  if (!conv) {
    // Succede davvero: il GDO fissa un lead che il bot non ha mai avuto in carico. Un
    // 404 li manderebbe in ritentativo su una cosa che non cambiera'.
    await supabase.from('event_log').insert({
      type: 'appuntamento_lead_sconosciuto',
      payload: { crmLeadId: payload.leadId, appointmentAt: payload.appointmentAt } as never,
      message: `[crm] data appuntamento per un lead che non abbiamo: ${payload.leadId}`,
      level: 'info',
    });
    return { ok: true, esito: 'lead_sconosciuto' };
  }

  const precedente = conv.gdo_appuntamento_at;
  // Confronto per istante, non per stringa: la stessa ora torna da Postgres in UTC e da
  // loro nel fuso italiano, quindi due stringhe diverse sono spesso lo stesso momento.
  if (precedente && sameInstant(payload.appointmentAt, precedente)) {
    return { ok: true, esito: 'invariato', conversationId: conv.id, precedente };
  }

  await supabase
    .from('conversations')
    .update({ gdo_appuntamento_at: payload.appointmentAt })
    .eq('id', conv.id);

  if (precedente) {
    await supabase.from('event_log').insert({
      type: 'appuntamento_spostato',
      payload: { crmLeadId: payload.leadId, conversationId: conv.id, da: precedente, a: payload.appointmentAt } as never,
      message: `[crm] appuntamento del lead ${payload.leadId} spostato da ${precedente} a ${payload.appointmentAt}`,
      level: 'info',
    });
    return { ok: true, esito: 'spostato', conversationId: conv.id, precedente };
  }

  await supabase.from('event_log').insert({
    type: 'appuntamento_registrato',
    payload: { crmLeadId: payload.leadId, conversationId: conv.id, appointmentAt: payload.appointmentAt } as never,
    message: `[crm] data della call registrata per il lead ${payload.leadId}: ${payload.appointmentAt}`,
    level: 'info',
  });
  return { ok: true, esito: 'registrato', conversationId: conv.id, precedente: null };
}
