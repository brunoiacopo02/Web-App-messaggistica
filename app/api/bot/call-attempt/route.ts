import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { verifySignature } from '@/lib/bot-hmac';
import { parseCallAttempt, tentativoGestito } from '@/lib/call-attempt';
import { puoScrivere, type StatoConversazione } from '@/lib/recupero-nr';
import { dentroFinestra, quandoLeggibile, notaRecuperoNr } from '@/lib/recupero-nr-invio';
import { generateMarioReply, type MarioTurn } from '@/lib/mario';
import { splitMarioMessages } from '@/lib/mario-split';
import { sendFreeText } from '@/lib/twilio';
import { sendTemplateAndLog } from '@/lib/messaging';
import { templateName } from '@/lib/name';
import { PERSONA_NAME, personaForConversation } from '@/lib/persona';
import { martaSidsFromEnv } from '@/lib/fenice-autoreply';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Supa = ReturnType<typeof getSupabaseAdmin>;

/**
 * Il CRM chiama qui quando una Conferma prova a telefonare a un lead e non lo trova.
 * Questo endpoint decide se scrivere su WhatsApp e poi scrive: messaggio libero di
 * Marta finché la finestra di servizio è aperta, template approvato quando è chiusa.
 *
 * Stessa firma HMAC di `/api/bot/intake`. Come loro, si risponde sempre 200 tranne che
 * su firma/config/parse: il CRM non ritenta, e un 500 nostro perderebbe il lead senza
 * lasciare traccia da nessuna parte.
 */
// Niente rate limit qui, a differenza degli altri endpoint /api/bot/*: un 429 sarebbe
// un quinto codice di risposta oltre ai tre ammessi (firma/config/parse), e su un
// evento di mancata risposta che il CRM non ritenta si perderebbe senza lasciare
// traccia — lo stesso danno che il vincolo "sempre 200" esiste per evitare. La difesa
// contro il traffico non autenticato è già la firma HMAC, verificata prima di tutto.
export async function POST(req: NextRequest) {
  const secret = process.env.BOT_WEBHOOK_SECRET;
  if (!secret) return NextResponse.json({ ok: false, error: 'not_configured' }, { status: 503 });

  const rawBody = await req.text();
  const check = verifySignature(rawBody, req.headers.get('x-bot-signature'), secret);
  if (!check.valid) return NextResponse.json({ ok: false, error: 'invalid_signature' }, { status: 401 });

  let json: unknown;
  try { json = JSON.parse(rawBody); } catch { return NextResponse.json({ ok: false, error: 'invalid_json' }, { status: 400 }); }

  const parsed = parseCallAttempt(json);
  if (!parsed.ok) return NextResponse.json({ ok: false, error: parsed.reason }, { status: 400 });
  const evento = parsed.value;

  const supabase = getSupabaseAdmin();

  const conv = await trovaConversazione(supabase, evento.leadId);
  if (!conv) return NextResponse.json({ ok: true, inviato: false, motivo: 'lead_sconosciuto' });

  const stato = await costruisciStato(supabase, conv, evento.tentativo);

  // Il tentativo 2 (e ogni altro non gestito) è un evento valido che non produce un
  // messaggio: si registra la ricezione nella risposta, senza toccare event_log — non
  // è una decisione presa sulla conversazione, è semplicemente fuori dal perimetro.
  if (!tentativoGestito(evento.tentativo)) {
    return NextResponse.json({ ok: true, inviato: false, motivo: 'tentativo_non_gestito' });
  }

  const verdetto = puoScrivere(stato, evento, Date.now());
  if (!verdetto.ok) {
    await supabase.from('event_log').insert({
      type: 'recupero_nr_saltato',
      payload: { conversationId: conv.id, crmLeadId: evento.leadId, tentativo: evento.tentativo, motivo: verdetto.motivo } as never,
      message: `[crm] recupero non-risposta saltato per il lead ${evento.leadId} (tentativo ${evento.tentativo}): ${verdetto.motivo}`,
      level: 'info',
    });
    return NextResponse.json({ ok: true, inviato: false, motivo: verdetto.motivo });
  }

  const esito = await inviaRecuperoNr(supabase, {
    conversationId: conv.id,
    crmLeadId: evento.leadId,
    tentativo: evento.tentativo,
    phone: conv.leads?.phone_e164 ?? null,
    nome: conv.leads?.first_name ?? null,
    aiStartedAt: conv.ai_started_at,
    appointmentAt: evento.appointmentAt,
    ultimoInboundAt: stato.ultimoInboundAt,
  });
  return esito.inviato
    ? NextResponse.json({ ok: true, inviato: true, ramo: esito.ramo })
    : NextResponse.json({ ok: true, inviato: false, motivo: esito.motivo });
}

