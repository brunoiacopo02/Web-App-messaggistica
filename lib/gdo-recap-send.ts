/**
 * La presa del recap GDO: chi la vince lo manda, gli altri no. È un update
 * condizionale sulla riga della conversazione, così due drain (o il drain e un
 * webhook) non mandano lo stesso riassunto due volte per la stessa call.
 */

import { decideGdoRecap, gdoRecapText, gdoSpostamentoText, type RecapOccasione, type RecapTipo } from './gdo-recap';
import { mittenteDiConversazione } from './mittente';
import { sendFreeText } from './twilio';

type Supa = {
  from: (t: string) => any;
};

/**
 * Segna il recap per la call di `appuntamentoAt` solo se per quella stessa call non è
 * già uscito. Con `conNoemi` segna anche il promemoria di Noemi, se mancava: il recap
 * la nomina, e il bot non deve rispiegarla al turno dopo. Torna `true` se ha preso il
 * recap (una riga aggiornata).
 */
export async function claimRecap(
  supabase: Supa,
  conversationId: number,
  appuntamentoAt: string,
  conNoemi: boolean,
): Promise<boolean> {
  // L'istante arriva in fusi diversi (CRM con +02:00, colonna in UTC): nel filtro
  // dell'URL il confronto deve avvenire sulla stessa scrittura.
  const at = new Date(appuntamentoAt).toISOString();
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('conversations')
    .update({ gdo_recap_for_at: at, gdo_recap_sent_at: now })
    .eq('id', conversationId)
    .or(`gdo_recap_for_at.is.null,gdo_recap_for_at.neq.${at}`)
    .select('id');
  if (error) {
    console.error(`[gdo] claim del recap fallito su conv ${conversationId}: ${error.message}`);
    return false;
  }
  if (!data || data.length === 0) return false;
  if (conNoemi) {
    await supabase
      .from('conversations')
      .update({ gdo_noemi_reminded_at: now })
      .eq('id', conversationId)
      .is('gdo_noemi_reminded_at', null);
  }
  return true;
}

/** Ripristina la presa del recap quando l'invio è fallito: il prossimo giro può riprovare. */
async function rilasciaRecap(
  supabase: Supa,
  conversationId: number,
  appuntamentoAt: string,
  prima: { forAt: string | null; sentAt: string | null },
  noemiImpostataDaQui: boolean,
): Promise<void> {
  const at = new Date(appuntamentoAt).toISOString();
  await supabase
    .from('conversations')
    .update({ gdo_recap_for_at: prima.forAt, gdo_recap_sent_at: prima.sentAt })
    .eq('id', conversationId)
    .eq('gdo_recap_for_at', at);
  if (noemiImpostataDaQui) {
    await supabase
      .from('conversations')
      .update({ gdo_noemi_reminded_at: null })
      .eq('id', conversationId);
  }
}

/**
 * Il CRM ci ha appena dato (o cambiato) la data della call di un lead GDO: se il video è
 * già partito e la finestra di 24 ore è aperta, gli mandiamo il recap in testo libero.
 * Torna il tipo mandato, o `null` se non è uscito niente. Non lancia mai: gli errori vanno
 * in `event_log` come `gdo_recap_errore`.
 */
export async function inviaRecapDopoData(
  supabase: Supa,
  conversationId: number,
  occasione: Extract<RecapOccasione, 'registrato' | 'spostato'>,
  nowMs: number = Date.now(),
): Promise<RecapTipo | null> {
  let claimed: { at: string; prima: { forAt: string | null; sentAt: string | null }; noemi: boolean } | null = null;
  try {
    const { data: conv, error } = await supabase
      .from('conversations')
      .select('id, bot_outcome, gdo_agenda_at, gdo_appuntamento_at, gdo_video_url, gdo_video_sent_at, gdo_recap_for_at, gdo_recap_sent_at, gdo_noemi_reminded_at, ai_paused_at, cancel_requested_at, last_inbound_at, wa_number, leads(phone_e164, first_name)')
      .eq('id', conversationId)
      .single();
    if (error || !conv) return null;

    const tipo = decideGdoRecap({
      enabled: process.env.GDO_RECAP_ENABLED === '1',
      occasione,
      gdoAgendaAt: conv.gdo_agenda_at ?? null,
      botOutcome: conv.bot_outcome ?? null,
      appuntamentoAt: conv.gdo_appuntamento_at ?? null,
      recapForAt: conv.gdo_recap_for_at ?? null,
      videoSentAt: conv.gdo_video_sent_at ?? null,
      lastInboundAtMs: conv.last_inbound_at ? Date.parse(conv.last_inbound_at) : null,
      aiPausedAt: conv.ai_paused_at ?? null,
      cancelRequestedAt: conv.cancel_requested_at ?? null,
      nowMs,
    });
    const phone: string | undefined = conv.leads?.phone_e164 ?? undefined;
    if (!tipo || !phone || !conv.gdo_appuntamento_at) return null;

    const conNoemi = tipo !== 'spostamento';
    const appuntamentoAt: string = conv.gdo_appuntamento_at;
    // I valori di prima si fotografano PRIMA della presa: servono a rilasciarla se l'invio fallisce.
    const prima = { forAt: conv.gdo_recap_for_at ?? null, sentAt: conv.gdo_recap_sent_at ?? null };
    const noemiDaQui = conNoemi && !conv.gdo_noemi_reminded_at;
    if (!(await claimRecap(supabase, conversationId, appuntamentoAt, conNoemi))) return null;
    claimed = { at: appuntamentoAt, prima, noemi: noemiDaQui };

    const nome = conv.leads?.first_name ?? null;
    const call = new Date(appuntamentoAt);
    const body = tipo === 'spostamento'
      ? gdoSpostamentoText({ nome, call })
      : gdoRecapText({ nome, call, videoLink: null });
    const sent = await sendFreeText({ to: phone, body, from: mittenteDiConversazione(conv) });

    // Riga del messaggio ed evento solo a invio riuscito.
    await supabase.from('messages').insert({
      conversation_id: conversationId, direction: 'out', body,
      twilio_sid: sent.sid, twilio_status: sent.status,
      sender: 'bot',
    });
    await supabase.from('conversations')
      .update({ last_message_at: new Date().toISOString() })
      .eq('id', conversationId);
    await supabase.from('event_log').insert({
      type: 'gdo_recap_sent',
      payload: { conversationId, tipo, occasione } as never,
      message: `[gdo] conv ${conversationId}: recap (${tipo}) mandato dopo la data del CRM`,
      level: 'info',
    });
    return tipo;
  } catch (e) {
    const error = e instanceof Error ? e.message : 'errore';
    try {
      if (claimed) await rilasciaRecap(supabase, conversationId, claimed.at, claimed.prima, claimed.noemi);
      await supabase.from('event_log').insert({
        type: 'gdo_recap_errore',
        payload: { conversationId, occasione, error } as never,
        message: `[gdo] conv ${conversationId}: recap dopo la data fallito: ${error}`,
        level: 'error',
      });
    } catch (e2) {
      console.error(`[gdo] recap fallito su conv ${conversationId} e anche il log: ${e2 instanceof Error ? e2.message : e2}`);
    }
    return null;
  }
}
