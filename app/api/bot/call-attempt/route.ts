import { NextRequest, NextResponse } from 'next/server';
import { stopDalCrmPerLead } from '@/lib/stop-crm';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { verifySignature } from '@/lib/bot-hmac';
import { parseCallAttempt, tentativoGestito } from '@/lib/call-attempt';
import { puoScrivere, appuntamentoDaConfermare, type StatoConversazione } from '@/lib/recupero-nr';
import {
  dentroFinestra, quandoLeggibile, notaRecuperoNr,
  controllaAppointmentAt, TURNO_RIPRESA_RECUPERO_NR,
} from '@/lib/recupero-nr-invio';
import { generateMarioReply } from '@/lib/mario';
import { buildSollecitoHistory } from '@/lib/gdo-video-followup';
import { splitMarioMessages } from '@/lib/mario-split';
import { unknownFeniceLinks } from '@/lib/outbound-sanitize';
import { sendFreeText } from '@/lib/twilio';
import { sendTemplateAndLog } from '@/lib/messaging';
import { templateName } from '@/lib/name';
import { PERSONA_NAME, personaForConversation } from '@/lib/persona';
import { martaSidsFromEnv, shouldReopen } from '@/lib/fenice-autoreply';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Il ramo dentro-finestra chiama il modello in sincrono, coi retry dentro il client:
// col default di Vercel la funzione può essere uccisa a metà generazione, e il CRM si
// prende un 504 che non ritenta — il lead sparirebbe senza lasciare traccia, cioè
// esattamente il danno per cui qui si risponde sempre 200. Stesso valore dell'altro
// webhook del CRM (`/api/bot/contatti-umani`).
export const maxDuration = 60;

// Il budget della chiamata al modello, esplicito perché quello di casa non ci sta.
// `lib/mario.ts` costruisce il client con `timeout: 60_000, maxRetries: 5`: un solo
// tentativo può consumare da solo tutti i 60 secondi della funzione, e sui 429/529 i
// retry ci arrivano davvero. Una funzione uccisa fra l'invio e la scrittura del
// lucchetto lascerebbe il lead col messaggio e noi senza traccia — al giro dopo il CRM
// gliene farebbe arrivare un secondo. Due tentativi da 20s stanno comodi dentro i 60 e
// lasciano il tempo per gli invii Twilio e per le scritture.
const BUDGET_MODELLO_MS = 20_000;
/** Tentativi OLTRE il primo: 1 ⇒ due chiamate in tutto. */
const RETRY_MODELLO = 1;

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

  const stato = await costruisciStato(supabase, conv, evento.tentativo, evento.leadId);

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

  // La data che finisce NEL MESSAGGIO al lead arriva dal CRM e fin qui non la
  // controllava nessuno: le sette guardie validano le nostre colonne. Un
  // `appointmentAt` sbagliato manda al lead la data sbagliata della sua call — il danno
  // che questo progetto ha già visto con le date dei GDO.
  const controllo = controllaAppointmentAt(
    evento.appointmentAt, appuntamentoDaConfermare(stato), Date.now(),
  );
  if (!controllo.ok) {
    await supabase.from('event_log').insert({
      type: 'recupero_nr_saltato',
      payload: { conversationId: conv.id, crmLeadId: evento.leadId, tentativo: evento.tentativo, motivo: controllo.motivo, appointmentAt: evento.appointmentAt } as never,
      message: `[crm] recupero non-risposta saltato per il lead ${evento.leadId} (tentativo ${evento.tentativo}): ${controllo.motivo}`,
      level: 'warn',
    });
    return NextResponse.json({ ok: true, inviato: false, motivo: controllo.motivo });
  }
  // Non ferma l'invio — sull'agenda delle Conferme la fonte di verità è la loro — ma
  // resta scritto: uno dei due sistemi ha la riga sbagliata e va guardato.
  if (controllo.incoerente) {
    await supabase.from('event_log').insert({
      type: 'recupero_nr_data_incoerente',
      payload: {
        conversationId: conv.id, crmLeadId: evento.leadId, tentativo: evento.tentativo,
        appointmentAt: evento.appointmentAt,
        bot_scheduled_at: stato.bot_scheduled_at, gdo_appuntamento_at: stato.gdo_appuntamento_at,
        scartoMs: controllo.scartoMs,
      } as never,
      message: `[crm] recupero non-risposta per il lead ${evento.leadId}: la data del CRM (${evento.appointmentAt}) non coincide con la nostra`,
      level: 'warn',
    });
  }

  const esito = await inviaRecuperoNr(supabase, {
    conversationId: conv.id,
    crmLeadId: evento.leadId,
    tentativo: evento.tentativo,
    phone: conv.leads?.phone_e164 ?? null,
    nome: conv.leads?.first_name ?? null,
    aiStartedAt: conv.ai_started_at,
    aiOwner: conv.ai_owner,
    aiStatus: conv.ai_status,
    aiPausedAt: conv.ai_paused_at,
    appointmentAt: evento.appointmentAt,
    ultimoInboundAt: stato.ultimoInboundAt,
  });
  return esito.inviato
    ? NextResponse.json({ ok: true, inviato: true, ramo: esito.ramo })
    : NextResponse.json({ ok: true, inviato: false, motivo: esito.motivo });
}