type ConversazioneTrovata = Pick<
  StatoConversazione,
  'ai_owner' | 'ai_status' | 'bot_outcome' | 'bot_scheduled_at' | 'cancel_requested_at'
> & {
  id: number;
  /** Da dove parte la cronologia che il modello deve leggere: prima c'è un'altra storia. */
  ai_started_at: string | null;
  leads: { phone_e164: string | null; first_name: string | null } | null;
};

/** L'ultima conversazione per questo lead CRM, o null se non l'abbiamo mai avuta. */
async function trovaConversazione(supabase: Supa, leadId: string): Promise<ConversazioneTrovata | null> {
  const { data } = await supabase
    .from('conversations')
    // Il destinatario è `leads.phone_e164`, non `conversations.wa_number`: quello è il
    // NOSTRO numero, non il suo.
    .select('id, ai_owner, ai_status, bot_outcome, bot_scheduled_at, cancel_requested_at, ai_started_at, leads(phone_e164, first_name)')
    .eq('crm_lead_id', leadId)
    .order('id', { ascending: false })
    .limit(1);
  return ((data ?? []) as unknown as ConversazioneTrovata[])[0] ?? null;
}

/**
 * Completa `StatoConversazione` con le due cose che `puoScrivere` non può vedere da
 * `conversations`: l'ultimo messaggio in arrivo dal lead, e se un recupero per QUESTO
 * tentativo è già partito (dedup: il CRM può richiamarci sullo stesso tentativo).
 */
async function costruisciStato(supabase: Supa, conv: ConversazioneTrovata, tentativo: number): Promise<StatoConversazione> {
  const { data: inbound } = await supabase
    .from('messages')
    .select('created_at')
    .eq('conversation_id', conv.id)
    .eq('direction', 'in')
    .order('created_at', { ascending: false })
    .limit(1);
  const ultimoInboundAt = ((inbound ?? []) as unknown as { created_at: string }[])[0]?.created_at ?? null;

  const { data: giaInviato } = await supabase
    .from('event_log')
    .select('id')
    .eq('type', 'recupero_nr_inviato')
    .eq('payload->>conversationId', String(conv.id))
    .eq('payload->>tentativo', String(tentativo))
    .limit(1);
  const giaInviatoTentativo = ((giaInviato ?? []) as unknown as { id: number }[]).length > 0;

  return {
    ai_owner: conv.ai_owner,
    ai_status: conv.ai_status,
    bot_outcome: conv.bot_outcome,
    bot_scheduled_at: conv.bot_scheduled_at,
    cancel_requested_at: conv.cancel_requested_at,
    ultimoInboundAt,
    giaInviatoTentativo,
  };
}

/** Da dove è uscito il messaggio: cambia il costo, la resa e cosa si può misurare. */
type Ramo = 'libero' | 'template';

type ContestoInvio = {
  conversationId: number;
  crmLeadId: string;
  tentativo: number;
  phone: string | null;
  nome: string | null;
  aiStartedAt: string | null;
  appointmentAt: string;
  ultimoInboundAt: string | null;
};

type EsitoInvio = { inviato: true; ramo: Ramo } | { inviato: false; motivo: string };

/**
 * L'invio vero, che parte solo dopo il sì di `puoScrivere`.
 *
 * Non si controlla la fascia 08:30–20:30: questa non è un'apertura a freddo, è la
 * risposta a una telefonata che le Conferme hanno fatto adesso. Se hanno chiamato alle
 * 21:00, alle 21:00 il lead si aspetta di sentirci — differire vorrebbe dire fargli
 * trovare domani mattina la risposta a una chiamata di ieri sera.
 */
