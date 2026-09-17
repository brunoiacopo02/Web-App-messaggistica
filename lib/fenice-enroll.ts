import type { getSupabaseAdmin } from './supabase/admin';
import { findOrCreateLeadConversation, sendTemplateAndLog } from './messaging';
import { feniceOpening } from './fenice-opening';
import { inOpeningWindow } from './sequence';
import { normalizeFunnel, variantIndexFor, openingEnvKey, openingBody, openingWaysFor } from './persona';
import { firstNameOf, templateName } from './name';
import type { GdoVariant, LancioIntake } from './bot-contract';
import { gdoAgendaText, videoLinkForVariant } from './gdo-agenda';
import { getLancioSettings } from './lancio-settings';
import { lancioBenvenutoText } from './lancio-fase';
import { leggiTettoOrario, sottoTettoOrario } from './lancio-tetto';
import { contaBenvenutiUltimaOra } from './lancio-db';
import { mittenteDiConversazione, numeroPrimario, numeroSecondo } from './mittente';

type Supa = ReturnType<typeof getSupabaseAdmin>;

export type EnrollArgs = {
  phone: string; // già E.164
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  crmLeadId?: string | null;
  crmFunnel?: string | null;
  /** Lead del lancio (contratto v1.6): benvenuto del lancio al posto dell'apertura. */
  lancio?: LancioIntake | null;
  /** Lead del riscaldamento: la chat nasce sul numero nuovo, non su quello sorteggiato. */
  riscaldamento?: boolean;
};

export type EnrollResult = {
  ok: boolean; conversationId: number; sid?: string; error?: string; deferred?: boolean; duplicato?: boolean;
  /** L'apertura non e' partita perche' ricoprirebbe una chat gia' viva (`apreSopraChatViva`). */
  aperturaSaltata?: boolean;
};

/**
 * Pure: mandare l'apertura adesso vorrebbe dire ricoprire una conversazione viva?
 *
 * Vero se Mario sta gia' parlando con questa persona E il lead ha gia' visto almeno
 * un nostro messaggio. Il caso e' quotidiano da quando il bot adotta chi scrive per primo:
 * sui 14 lead Telegram lavorati ad agosto l'intake del CRM e' arrivato a chat gia'
 * iniziata, con 0.0 ore di ritardo.
 *
 * `haOutboundPartito` conta solo i messaggi con `twilio_sid`, cioe' partiti davvero. E'
 * il criterio di `app/api/cron/riapri-mute/route.ts`, e cambiarlo lo romperebbe: quel
 * cron esiste per le conversazioni dove abbiamo PROVATO a mandare l'apertura e non e'
 * mai partita, e con "esiste una riga in uscita" diventerebbero irrecuperabili.
 *
 * Su un **adottato** — `crmLeadId` nullo e un nostro messaggio gia' partito — la guardia
 * scatta QUALUNQUE sia `aiStatus`. Il CRM legge la lista di `/api/bot/lead-entranti`
 * giorni dopo, come gli abbiamo chiesto, e quella lista contiene anche chi il bot ha gia'
 * portato a `booked`, `closed` o `handed_off`: con la sola condizione su 'active' partiva
 * "Ciao, sono Marta... le tue 10 ore gratuite" a chi aveva gia' la call in agenda, e
 * l'update dell'arruolamento riportava la conversazione ad 'active' facendole perdere il
 * lucchetto sull'appuntamento.
 *
 * Il caso legittimo "il CRM ri-arruola un lead gia' suo che era stato chiuso" resta
 * intatto: li' `crmLeadId` c'e' gia', e vale la regola di prima.
 *
 * `aiStatus` vale 'active' o 'replying': 'replying' e' il lock del drain, non uno stato
 * a parte — una chat che sta rispondendo e' viva quanto una attiva (vedi
 * `shouldAutoReply` in `lib/fenice-autoreply.ts`), e in produzione restano righe ferme
 * su quel valore dal vecchio meccanismo.
 */
