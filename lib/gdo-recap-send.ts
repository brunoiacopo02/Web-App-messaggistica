/**
 * La presa del recap GDO: chi la vince lo manda, gli altri no. È un update
 * condizionale sulla riga della conversazione, così due drain (o il drain e un
 * webhook) non mandano lo stesso riassunto due volte per la stessa call.
 */

import { decideGdoRecap, gdoRecapText, gdoSpostamentoText, type RecapOccasione, type RecapTipo } from './gdo-recap';
import { mittenteDiConversazione } from './mittente';
import { fissatoIlDi } from './noemi-quando';
import { sendFreeText } from './twilio';

type Supa = {
  from: (t: string) => any;
};

/**
 * Segna il recap per la call di `appuntamentoAt` solo se per quella stessa call non è
 * già uscito. Con `conNoemi` segna anche il promemoria di Noemi, se mancava: il recap
 * la nomina, e il bot non deve rispiegarla al turno dopo. Torna `true` se ha preso il
 * recap (una riga aggiornata). Non prende niente se la call ha ormai un'altra data.
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
    // La data per cui si manda deve essere ancora quella della call: se il CRM l'ha
    // spostata nel frattempo, il recap con la data vecchia non si prende.
    .eq('gdo_appuntamento_at', at)
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

async function logErrore(supabase: Supa, conversationId: number, occasione: string, error: string): Promise<void> {
  await supabase.from('event_log').insert({
    type: 'gdo_recap_errore',
    payload: { conversationId, occasione, error } as never,
    message: `[gdo] conv ${conversationId}: recap dopo la data: ${error}`,
    level: 'error',
  });
}

/**
 * Ripristina la presa del recap quando `sendFreeText` ha lanciato (niente è partito): il
 * prossimo giro può riprovare. Torna il messaggio d'errore se il rilascio stesso fallisce.
 * Il promemoria di Noemi si azzera solo se porta ancora il timestamp scritto dal nostro claim.
 */
export async function rilasciaRecap(
  supabase: Supa,
  conversationId: number,
  appuntamentoAt: string,
  prima: { forAt: string | null; sentAt: string | null },
  noemiImpostataDaQui: boolean,
): Promise<string | null> {
  const at = new Date(appuntamentoAt).toISOString();
  // Il claim ha scritto lo stesso `now` in recap_sent_at e nel promemoria: lo si legge prima di ripristinare.
  let scrittoDalClaim: string | null = null;
  if (noemiImpostataDaQui) {
    const { data: riga } = await supabase
      .from('conversations')
      .select('gdo_recap_sent_at')
      .eq('id', conversationId)
      .single();
    scrittoDalClaim = riga?.gdo_recap_sent_at ?? null;
  }
  const { error } = await supabase
    .from('conversations')
    .update({ gdo_recap_for_at: prima.forAt, gdo_recap_sent_at: prima.sentAt })
    .eq('id', conversationId)
    .eq('gdo_recap_for_at', at);
  if (error) return `rilascio del recap fallito: ${error.message}`;
  if (noemiImpostataDaQui && scrittoDalClaim) {
    const { error: e2 } = await supabase
      .from('conversations')
      .update({ gdo_noemi_reminded_at: null })
      .eq('id', conversationId)
      .eq('gdo_noemi_reminded_at', scrittoDalClaim);
    if (e2) return `rilascio del promemoria di Noemi fallito: ${e2.message}`;
  }
  return null;
}

/**
 * Quando conta come fissata la call, per dire quando chiama Noemi (lib/noemi-quando.ts):
 * uno spostamento è un fissaggio nuovo, come per la board Conferme del CRM; altrimenti
 * vale l'arrivo dell'agenda.
 */
function fissatoIlRecap(
  occasione: RecapOccasione,
  conv: { gdo_agenda_at?: string | null; gdo_appuntamento_set_at?: string | null },
  nowMs: number,
): Date {
  if (occasione !== 'spostato') return fissatoIlDi(conv) ?? new Date(nowMs);
  return new Date(nowMs);
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
  let inviato = false;
  let tipoInviato: RecapTipo | null = null;
  let claimed: { at: string; prima: { forAt: string | null; sentAt: string | null }; noemi: boolean } | null = null;
  // Interruttore spento: nessun costo, nemmeno la lettura della conversazione.
  if (process.env.GDO_RECAP_ENABLED !== '1') return null;
  try {
    const { data: conv, error } = await supabase
      .from('conversations')
      .select('id, bot_outcome, gdo_agenda_at, gdo_appuntamento_set_at, gdo_appuntamento_at, gdo_video_url, gdo_video_sent_at, gdo_recap_for_at, gdo_recap_sent_at, gdo_noemi_reminded_at, ai_paused_at, cancel_requested_at, last_inbound_at, wa_number, leads(phone_e164, first_name)')
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
      : gdoRecapText({ nome, call, videoLink: null, fissatoIl: fissatoIlRecap(occasione, conv, nowMs) });
    const sent = await sendFreeText({ to: phone, body, from: mittenteDiConversazione(conv) });

    // Da qui il messaggio è partito: la presa NON si rilascia più, il recap non deve uscire
    // due volte per la stessa data. Gli errori successivi si loggano soltanto.
    inviato = true;
    tipoInviato = tipo;
    const { error: erroreMsg } = await supabase.from('messages').insert({
      conversation_id: conversationId, direction: 'out', body,
      twilio_sid: sent.sid, twilio_status: sent.status,
      sender: 'bot',
    });
    if (erroreMsg) await logErrore(supabase, conversationId, occasione, `recap inviato ma riga in messages non scritta: ${erroreMsg.message}`);
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
      if (inviato) {
        await logErrore(supabase, conversationId, occasione, `recap inviato, ma un passo successivo è fallito: ${error}`);
        return tipoInviato;
      }
      const erroreRilascio = claimed
        ? await rilasciaRecap(supabase, conversationId, claimed.at, claimed.prima, claimed.noemi)
        : null;
      await logErrore(supabase, conversationId, occasione, erroreRilascio ? `${error}; ${erroreRilascio}` : error);
    } catch (e2) {
      console.error(`[gdo] recap fallito su conv ${conversationId} e anche il log: ${e2 instanceof Error ? e2.message : e2}`);
    }
    return null;
  }
}