async function inviaRecuperoNr(supabase: Supa, ctx: ContestoInvio): Promise<EsitoInvio> {
  const from = process.env.TWILIO_WHATSAPP_NUMBER_FENICE;
  if (!from || !ctx.phone) {
    // Mandare dal numero sbagliato spezzerebbe la conversazione in due thread agli
    // occhi del lead; senza destinatario non c'è proprio invio. In entrambi i casi si
    // esce senza lucchetto: quando la configurazione torna a posto, si ritenta.
    await logInvioFallito(supabase, ctx, from ? 'lead senza numero di telefono' : 'TWILIO_WHATSAPP_NUMBER_FENICE non configurato');
    return { inviato: false, motivo: 'invio_fallito' };
  }

  const quando = quandoLeggibile(ctx.appointmentAt);
  const ramo: Ramo = dentroFinestra(ctx.ultimoInboundAt, Date.now()) ? 'libero' : 'template';

  // Fuori dalla finestra serve un template approvato. Finché Meta non li approva i SID
  // non sono in env, ed è una condizione normale, non un guasto: si dice che il
  // messaggio non è partito e non si scrive il lucchetto, così questi lead ripartono
  // da soli il giorno dell'approvazione.
  const templateSid = ctx.tentativo === 1 ? process.env.NR1_TEMPLATE_SID : process.env.NR3_TEMPLATE_SID;
  if (ramo === 'template' && !templateSid) {
    await supabase.from('event_log').insert({
      type: 'recupero_nr_template_mancante',
      payload: { conversationId: ctx.conversationId, crmLeadId: ctx.crmLeadId, tentativo: ctx.tentativo } as never,
      message: `[crm] recupero non-risposta per il lead ${ctx.crmLeadId}: SID del template tentativo ${ctx.tentativo} non configurato, messaggio non inviato`,
      level: 'warn',
    });
    return { inviato: false, motivo: 'template_non_configurato' };
  }

  let sid: string;
  try {
    const res = ramo === 'libero'
      ? await scriviMessaggioLibero(supabase, ctx, from, quando)
      : await scriviTemplate(supabase, ctx, from, quando, templateSid as string);
    if ('errore' in res) {
      await logInvioFallito(supabase, ctx, res.errore);
      return { inviato: false, motivo: 'invio_fallito' };
    }
    sid = res.sid;
  } catch (err) {
    await logInvioFallito(supabase, ctx, err instanceof Error ? err.message : 'errore sconosciuto');
    return { inviato: false, motivo: 'invio_fallito' };
  }

  // Il lucchetto prima della riapertura, non dopo: se il processo muore fra le due
  // scritture, una conversazione rimasta chiusa è un guaio che una persona vede e
  // recupera dal pannello, mentre un secondo messaggio identico al lead è già partito
  // e non lo si può più riprendere.
  await supabase.from('event_log').insert({
    type: 'recupero_nr_inviato',
    payload: { conversationId: ctx.conversationId, crmLeadId: ctx.crmLeadId, tentativo: ctx.tentativo, ramo, sid } as never,
    message: `[crm] recupero non-risposta inviato al lead ${ctx.crmLeadId} (tentativo ${ctx.tentativo}, ${ramo})`,
    level: 'info',
  });

  // Riapertura: la conversazione di un lead appuntato è chiusa, e su una chat chiusa
  // la sua risposta non verrebbe lavorata da nessuno — gli avremmo chiesto quando
  // richiamarlo per poi non leggere la risposta.
  //
  // Si tocca SOLO `ai_status`. Né `bot_outcome`, né `bot_outcome_at`, né
  // `bot_scheduled_at`: l'appuntamento è già preso e resta preso. Declassarlo qui lo
  // rimetterebbe fra quelli da fissare e lo farebbe ricomparire come "preso oggi" al
  // prossimo esito — è il bug che l'invariante "una volta fissato resta Preso" è nata
  // per chiudere.
  await supabase
    .from('conversations')
    .update({ ai_status: 'active', last_message_at: new Date().toISOString() })
    .eq('id', ctx.conversationId);

  return { inviato: true, ramo };
}