export function apreSopraChatViva(g: {
  aiOwner: string | null;
  aiStatus: string | null;
  /** `crm_lead_id` della conversazione: nullo = il CRM non conosce questo lead. */
  crmLeadId: string | null;
  haOutboundPartito: boolean;
}): boolean {
  if (g.aiOwner !== 'mario' || !g.haOutboundPartito) return false;
  if (g.crmLeadId === null) return true;
  return g.aiStatus === 'active' || g.aiStatus === 'replying';
}

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
): Promise<EnrollResult> {
  // Lead del lancio: un flusso a parte, con il suo template e le sue fasi. Sta prima di
  // tutto il resto perche' nessuna delle regole di Mario (A/B delle aperture, funnel
  // C/T/J, sequenza) deve poter toccare questi lead.
  if (args.lancio) return enrollLancio(supabase, { ...args, lancio: args.lancio });

  const templateSid = process.env.FENICE_OPENING_TEMPLATE_SID;
  const primario = numeroPrimario();
  if (!templateSid || !primario) {
    throw new Error('FENICE_OPENING_TEMPLATE_SID o TWILIO_WHATSAPP_NUMBER_FENICE non configurati');
  }

  const firstName = args.firstName ?? undefined;
  // Un lead di riscaldamento nasce SUL numero che stiamo scaldando; tutti gli
  // altri lasciano decidere alla quota (`undefined` = sorteggio). Cosi' si puo'
  // tenere la quota a zero — ordinari tutti sul numero storico — e mandare al
  // numero nuovo soltanto i lead del test.
  // Se il secondo numero non e' configurato si ricade sul sorteggio: meglio un
  // lead che parte dal numero di sempre che un lead che non parte.
  const secondo = numeroSecondo();
  const mittenteImposto = args.riscaldamento && secondo ? secondo : undefined;
  const { conversationId, waNumber } = await findOrCreateLeadConversation(supabase, {
    phone: args.phone,
    firstName,
    lastName: args.lastName ?? undefined,
    email: args.email ?? undefined,
  }, { mittente: mittenteImposto });
  // Il numero della chat: sorteggiato se e' appena nata, il suo se esisteva gia'. Il
  // `?? primario` e' solo per il tipo — col primario configurato non e' mai undefined.
  const from = mittenteDiConversazione({ wa_number: waNumber }) ?? primario;

  // Non si lascia cadere un'apertura sopra una conversazione gia' avviata: il lead
  // vedrebbe il bot ricominciare da capo. Si prende comunque in carico il lead per il
  // CRM, cosi' da parte loro non risulta fermo.
  {
    // Se una delle due letture non si sa com'è andata, l'apertura PARTE: un lead che
    // resta muto per sempre è peggio di un'apertura di troppo.
    //
    // Sul conteggio dei messaggi basta il valore vuoto (`partiti` a null ⇒ nessun
    // outbound ⇒ la guardia non scatta). Sulla riga della conversazione NO, e da quando
    // `crmLeadId` nullo fa scattare la guardia da solo è diventato pericoloso: una
    // select fallita darebbe `convRow` undefined, quindi `crm_lead_id` letto come nullo,
    // e con un outbound partito la guardia scatterebbe su un lead del CRM che non ha
    // mai parlato col bot — apertura saltata e `ai_owner`/`ai_status`/`ai_started_at`
    // mai scritti: preso in carico sulla carta, muto nei fatti. Per questo l'errore
    // della select si controlla: "non lo so" non è "è nullo", e nel dubbio si apre.
    const { data: convRow, error: erroreConv } = await supabase
      .from('conversations').select('ai_owner, ai_status, crm_lead_id').eq('id', conversationId).single();
    const { count: partiti } = await supabase
      .from('messages').select('id', { count: 'exact', head: true })
      .eq('conversation_id', conversationId).eq('direction', 'out').not('twilio_sid', 'is', null);
    if (!erroreConv && apreSopraChatViva({
      aiOwner: convRow?.ai_owner ?? null,
      aiStatus: convRow?.ai_status ?? null,
      crmLeadId: (convRow as { crm_lead_id?: string | null } | null)?.crm_lead_id ?? null,
      haOutboundPartito: (partiti ?? 0) > 0,
    })) {
      // Solo i campi valorizzati: scrivere null cancellerebbe il `crm_funnel` che il
      // webhook ha appena dedotto dal primo messaggio del lead.
      const patch = {
        ...(args.crmLeadId ? { crm_lead_id: args.crmLeadId } : {}),
        ...(args.crmFunnel ? { crm_funnel: args.crmFunnel } : {}),
      };
      if (Object.keys(patch).length > 0) {
        await supabase.from('conversations').update(patch).eq('id', conversationId);
      }
      await supabase.from('event_log').insert({
        type: 'apertura_saltata_chat_in_corso',
        payload: { phone: args.phone, conversationId, crmLeadId: args.crmLeadId ?? null } as never,
        message: `[bot-fissatore] apertura saltata per ${args.phone}: la chat e' gia' avviata`,
        level: 'info',
      });
      return { ok: true, conversationId, aperturaSaltata: true };
    }
  }

  const convUpdate = {
    ai_owner: 'mario',
    ai_status: 'active',
    ai_started_at: new Date().toISOString(),
    crm_lead_id: args.crmLeadId ?? null,
    // Il funnel si scrive solo se c'e': un intake che non lo manda cancellerebbe il
    // `crm_funnel` (TELEGRAM) che il webhook ha dedotto dal primo messaggio del lead.
    // Stessa regola del ramo guardia qui sopra. `crm_lead_id` invece resta come prima:
    // e' proprio il campo che questo arruolamento porta.
    ...(args.crmFunnel ? { crm_funnel: args.crmFunnel } : {}),
  };

  // Apertura differita: nel cuore della notte i template aprono peggio (-10pt
  // risposta) e disturbano. La conv viene comunque presa in carico da Mario, senza
  // outbound: sarà il cron sequence-touches a inviare l'apertura al primo run in
  // fascia, cioè alle 07:00.
  // La fascia qui è quella LARGA (07:00-23:00, `inOpeningWindow`) e non quella dei
  // touch: è il primo messaggio a chi ha appena lasciato il numero, e una risposta
  // se l'aspetta. Vedi il commento su `inOpeningWindow` per i numeri.
  if (!inOpeningWindow(Date.now())) {
    await supabase.from('conversations').update(convUpdate).eq('id', conversationId);
    await supabase.from('event_log').insert({
      type: 'fenice_enroll_deferred',
      payload: { phone: args.phone, conversationId, crmLeadId: args.crmLeadId ?? null } as never,
      message: `Lead arruolato (Mario), apertura differita in fascia: ${args.phone}`,
      level: 'info',
    });
    return { ok: true, conversationId, deferred: true };
  }

  // Ritento del CRM sullo stesso lead: l'apertura è già partita, non se ne manda una
  // seconda. Serve dal 09/09/2026, quando il CRM ha iniziato a ritentare sui 429 e sui
  // timeout (113 in 30 giorni: il loro AbortSignal scatta a 5s, ma la nostra richiesta
  // era arrivata lo stesso). Senza questa guardia ogni ritento è un secondo "ciao" allo
  // stesso lead — il modo più veloce per farsi bloccare da un numero già a qualità LOW.
  //
  // La guardia guarda la CHAT, non il leadId: un outbound nelle ultime 12 ore basta a
  // fermare l'apertura. Il leadId non serviva e anzi lasciava passare il caso peggiore —
  // il CRM tiene più lead per lo stesso numero (1.708 gruppi con presenze diverse), noi
  // deduplichiamo la chat per numero, quindi in un blast due leadId della stessa persona
  // cadono nella stessa conversazione e quella sentirebbe due "ciao" di fila. Per la
  // stessa ragione non serve la loro `personKey`: è lo stesso numero, quindi è già la
  // stessa chat. La persona che torna dopo giorni ha l'ultimo outbound fuori finestra e
  // riceve la sua apertura come sempre.
  const guardia = args.crmLeadId ? await apertutaDaFermare(supabase, conversationId) : null;
  if (guardia) {
    await supabase.from('event_log').insert({
      type: 'fenice_enroll_duplicato',
      payload: { phone: args.phone, conversationId, crmLeadId: args.crmLeadId, motivo: guardia } as never,
      message: `Intake ripetuto per lead ${args.crmLeadId}: ${guardia}, nessun reinvio`,
      level: 'info',
    });
    return { ok: true, conversationId, duplicato: true };
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
    const ways = openingWaysFor(funnel, (k) => Boolean(process.env[k]));
    const variant = variantIndexFor(conversationId, ways);
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

/**
 * Perché fermare l'apertura, o null per mandarla.
 *
 * Due motivi, misurati sul ripescaggio del 09/09 sera: su 46 conversazioni ripushate dal
 * CRM, 26 hanno ricevuto un secondo messaggio entro 24 ore dal primo (la più ravvicinata
 * a 2 ore e mezza) e 25 erano chat in cui il lead aveva risposto negli ultimi 7 giorni.
 * Il solo controllo sull'outbound recente ne avrebbe fermate circa metà: chi ci sta
 * parlando da giorni non deve sentirsi dire "ciao" da capo, e la distanza dall'ultimo
 * invio non lo dice.
 *
 * Conta solo l'outbound PARTITO, cioè con `twilio_sid`. Una riga in uscita senza SID è
 * un invio fallito prima di Twilio (`sendTemplateAndLog` la scrive nel `catch`, e dal
 * 01/09 le righe senza SID sono tutte e sole `failed`): il lead non ha ricevuto niente.
 * Il 17/09 la guardia contava anche quelle, e `riapri-mute` — che esiste apposta per
 * queste chat — chiamava questa funzione, si sentiva dire "apertura_recente" e
 * dichiarava 53 aperture "partite" a ogni giro senza mandarne una. Stesso criterio di
 * `apreSopraChatViva` e della rotta: l'unica prova che qualcosa sia uscito è il SID.
 */
async function apertutaDaFermare(
  supabase: Supa,
  conversationId: number,
): Promise<'apertura_recente' | 'conversazione_viva' | null> {
  const soglia = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
  const { data: out } = await supabase
    .from('messages')
    .select('id')
    .eq('conversation_id', conversationId)
    .eq('direction', 'out')
    .not('twilio_sid', 'is', null)
    .gte('created_at', soglia)
    .limit(1);
  if ((out?.length ?? 0) > 0) return 'apertura_recente';

  const { data: conv } = await supabase
    .from('conversations')
    .select('last_inbound_at')
    .eq('id', conversationId)
    .maybeSingle();
  const ultimoInbound = (conv as { last_inbound_at: string | null } | null)?.last_inbound_at;
  if (ultimoInbound && Date.now() - new Date(ultimoInbound).getTime() <= 7 * 24 * 60 * 60 * 1000) {
    return 'conversazione_viva';
  }
  return null;
}

export type GdoEnrollArgs = {
  phone: string; // già E.164
  name?: string | null;
  email?: string | null;
  crmLeadId: string;
  crmFunnel?: string | null;
  variant: GdoVariant;
  /** Link video già risolto dal chiamante (offerta del mese da impostazione). `null` =
   *  nessun video. Assente = si calcola dalla variante. */
  gdoVideoUrl?: string | null;
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
  const primario = numeroPrimario();
  if (!templateSid) throw new Error('AGENDA_GDO_TEMPLATE_SID non configurato');
  if (!primario) throw new Error('TWILIO_WHATSAPP_NUMBER_FENICE non configurato');

  const { conversationId, waNumber } = await findOrCreateLeadConversation(supabase, {
    phone: args.phone,
    firstName: args.name ?? undefined,
    email: args.email ?? undefined,
  });
  // Una chat riaperta resta sul suo numero: il video e i solleciti che seguono
  // l'agenda partiranno dallo stesso (vedi drainMarioReplies e gdo-video-followups).
  const from = mittenteDiConversazione({ wa_number: waNumber }) ?? primario;

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
      gdo_video_url: args.gdoVideoUrl !== undefined ? args.gdoVideoUrl : videoLinkForVariant(args.variant),
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

/**
 * Arruolamento di un lead del lancio "Web Developer AI" (spec §5.1).
 *
 * Differenze dal flusso di Mario, tutte volute:
 * - il primo messaggio e' il template di benvenuto del lancio, l'UNICO messaggio
 *   preimpostato che questo blocco manda (il numero e' a qualita' LOW);
 * - la guardia anti-doppione viene PRIMA della finestra: una chat gia' viva non riceve
 *   un secondo benvenuto nemmeno differito, ma entra comunque nel flusso lancio
 *   (`lancio_*` valorizzati) e la cronologia non si azzera;
 * - fuori dalla fascia 07-23, con `lancio_attivo` spento, o oltre il tetto orario dei
 *   benvenuti (`LANCIO_WELCOME_MAX_PER_HOUR`, spec §11.3), il lead e' preso in carico
 *   senza outbound: lo riprende il cron `lancio-aperture`, NON `sequence-touches`.
 *   Le esclusioni ci sono (Task 10): queste chat sono fuori dai cron di Mario
 *   — sequenza, nudge, promemoria, solleciti — finche' la fase non e' terminale,
 *   via `FILTRO_FUORI_LANCIO`.
 */
async function enrollLancio(
  supabase: Supa,
  args: EnrollArgs & { lancio: LancioIntake },
): Promise<EnrollResult> {
  const templateSid = process.env.LANCIO_WELCOME_TEMPLATE_SID;
  const primario = numeroPrimario();
  if (!templateSid || !primario) {
    throw new Error('LANCIO_WELCOME_TEMPLATE_SID o TWILIO_WHATSAPP_NUMBER_FENICE non configurati');
  }

  const firstName = args.firstName ?? undefined;
  // Un lead di riscaldamento nasce SUL numero che stiamo scaldando; tutti gli
  // altri lasciano decidere alla quota (`undefined` = sorteggio). Cosi' si puo'
  // tenere la quota a zero — ordinari tutti sul numero storico — e mandare al
  // numero nuovo soltanto i lead del test.
  // Se il secondo numero non e' configurato si ricade sul sorteggio: meglio un
  // lead che parte dal numero di sempre che un lead che non parte.
  const secondo = numeroSecondo();
  const mittenteImposto = args.riscaldamento && secondo ? secondo : undefined;
  const { conversationId, waNumber } = await findOrCreateLeadConversation(supabase, {
    phone: args.phone,
    firstName,
    lastName: args.lastName ?? undefined,
    email: args.email ?? undefined,
  }, { mittente: mittenteImposto });
  // Come nel ramo di Mario: il numero e' della chat, e se il benvenuto viene differito
  // il cron `lancio-aperture` lo rilegge da `wa_number`.
  const from = mittenteDiConversazione({ wa_number: waNumber }) ?? primario;

  const lancioFields = {
    lancio_slug: args.lancio.slug,
    lancio_fase: 'attesa',
    lancio_ingresso: args.lancio.ingresso,
    // Chat riusata: l'esito del giro precedente resta scritto sulla riga. Va azzerato
    // qui, all'ingresso nel lancio, o la restituzione di fine lancio (NON_RISPOSTO) si
    // troverebbe davanti un APPUNTAMENTO vecchio e `resolveOutcomeAction` la
    // declasserebbe a NOTA — su un lead che con questo lancio non c'entra niente.
    // Su una conversazione appena creata sono gia' null: scriverli non cambia nulla.
    bot_outcome: null,
    bot_outcome_at: null,
    bot_scheduled_at: null,
  };
  const base = { phone: args.phone, conversationId, crmLeadId: args.crmLeadId ?? null, slug: args.lancio.slug, ingresso: args.lancio.ingresso };
  const evento = (extra: Record<string, unknown>, message: string) =>
    supabase.from('event_log').insert({
      type: 'lancio_intake',
      payload: { ...base, ...extra } as never,
      message,
      level: 'info',
    });

  const guardia = args.crmLeadId ? await apertutaDaFermare(supabase, conversationId) : null;
  if (guardia) {
    await supabase.from('conversations')
      // `crm_funnel` solo se c'e': un intake del lancio che non lo manda cancellerebbe
      // il funnel che la chat si porta dietro (il TELEGRAM dedotto dal webhook su un
      // adottato). Stessa regola del ramo normale di `enrollLeadIntoMario`.
      .update({ ...lancioFields, ai_owner: 'mario', crm_lead_id: args.crmLeadId ?? null, ...(args.crmFunnel ? { crm_funnel: args.crmFunnel } : {}) })
      .eq('id', conversationId);
    // Una chat chiusa (o mai governata) torna attiva; una booked/handed_off resta a chi ce l'ha in mano.
    await supabase.from('conversations')
      .update({ ai_status: 'active' })
      .eq('id', conversationId)
      .or('ai_status.is.null,ai_status.eq.closed');
    await evento({ duplicato: true, motivo: guardia }, `[lancio] lead ${args.crmLeadId}: chat gia' viva (${guardia}), nessun benvenuto, entra nel flusso lancio`);
    return { ok: true, conversationId, duplicato: true };
  }

  const convUpdate = {
    ai_owner: 'mario',
    ai_status: 'active',
    ai_started_at: new Date().toISOString(),
    crm_lead_id: args.crmLeadId ?? null,
    // Come sopra: il funnel si scrive solo se l'intake lo manda, mai a null.
    ...(args.crmFunnel ? { crm_funnel: args.crmFunnel } : {}),
    ...lancioFields,
  };

  const settings = await getLancioSettings(supabase);
  let differita: 'lancio_spento' | 'fuori_fascia' | 'tetto_orario' | null = !settings.attivo
    ? 'lancio_spento'
    : !inOpeningWindow(Date.now())
      ? 'fuori_fascia'
      : null;

  // Tetto orario (spec §11.3): il benvenuto parte in tempo reale, quindi una campagna
  // che spinge forte per un'ora rifarebbe il picco del 15/09 — 7.882 intake in un
  // giorno e il numero uscito a qualita' LOW. Oltre il tetto NON si manda: il lead resta
  // preso in carico e il benvenuto lo fa partire il cron `lancio-aperture`, che rispetta
  // lo stesso tetto e spalma la coda. Il conteggio si fa solo se si sarebbe mandato
  // davvero: col lancio spento o di notte sarebbe una query per niente.
  const cap = leggiTettoOrario(process.env.LANCIO_WELCOME_MAX_PER_HOUR);
  let inviatiUltimaOra: number | null = null;
  // Conteggio illeggibile = tetto raggiunto. Si sbaglia dalla parte del differire: il
  // cron ripassa ogni 15 minuti, quindi il prezzo e' un ritardo; lasciar passare alla
  // cieca proprio mentre il DB e' in affanno e' il modo di ritrovarsi col picco.
  if (!differita) {
    inviatiUltimaOra = await contaBenvenutiUltimaOra(supabase, templateSid);
    if (inviatiUltimaOra === null || !sottoTettoOrario({ inviatiUltimaOra, cap })) {
      differita = 'tetto_orario';
    }
  }

  if (differita) {
    await supabase.from('conversations').update(convUpdate).eq('id', conversationId);
    await evento(
      differita !== 'tetto_orario'
        ? { differita }
        : inviatiUltimaOra === null
          ? { differita, motivo: 'conteggio_fallito', cap }
          : { differita, inviatiUltimaOra, cap },
      `[lancio] lead ${args.crmLeadId ?? args.phone} preso in carico, benvenuto differito (${differita})`,
    );
    return { ok: true, conversationId, deferred: true };
  }

  const res = await sendTemplateAndLog(
    supabase, conversationId, args.phone, templateSid, 'Lancio benvenuto', from,
    { '1': templateName(firstName) }, lancioBenvenutoText(firstName),
  );
  // Il benvenuto e' partito: si timbra `lancio_benvenuto_at`, che e' il lucchetto letto
  // dal cron `lancio-aperture` (una riga timbrata non e' nemmeno candidata). Se l'invio
  // e' fallito NON si timbra: il cron deve poterci riprovare.
  await supabase
    .from('conversations')
    .update(res.ok ? { ...convUpdate, lancio_benvenuto_at: new Date().toISOString() } : convUpdate)
    .eq('id', conversationId);

  if (!res.ok) {
    await supabase.from('event_log').insert({
      type: 'send_error',
      payload: { ...base, error: res.error } as never,
      message: `[lancio] benvenuto fallito per ${args.phone}: ${res.error}`,
      level: 'error',
    });
  }
  await evento(
    { sid: res.sid ?? null, ok: res.ok, error: res.error ?? null },
    res.ok ? `[lancio] benvenuto inviato a ${args.phone}` : `[lancio] benvenuto NON partito per ${args.phone}`,
  );
  return { ok: res.ok, conversationId, sid: res.sid, error: res.error };
}