type ConversazioneTrovata = Pick<
  StatoConversazione,
  'ai_owner' | 'ai_status' | 'ai_paused_at' | 'bot_outcome' | 'bot_scheduled_at'
  | 'gdo_appuntamento_at' | 'cancel_requested_at'
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
    // `gdo_appuntamento_at` serve alla guardia (i lead postino hanno l'appuntamento
    // lì e non su `bot_scheduled_at`) ed è in SOLA LETTURA, come le altre colonne
    // dell'appuntamento: qui non si scrive mai.
    .select('id, ai_owner, ai_status, ai_paused_at, bot_outcome, bot_scheduled_at, gdo_appuntamento_at, cancel_requested_at, ai_started_at, leads(phone_e164, first_name)')
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
async function costruisciStato(
  supabase: Supa,
  conv: ConversazioneTrovata,
  tentativo: number,
  crmLeadId: string,
): Promise<StatoConversazione> {
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

  // Il lead lo conosciamo dalla chiamata del CRM: la conversazione l'abbiamo trovata
  // proprio cercando quel `crm_lead_id`.
  const stopCrm = await stopDalCrmPerLead(supabase, crmLeadId);

  return {
    ai_owner: conv.ai_owner,
    ai_status: conv.ai_status,
    ai_paused_at: conv.ai_paused_at,
    bot_outcome: conv.bot_outcome,
    bot_scheduled_at: conv.bot_scheduled_at,
    gdo_appuntamento_at: conv.gdo_appuntamento_at,
    cancel_requested_at: conv.cancel_requested_at,
    ultimoInboundAt,
    giaInviatoTentativo,
    stopCrm,
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
  /** Servono a `shouldReopen`: si riapre solo quello che era davvero chiuso. */
  aiOwner: string | null;
  aiStatus: string | null;
  aiPausedAt: string | null;
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
  // Il ternario regge perché `tentativoGestito` a monte lascia passare solo 1 e 3: se
  // un giorno si gestisse un quarto tentativo, questa riga gli darebbe NR3 in silenzio.
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

  // Il lucchetto si prende PRIMA di scrivere al lead, non dopo. Leggerlo prima e
  // scriverlo dopo non è un lucchetto: in mezzo ci sono la chiamata al modello e gli
  // invii Twilio, cioè secondi, e due POST ravvicinati (il doppio clic che la specifica
  // promette innocuo) leggerebbero entrambi "non inviato" e manderebbero entrambi.
  // Il claim è la insert stessa: la migration 20260828000001 mette un indice unique
  // parziale su (type, payload->>conversationId, payload->>tentativo) per questo solo
  // tipo, quindi chi arriva secondo si prende un 23505 ed esce senza scrivere niente.
  const payloadLucchetto = {
    conversationId: ctx.conversationId, crmLeadId: ctx.crmLeadId, tentativo: ctx.tentativo, ramo,
  };
  const { error: erroreClaim } = await supabase.from('event_log').insert({
    type: 'recupero_nr_inviato',
    payload: payloadLucchetto as never,
    message: `[crm] recupero non-risposta inviato al lead ${ctx.crmLeadId} (tentativo ${ctx.tentativo}, ${ramo})`,
    level: 'info',
  });
  if (erroreClaim) {
    // 23505 = unique_violation: il lucchetto ce l'ha già qualcun altro, e il lead il
    // suo messaggio ce l'ha (o sta per averlo). Qualsiasi altro errore è un guasto del
    // database e non va confuso con un duplicato: si dice che l'invio è fallito, così
    // il caso resta ritentabile e visibile.
    if ((erroreClaim as { code?: string }).code === '23505') {
      return { inviato: false, motivo: 'gia_inviato' };
    }
    await logInvioFallito(supabase, ctx, `lucchetto non scrivibile: ${erroreClaim.message ?? 'errore sconosciuto'}`);
    return { inviato: false, motivo: 'invio_fallito' };
  }

  let sid: string;
  try {
    const res = ramo === 'libero'
      ? await scriviMessaggioLibero(supabase, ctx, from, quando)
      : await scriviTemplate(supabase, ctx, from, quando, templateSid as string);
    if ('errore' in res) {
      await rilasciaLucchetto(supabase, ctx);
      await logInvioFallito(supabase, ctx, res.errore);
      return { inviato: false, motivo: 'invio_fallito' };
    }
    sid = res.sid;
  } catch (err) {
    await rilasciaLucchetto(supabase, ctx);
    await logInvioFallito(supabase, ctx, err instanceof Error ? err.message : 'errore sconosciuto');
    return { inviato: false, motivo: 'invio_fallito' };
  }

  // Il SID si conosce solo adesso e completa la riga del lucchetto: è la sola cosa che
  // lega l'evento al messaggio davvero uscito da Twilio. Se questa update non passa
  // resta un lucchetto senza SID, che è comunque un lucchetto valido.
  await supabase
    .from('event_log')
    .update({ payload: { ...payloadLucchetto, sid } as never })
    .eq('type', 'recupero_nr_inviato')
    .eq('payload->>conversationId', String(ctx.conversationId))
    .eq('payload->>tentativo', String(ctx.tentativo));

  // Riapertura: la conversazione di un lead appuntato è chiusa, e su una chat chiusa
  // la sua risposta non verrebbe lavorata da nessuno — gli avremmo chiesto quando
  // richiamarlo per poi non leggere la risposta.
  //
  // Si riapre SOLO quello che era chiuso, ed è `shouldReopen` a dirlo: scrivere
  // `active` incondizionatamente cancellerebbe uno stato che vale più di questo invio
  // ('booked', 'handed_off'), ed è proprio per non perderli che quella funzione riapre
  // solo da 'closed'.
  //
  // Si tocca SOLO `ai_status`. Né `bot_outcome`, né `bot_outcome_at`, né
  // `bot_scheduled_at`: l'appuntamento è già preso e resta preso. Declassarlo qui lo
  // rimetterebbe fra quelli da fissare e lo farebbe ricomparire come "preso oggi" al
  // prossimo esito — è il bug che l'invariante "una volta fissato resta Preso" è nata
  // per chiudere.
  const riapri = shouldReopen({ aiOwner: ctx.aiOwner, aiStatus: ctx.aiStatus, aiPausedAt: ctx.aiPausedAt });
  await supabase
    .from('conversations')
    .update({ ...(riapri ? { ai_status: 'active' } : {}), last_message_at: new Date().toISOString() })
    .eq('id', ctx.conversationId);

  return { inviato: true, ramo };
}

/**
 * Toglie il lucchetto quando il messaggio non è partito.
 *
 * Tenerlo significherebbe che una singola sbandata di Twilio (o del modello) chiude per
 * sempre quel tentativo: al giro dopo il CRM si sentirebbe rispondere `gia_inviato` per
 * un messaggio che il lead non ha mai visto. Il rischio simmetrico — l'altra richiesta
 * del doppio clic che nel frattempo si è già presa un `gia_inviato` e quindi tace anche
 * lei — costa un recupero mancato, non un doppio messaggio: fra i due si sceglie
 * questo.
 */
async function rilasciaLucchetto(supabase: Supa, ctx: ContestoInvio): Promise<void> {
  await supabase
    .from('event_log')
    .delete()
    .eq('type', 'recupero_nr_inviato')
    .eq('payload->>conversationId', String(ctx.conversationId))
    .eq('payload->>tentativo', String(ctx.tentativo));
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

  // La cronologia grezza qui finisce quasi sempre su un turno `assistant`: la guardia
  // `gia_risposto` esclude i lead che hanno scritto dopo la chiamata a vuoto, e al loro
  // ultimo messaggio il drain ha già risposto. Sonnet 4.6 rifiuta quella forma con un
  // 400 che l'SDK non ritenta. `buildSollecitoHistory` è la cura già scritta in casa
  // per lo stesso problema sui solleciti GDO: chiude la cronologia con un turno `user`
  // sintetico, qui con le parole del recupero (vedi TURNO_RIPRESA_RECUPERO_NR).
  const history = buildSollecitoHistory(
    rows.map((m) => ({ direction: m.direction, body: m.body ?? '' })),
    TURNO_RIPRESA_RECUPERO_NR,
  );

  const result = await generateMarioReply(history, {
    personaName: PERSONA_NAME[persona],
    contextNote: notaRecuperoNr(quando, ctx.tentativo),
    timeoutMs: BUDGET_MODELLO_MS,
    maxRetries: RETRY_MODELLO,
  });

  // Niente pausa fra le bolle come nel drain: qui dall'altra parte c'è il CRM che
  // aspetta la risposta HTTP, e il recupero è un messaggio corto.
  const parts = splitMarioMessages(result.visibleReply ?? '');
  if (parts.length === 0) return { errore: 'il modello non ha prodotto nessun messaggio da inviare' };

  // Stesso presidio del drain su ogni uscita del modello: un link Fenice inventato è
  // un lead mandato su una pagina che non esiste, e senza questa riga partirebbe da qui
  // senza lasciare traccia da nessuna parte.
  const linkInventati = parts.flatMap((b) => unknownFeniceLinks(b));
  if (linkInventati.length > 0) {
    await supabase.from('event_log').insert({
      type: 'unknown_fenice_link',
      payload: { conversationId: ctx.conversationId, links: linkInventati } as never,
      message: `[crm] conv ${ctx.conversationId}: link Fenice non ufficiale nel recupero non-risposta: ${linkInventati.join(', ')}`,
      level: 'warn',
    });
  }

  let primo: string | undefined;
  try {
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
  } catch (err) {
    // Se non è uscito niente il fallimento è pulito e si ritenta: rilancia.
    if (!primo) throw err;
    // Se invece una bolla è già arrivata, il lead È stato contattato: trattarlo come
    // fallimento lascerebbe il recupero senza lucchetto e al prossimo giro del CRM
    // gliene arriverebbe un secondo, sopra il primo. Meglio un messaggio troncato che
    // due messaggi. Il pezzo mancante si registra a parte, per poterlo ritrovare.
    await supabase.from('event_log').insert({
      type: 'recupero_nr_invio_parziale',
      payload: {
        conversationId: ctx.conversationId, crmLeadId: ctx.crmLeadId, tentativo: ctx.tentativo,
        bolle: parts.length, error: err instanceof Error ? err.message : 'errore sconosciuto',
      } as never,
      message: `[crm] recupero non-risposta al lead ${ctx.crmLeadId}: prima bolla inviata, il resto del messaggio no`,
      level: 'warn',
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