/** Un fallimento d'invio si registra come ovunque nel resto del codice. */
async function logInvioFallito(supabase: Supa, ctx: ContestoInvio, errore: string): Promise<void> {
  await supabase.from('event_log').insert({
    type: 'send_error',
    payload: { conversationId: ctx.conversationId, crmLeadId: ctx.crmLeadId, tentativo: ctx.tentativo, error: errore } as never,
    message: `[crm] recupero non-risposta fallito per il lead ${ctx.crmLeadId} (tentativo ${ctx.tentativo}): ${errore}`,
    level: 'error',
  });
}

/**
 * Ramo dentro la finestra: parla il modello, dentro la conversazione che il lead ha
 * già avuto. Un testo fisso qui arriverebbe addosso a chi magari aveva lasciato in
 * sospeso un'altra domanda; la nota di contesto invece si integra nel discorso.
 */
async function scriviMessaggioLibero(
  supabase: Supa,
  ctx: ContestoInvio,
  from: string,
  quando: string,
): Promise<{ sid: string } | { errore: string }> {
  let q = supabase
    .from('messages')
    .select('direction, body, template_sid, created_at')
    .eq('conversation_id', ctx.conversationId)
    .order('created_at', { ascending: true })
    .limit(200);
  // Prima dell'arruolamento c'è un'altra storia (campagne, vecchi giri): il modello
  // che la leggesse ricomincerebbe da lì.
  if (ctx.aiStartedAt) q = q.gte('created_at', ctx.aiStartedAt);
  const { data } = await q;
  const rows = (data ?? []) as unknown as { direction: string; body: string | null; template_sid: string | null }[];

  // Stessa regola del drain: la persona la decide il primo template uscito su questa
  // chat, così il lead non si vede rispondere all'improvviso da un altro nome.
  const martaSids = martaSidsFromEnv();
  const persona = martaSids.size > 0 ? personaForConversation(rows, martaSids) : 'mario';

  const history: MarioTurn[] = rows.map((m) => ({
    role: m.direction === 'in' ? 'user' : 'assistant',
    content: m.body ?? '',
  }));

  const result = await generateMarioReply(history, {
    personaName: PERSONA_NAME[persona],
    contextNote: notaRecuperoNr(quando, ctx.tentativo),
  });

  // Niente pausa fra le bolle come nel drain: qui dall'altra parte c'è il CRM che
  // aspetta la risposta HTTP, e il recupero è un messaggio corto.
  const parts = splitMarioMessages(result.visibleReply ?? '');
  if (parts.length === 0) return { errore: 'il modello non ha prodotto nessun messaggio da inviare' };

  let primo: string | undefined;
  for (const body of parts) {
    const sent = await sendFreeText({ to: ctx.phone as string, body, from });
    primo ??= sent.sid;
    await supabase.from('messages').insert({
      conversation_id: ctx.conversationId,
      direction: 'out',
      body,
      twilio_sid: sent.sid,
      twilio_status: sent.status,
      sender: 'bot',
    });
  }
  return { sid: primo as string };
}

/** Ramo fuori finestra: l'unico messaggio che Meta lascia passare è il template. */
async function scriviTemplate(
  supabase: Supa,
  ctx: ContestoInvio,
  from: string,
  quando: string,
  templateSid: string,
): Promise<{ sid: string } | { errore: string }> {
  const res = await sendTemplateAndLog(
    supabase,
    ctx.conversationId,
    ctx.phone as string,
    templateSid,
    `Recupero non-risposta ${ctx.tentativo}`,
    from,
    // Il CRM tiene nome e cognome in un campo solo: "Ciao Mario Rossi" è la firma del
    // mail-merge, e sui nostri lead alimenta il sospetto della truffa.
    { '1': templateName(ctx.nome), '2': quando },
  );
  return res.ok && res.sid ? { sid: res.sid } : { errore: res.error ?? 'invio template fallito' };
}
