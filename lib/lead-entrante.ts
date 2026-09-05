import type { getSupabaseAdmin } from './supabase/admin';
import { signPayload } from './bot-hmac';

type Supa = ReturnType<typeof getSupabaseAdmin>;

// Canonica, non un deployment URL: gli host *-brunoiacopo02s-projects.vercel.app hanno
// la Deployment Protection attiva e tornerebbero una pagina di login (HTML) al posto
// del JSON che questa funzione si aspetta di leggere.
const DEFAULT_CRM_LEAD_ENTRANTE_URL = 'https://crm-sales-fenice.vercel.app/api/bot/lead-entrante';

export type PushLeadEntranteArgs = {
  conversationId: number;
  /** E.164. */
  telefono: string;
  nome: string | null;
  /** 'TELEGRAM' o 'INBOUND'. */
  provenienza: string;
  primoMessaggio: string | null;
  /** ISO 8601 con offset esplicito: il `created_at` del primo inbound. */
  scrittoIl: string;
};

export type PushLeadEntranteResult = { ok: boolean; leadId?: string; motivo?: string };

type LeadEntranteBody = {
  telefono: string;
  nome: string | null;
  provenienza: string;
  primoMessaggio: string | null;
  scrittoIl: string;
  conversationId: number;
};

type LeadEntranteResponseBody = { ok?: boolean; leadId?: string; creato?: boolean; motivo?: string };

/**
 * Spinge al CRM il lead appena adottato, cosi' il suo esito ha dove tornare.
 *
 * Fino ad ora il verso era uno solo: il CRM interrogava `/api/bot/lead-entranti` per
 * scoprire chi avevamo adottato. Questo e' il verso opposto — un push, un lead per
 * chiamata, subito dopo un'adozione riuscita — cosi' il `leadId` arriva prima, non al
 * prossimo giro della loro lista.
 *
 * Non ritenta e non lancia mai: la chiamata parte dopo la risposta a Twilio (o dentro
 * un cron che non ha un Twilio da non far aspettare), e in ogni caso la rete di
 * sicurezza resta `/api/bot/lead-entranti` — se questo push non arriva o fallisce, quel
 * lead ricompare li' al giro dopo.
 */
export async function pushLeadEntrante(
  supabase: Supa,
  args: PushLeadEntranteArgs,
): Promise<PushLeadEntranteResult> {
  const secret = process.env.BOT_WEBHOOK_SECRET;
  if (!secret) {
    await supabase.from('event_log').insert({
      type: 'lead_entrante_push_error',
      payload: { conversationId: args.conversationId, motivo: 'not_configured' } as never,
      message: `[lead-entrante] BOT_WEBHOOK_SECRET assente: push non inviato per conv ${args.conversationId}`,
      level: 'warn',
    });
    return { ok: false, motivo: 'not_configured' };
  }

  const url = process.env.CRM_LEAD_ENTRANTE_URL ?? DEFAULT_CRM_LEAD_ENTRANTE_URL;
  const body: LeadEntranteBody = {
    telefono: args.telefono,
    nome: args.nome,
    provenienza: args.provenienza,
    primoMessaggio: args.primoMessaggio,
    scrittoIl: args.scrittoIl,
    conversationId: args.conversationId,
  };
  const rawBody = JSON.stringify(body);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bot-signature': signPayload(rawBody, secret) },
      body: rawBody,
    });
    const testo = await res.text().catch(() => '');
    let parsed: LeadEntranteResponseBody | null = null;
    try { parsed = testo ? (JSON.parse(testo) as LeadEntranteResponseBody) : null; } catch { parsed = null; }

    if (res.ok && parsed?.ok === true && typeof parsed.leadId === 'string' && parsed.leadId) {
      const leadId = parsed.leadId;
      const creato = parsed.creato === true;
      await supabase.from('conversations').update({ crm_lead_id: leadId }).eq('id', args.conversationId);
      await supabase.from('event_log').insert({
        type: 'lead_entrante_push',
        payload: { conversationId: args.conversationId, leadId, creato, provenienza: args.provenienza } as never,
        message: `[lead-entrante] lead ${creato ? 'creato' : 'gia esistente'} sul CRM (${leadId}) per conv ${args.conversationId}`,
        level: 'info',
      });
      return { ok: true, leadId };
    }

    if (res.ok && parsed?.ok === false && parsed.motivo === 'altra_azienda') {
      // Nessuna scrittura su `conversations`: quel numero non e' un lead nostro, non
      // gli si attacca un crm_lead_id. `provenienza` e' il marcatore con cui capire se
      // il caso e' raro o sistematico: se questi sono tutti TELEGRAM la spiegazione e'
      // che il canale Telegram gira dentro la base Serenamente, se sono INBOUND
      // spontanei e' un'altra storia — e serve saperlo per decidere cosa fare.
      await supabase.from('event_log').insert({
        type: 'lead_entrante_altra_azienda',
        payload: { conversationId: args.conversationId, telefono: args.telefono, provenienza: args.provenienza } as never,
        message: `[lead-entrante] il numero di conv ${args.conversationId} e' di Serenamente (provenienza ${args.provenienza}): nessun crm_lead_id scritto`,
        level: 'warn',
      });
      return { ok: false, motivo: 'altra_azienda' };
    }

    // Tutto il resto: telefono_non_valido, un 2xx con un corpo che non torna quello
    // atteso, o un qualunque altro status. La rete di sicurezza e' comunque
    // `/api/bot/lead-entranti`, quindi qui si logga e si esce senza mai lanciare.
    const motivo = typeof parsed?.motivo === 'string' ? parsed.motivo : `http_${res.status}`;
    await supabase.from('event_log').insert({
      type: 'lead_entrante_push_error',
      // `body` tagliato a 300 caratteri di proposito: se l'URL finisce per sbaglio su un
      // host con la Deployment Protection di Vercel, la risposta non e' JSON ma una
      // pagina di login da qualche KB — e finirebbe intera dentro `event_log`, a ogni
      // lead adottato. I primi 300 caratteri bastano a riconoscerla.
      payload: { conversationId: args.conversationId, telefono: args.telefono, status: res.status, motivo, body: testo.slice(0, 300) } as never,
      message: `[lead-entrante] push non riuscito per conv ${args.conversationId}: ${motivo}`,
      level: 'warn',
    });
    return { ok: false, motivo };
  } catch (e) {
    const errore = e instanceof Error ? e.message : 'errore';
    await supabase.from('event_log').insert({
      type: 'lead_entrante_push_error',
      payload: { conversationId: args.conversationId, telefono: args.telefono, motivo: errore } as never,
      message: `[lead-entrante] push fallito (rete) per conv ${args.conversationId}: ${errore}`,
      level: 'warn',
    });
    return { ok: false, motivo: errore };
  }
}
