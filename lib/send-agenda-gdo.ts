import type { getSupabaseAdmin } from './supabase/admin';
import type { SendAgendaPayload } from './bot-contract';
import { enrollGdoLeadAsPostino } from './fenice-enroll';
import {
  DELIVERY_WAIT_MS,
  isDedupHit,
  waitForDelivery,
  type SendAgendaEsito,
} from './gdo-agenda';
import { toE164 } from './phone';

type Supa = ReturnType<typeof getSupabaseAdmin>;

export type SendAgendaResult = {
  ok: boolean;
  esito: SendAgendaEsito;
  /** Vero se l'invio è stato saltato perché identico a uno di pochi minuti prima. */
  deduplicato?: boolean;
  conversationId?: number;
  sid?: string;
  error?: string;
};

export type SendAgendaDeps = {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Attesa massima della consegna, dall'inizio della richiesta. */
  waitMs?: number;
};

/**
 * Il flusso completo dietro `POST /api/send-agenda`: il GDO è al telefono col lead e
 * ha appena cliccato "Agenda". Manda il template, aspetta un attimo la consegna e
 * risponde con uno dei tre esiti. Nessun passo può lasciare il GDO senza risposta:
 * anche i fallimenti sono un esito, non un errore da interpretare.
 */
export async function runSendAgenda(
  supabase: Supa,
  payload: SendAgendaPayload,
  deps: SendAgendaDeps = {},
): Promise<SendAgendaResult> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const waitMs = deps.waitMs ?? DELIVERY_WAIT_MS;
  const start = now();

  const phone = toE164(payload.phone);
  if (!phone) {
    await supabase.from('event_log').insert({
      type: 'gdo_agenda_skipped',
      payload: { crmLeadId: payload.leadId, phone: payload.phone } as never,
      message: `[gdo] telefono non normalizzabile per il lead ${payload.leadId}: ${payload.phone}`,
      level: 'warn',
    });
    return { ok: false, esito: 'fallito', error: 'invalid_phone' };
  }

  // Deduplica: il GDO che non vede arrivare nulla riclicca. Rimandare farebbe
  // arrivare due messaggi identici al lead che ha solo il telefono offline.
  const { data: precedenti } = await supabase
    .from('conversations')
    .select('id, gdo_agenda_at, gdo_agenda_esito')
    .eq('crm_lead_id', payload.leadId)
    .order('gdo_agenda_at', { ascending: false })
    .limit(1);
  const precedente = ((precedenti ?? []) as unknown as {
    id: number;
    gdo_agenda_at: string | null;
    gdo_agenda_esito: string | null;
  }[])[0];

  if (
    precedente &&
    isDedupHit({
      lastAgendaAtMs: precedente.gdo_agenda_at ? Date.parse(precedente.gdo_agenda_at) : null,
      lastEsito: precedente.gdo_agenda_esito,
      nowMs: start,
    })
  ) {
    const esito = (precedente.gdo_agenda_esito ?? 'inviato') as SendAgendaEsito;
    await supabase.from('event_log').insert({
      type: 'gdo_agenda_dedup',
      payload: { crmLeadId: payload.leadId, conversationId: precedente.id, esito } as never,
      message: `[gdo] agenda già inviata da meno di 15 minuti al lead ${payload.leadId}: non rimandata (${esito})`,
      level: 'info',
    });
    return { ok: true, esito, deduplicato: true, conversationId: precedente.id };
  }

  const inviata = await enrollGdoLeadAsPostino(supabase, {
    phone,
    name: payload.name,
    email: payload.email,
    crmLeadId: payload.leadId,
    crmFunnel: payload.funnel,
    variant: payload.variant,
  });

  if (!inviata.ok || !inviata.sid) {
    return {
      ok: false,
      esito: 'fallito',
      conversationId: inviata.conversationId,
      error: inviata.error ?? 'send_failed',
    };
  }

  // Attesa della consegna: lo stato lo aggiornano le status callback di Twilio sul
  // webhook, qui si rilegge la riga del messaggio. Il budget parte dall'inizio della
  // richiesta, non da adesso: l'invio ha già consumato una parte dei 10s del CRM.
  const esito = await waitForDelivery({
    readStatus: async () => {
      const { data } = await supabase
        .from('messages')
        .select('twilio_status')
        .eq('twilio_sid', inviata.sid as string)
        .maybeSingle();
      return (data as { twilio_status: string | null } | null)?.twilio_status ?? null;
    },
    now,
    sleep,
    waitMs: Math.max(0, waitMs - (now() - start)),
  });

  await supabase
    .from('conversations')
    .update({ gdo_agenda_esito: esito })
    .eq('id', inviata.conversationId);

  await supabase.from('event_log').insert({
    type: 'gdo_agenda_esito',
    payload: { crmLeadId: payload.leadId, conversationId: inviata.conversationId, sid: inviata.sid, esito } as never,
    message: `[gdo] agenda per il lead ${payload.leadId}: ${esito}`,
    level: 'info',
  });

  return { ok: true, esito, conversationId: inviata.conversationId, sid: inviata.sid };
}
