import type { getSupabaseAdmin } from './supabase/admin';
import type { SendAgendaPayload } from './bot-contract';
import { signPayload } from './bot-hmac';
import { enrollGdoLeadAsPostino } from './fenice-enroll';
import {
  DELIVERY_WAIT_MS,
  esitoFromTwilioStatus,
  isDedupHit,
  videoLinkForVariant,
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
  /** Il GDO ha corretto la variante entro la finestra: il video è stato aggiornato. */
  varianteAggiornata?: boolean;
  /** La correzione è arrivata dopo che il video era già partito: non è più rimediabile. */
  videoGiaInviato?: boolean;
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
    .select('id, gdo_agenda_at, gdo_agenda_esito, gdo_video_url, gdo_video_sent_at')
    .eq('crm_lead_id', payload.leadId)
    .order('gdo_agenda_at', { ascending: false })
    .limit(1);
  const precedente = ((precedenti ?? []) as unknown as {
    id: number;
    gdo_agenda_at: string | null;
    gdo_agenda_esito: string | null;
    gdo_video_url: string | null;
    gdo_video_sent_at: string | null;
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

    // Il GDO può aver ricliccato perché aveva sbagliato lavora/famiglia. L'agenda non
    // si rimanda comunque — il lead riceverebbe due volte lo stesso testo — ma il video
    // che parte alla sua risposta dev'essere quello giusto.
    const videoCorretto = videoLinkForVariant(payload.variant);
    if (precedente.gdo_video_url && videoCorretto !== precedente.gdo_video_url) {
      if (precedente.gdo_video_sent_at) {
        // Correzione tardiva: il lead ha già in mano il video sbagliato. Riscrivere la
        // colonna non lo rimedierebbe e nasconderebbe il problema al GDO.
        await supabase.from('event_log').insert({
          type: 'gdo_variante_tardiva',
          payload: { crmLeadId: payload.leadId, conversationId: precedente.id, inviato: precedente.gdo_video_url, richiesto: videoCorretto } as never,
          message: `[gdo] variante corretta troppo tardi per il lead ${payload.leadId}: il video ${precedente.gdo_video_url} è già partito`,
          level: 'warn',
        });
        return { ok: true, esito, deduplicato: true, varianteAggiornata: false, videoGiaInviato: true, conversationId: precedente.id };
      }
      await supabase.from('conversations').update({ gdo_video_url: videoCorretto }).eq('id', precedente.id);
      await supabase.from('event_log').insert({
        type: 'gdo_variante_corretta',
        payload: { crmLeadId: payload.leadId, conversationId: precedente.id, precedente: precedente.gdo_video_url, nuovo: videoCorretto } as never,
        message: `[gdo] variante corretta entro la finestra per il lead ${payload.leadId}: il video diventa ${videoCorretto}`,
        level: 'info',
      });
      return { ok: true, esito, deduplicato: true, varianteAggiornata: true, conversationId: precedente.id };
    }

    await supabase.from('event_log').insert({
      type: 'gdo_agenda_dedup',
      payload: { crmLeadId: payload.leadId, conversationId: precedente.id, esito } as never,
      message: `[gdo] agenda già inviata da meno di 15 minuti al lead ${payload.leadId}: non rimandata (${esito})`,
      level: 'info',
    });
    return { ok: true, esito, deduplicato: true, varianteAggiornata: false, conversationId: precedente.id };
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

/**
 * Chiude il caso "inviato": una status callback di Twilio dice che l'agenda finita in
 * `inviato` è poi arrivata davvero. Senza questo il lead resterebbe per sempre in uno
 * stato ambiguo e il CRM terrebbe bloccato il reinvio a tempo indeterminato.
 *
 * Aggiorna il nostro esito e avvisa il CRM una volta sola (stessa firma HMAC di tutto
 * il resto). Idempotente: le callback di Twilio si ripetono, ma solo il passaggio
 * `inviato -> consegnato` fa partire l'avviso.
 */
export async function handleGdoDeliveryUpdate(
  supabase: Supa,
  params: { sid: string; status: string | null },
): Promise<{ updated: boolean; notified: boolean }> {
  const niente = { updated: false, notified: false };
  if (esitoFromTwilioStatus(params.status) !== 'consegnato') return niente;

  const agendaSid = process.env.AGENDA_GDO_TEMPLATE_SID;
  if (!agendaSid) return niente;

  const { data: msg } = await supabase
    .from('messages')
    .select('conversation_id, template_sid')
    .eq('twilio_sid', params.sid)
    .maybeSingle();
  const riga = msg as { conversation_id: number; template_sid: string | null } | null;
  if (!riga || riga.template_sid !== agendaSid) return niente;

  const { data: conv } = await supabase
    .from('conversations')
    .select('id, crm_lead_id, gdo_agenda_esito')
    .eq('id', riga.conversation_id)
    .maybeSingle();
  const c = conv as { id: number; crm_lead_id: string | null; gdo_agenda_esito: string | null } | null;
  // Solo il passaggio inviato -> consegnato è una notizia: tutto il resto è rumore.
  if (!c || c.gdo_agenda_esito !== 'inviato') return niente;

  await supabase.from('conversations').update({ gdo_agenda_esito: 'consegnato' }).eq('id', c.id);
  await supabase.from('event_log').insert({
    type: 'gdo_agenda_consegna_tardiva',
    payload: { crmLeadId: c.crm_lead_id, conversationId: c.id, sid: params.sid, status: params.status } as never,
    message: `[gdo] l'agenda del lead ${c.crm_lead_id} risultava inviata ed è stata consegnata`,
    level: 'info',
  });

  const url = process.env.CRM_AGENDA_DELIVERED_URL;
  const secret = process.env.BOT_WEBHOOK_SECRET;
  if (!url || !secret || !c.crm_lead_id) return { updated: true, notified: false };

  const body = JSON.stringify({
    leadId: c.crm_lead_id,
    esito: 'consegnato',
    sid: params.sid,
    at: new Date().toISOString(),
  });
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bot-signature': signPayload(body, secret) },
      body,
    });
    if (res.ok) return { updated: true, notified: true };
    await supabase.from('event_log').insert({
      type: 'gdo_agenda_notifica_fallita',
      payload: { crmLeadId: c.crm_lead_id, conversationId: c.id, status: res.status } as never,
      message: `[gdo] il CRM ha risposto ${res.status} all'avviso di consegna per il lead ${c.crm_lead_id}`,
      level: 'error',
    });
  } catch (e) {
    await supabase.from('event_log').insert({
      type: 'gdo_agenda_notifica_fallita',
      payload: { crmLeadId: c.crm_lead_id, conversationId: c.id, error: e instanceof Error ? e.message : 'errore' } as never,
      message: `[gdo] avviso di consegna al CRM fallito (rete) per il lead ${c.crm_lead_id}`,
      level: 'error',
    });
  }
  // Il nostro esito resta corretto anche se il CRM non ha ricevuto l'avviso.
  return { updated: true, notified: false };
}
