import { NextRequest, NextResponse, after } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { validateTwilioSignature } from '@/lib/twilio';
import { toE164 } from '@/lib/phone';
import { checkRateLimit } from '@/lib/rate-limit';
import { getAutoReply } from '@/lib/fenice-settings';
import { shouldAutoReply, shouldReopen, shouldAdoptInbound, drainMarioReplies } from '@/lib/fenice-autoreply';
import { isAudioInbound, transcribeTwilioAudio } from '@/lib/transcribe';
import { handleGdoDeliveryUpdate } from '@/lib/send-agenda-gdo';
import { sendCrmNota } from '@/lib/bot-outcome';
import { buildBotRipresoNote } from '@/lib/bot-outcome-rules';
import { segnalaRispostaDopoTerzoNr } from '@/lib/risposta-post-nr';
import { classificaPrimoMessaggio, isMarkerPulsanteWebinar } from '@/lib/primo-messaggio';
import { LANCIO_SLUG, pulsanteRiportaInPostPitch, pulsanteRiapreChat, pulsanteScriveFase, serveNotaRestituzione } from '@/lib/lancio-fase';
import { impostaFaseLancio, marcaNotaRestituzione } from '@/lib/lancio-db';
import { notaInboundDopoRestituzione } from '@/lib/lancio-restituzioni';
import { getLancioSettings } from '@/lib/lancio-settings';
import { pushLeadEntrante } from '@/lib/lead-entrante';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TWIML_OK = '<Response/>';
const TWIML_HEADERS = { 'content-type': 'text/xml' };

function publicUrl(req: NextRequest): string {
  const base = process.env.NEXT_PUBLIC_APP_URL;
  if (base) return `${base}${req.nextUrl.pathname}`;
  // fallback per dev
  const host = req.headers.get('host');
  const proto = req.headers.get('x-forwarded-proto') ?? 'https';
  return `${proto}://${host}${req.nextUrl.pathname}`;
}

export async function POST(req: NextRequest) {
  // Rate limit
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  const rl = checkRateLimit(`tw:${ip}`, 120, 60_000);
  if (!rl.ok) return new NextResponse('rate limit', { status: 429 });

  // Twilio webhook è form-encoded
  const text = await req.text();
  const params: Record<string, string> = {};
  new URLSearchParams(text).forEach((v, k) => { params[k] = v; });

  // Validazione firma
  const signature = req.headers.get('x-twilio-signature') ?? '';
  const ok = await validateTwilioSignature({
    url: publicUrl(req),
    signature,
    params,
  });
  if (!ok) return new NextResponse('forbidden', { status: 403 });

  const supabase = getSupabaseAdmin();

  // Status callback?
  if (params.MessageStatus && params.MessageSid) {
    await supabase
      .from('messages')
      .update({
        twilio_status: params.MessageStatus,
        twilio_error_code: params.ErrorCode ? parseInt(params.ErrorCode, 10) : null,
      })
      .eq('twilio_sid', params.MessageSid);

    await supabase.from('event_log').insert({
      type: 'twilio_status',
      payload: params,
      message: `Status ${params.MessageStatus} per ${params.MessageSid}`,
      level: params.MessageStatus === 'failed' || params.MessageStatus === 'undelivered' ? 'warn' : 'info',
    });

    // Agenda GDO finita in "inviato" e poi consegnata davvero: il CRM va avvisato,
    // altrimenti quel lead resta per sempre in uno stato ambiguo col reinvio bloccato.
    // Dopo la risposta a Twilio: la callback non deve aspettare il loro endpoint.
    after(handleGdoDeliveryUpdate(supabase, { sid: params.MessageSid, status: params.MessageStatus }));
    return new NextResponse(TWIML_OK, { status: 200, headers: TWIML_HEADERS });
  }

  // Inbound message (testo o nota vocale)
  if (params.MessageSid && params.From && (params.Body !== undefined || isAudioInbound(params))) {
    const phone = toE164(params.From);
    if (!phone) {
      await supabase.from('event_log').insert({
        type: 'twilio_inbound', payload: params,
        message: `From non parsabile: ${params.From}`, level: 'warn',
      });
      return new NextResponse(TWIML_OK, { status: 200, headers: TWIML_HEADERS });
    }

    // Lead
    let leadId: number;
    const { data: leadExisting } = await supabase
      .from('leads').select('id').eq('phone_e164', phone).maybeSingle();
    if (leadExisting) {
      leadId = leadExisting.id;
    } else {
      const { data: leadNew, error: leadErr } = await supabase
        .from('leads').insert({ phone_e164: phone }).select('id').single();
      if (leadErr || !leadNew) {
        await supabase.from('event_log').insert({
          type: 'twilio_inbound', payload: { params, error: leadErr } as any,
          message: 'Lead create fallito', level: 'error',
        });
        return new NextResponse(TWIML_OK, { status: 200, headers: TWIML_HEADERS });
      }
      leadId = leadNew.id;
    }

    // Conversation
    let conversationId: number;
    const { data: convExisting } = await supabase
      .from('conversations').select('id').eq('lead_id', leadId).maybeSingle();
    if (convExisting) {
      conversationId = convExisting.id;
    } else {
      const { data: convNew, error: convErr } = await supabase
        .from('conversations').insert({ lead_id: leadId }).select('id').single();
      if (convErr || !convNew) {
        await supabase.from('event_log').insert({
          type: 'twilio_inbound', payload: { params, error: convErr } as any,
          message: 'Conv create fallito', level: 'error',
        });
        return new NextResponse(TWIML_OK, { status: 200, headers: TWIML_HEADERS });
      }
      conversationId = convNew.id;
    }

    // Nota vocale → trascrivi in testo così Mario (e l'inbox) la leggono come messaggio.
    let messageBody = params.Body ?? '';
    if ((!messageBody || messageBody.trim() === '') && isAudioInbound(params)) {
      const transcript = await transcribeTwilioAudio(params.MediaUrl0 ?? '', params.MediaContentType0 ?? '');
      messageBody = transcript ?? '[nota vocale]';
      await supabase.from('event_log').insert({
        type: transcript ? 'voice_transcribed' : 'voice_transcribe_failed',
        payload: { from: phone, contentType: params.MediaContentType0 } as never,
        message: transcript
          ? `Nota vocale trascritta da ${phone}`
          : `Trascrizione nota vocale non riuscita da ${phone}`,
        level: transcript ? 'info' : 'warn',
      });
    }

    // Insert messaggio (UNIQUE su twilio_sid → dedup retry)
    const { error: msgErr } = await supabase.from('messages').insert({
      conversation_id: conversationId,
      direction: 'in',
      body: messageBody,
      twilio_sid: params.MessageSid,
      twilio_status: 'received',
    });

    if (msgErr) {
      // Possibile duplicato (UNIQUE violation) → skip
      await supabase.from('event_log').insert({
        type: 'twilio_inbound', payload: { sid: params.MessageSid, error: msgErr } as any,
        message: msgErr.code === '23505' ? 'Duplicato (UNIQUE)' : `Insert fallito: ${msgErr.message}`,
        level: msgErr.code === '23505' ? 'info' : 'error',
      });
      return new NextResponse(TWIML_OK, { status: 200, headers: TWIML_HEADERS });
    }

    // Bump conversazione: 2 query (V1 — sufficiente, no RPC)
    const now = new Date().toISOString();
    const { data: cur } = await supabase
      .from('conversations').select('unread_count').eq('id', conversationId).single();
    await supabase.from('conversations').update({
      last_message_at: now,
      last_inbound_at: now,
      unread_count: (cur?.unread_count ?? 0) + 1,
      // Numero aziendale su cui il lead ci scrive: le risposte devono partire
      // dallo stesso numero (la finestra 24h vale per coppia numero/utente).
      ...(params.To?.startsWith('whatsapp:') ? { wa_number: params.To } : {}),
    }).eq('id', conversationId);

    await supabase.from('event_log').insert({
      type: 'twilio_inbound', payload: { sid: params.MessageSid, from: phone },
      message: `Inbound ricevuto da ${phone}`, level: 'info',
    });

    // Auto-risposta Mario (solo numero Fenice + lead arruolato + switch ON)
    const feniceNumber = process.env.TWILIO_WHATSAPP_NUMBER_FENICE;
    const toMatchesFenice = !!feniceNumber && (params.To ?? '') === feniceNumber;
    if (toMatchesFenice) {
      const { data: conv } = await supabase
        .from('conversations')
        .select('ai_owner, ai_status, ai_paused_at, handed_off_at, crm_lead_id, bot_outcome, lancio_slug, lancio_fase, lancio_ingresso, lancio_info')
        .eq('id', conversationId)
        .single();

      // L'interruttore generale si legge PRIMA dell'adozione: e' anche un veto
      // sull'adozione, non solo sulla risposta. A bot spento — cioe' durante un
      // incidente, l'unico momento in cui lo si spegne — adottare senza rispondere
      // lascerebbe quella conversazione fuori da tutte e tre le reti di recupero.
      // Non costa una query in piu': serviva comunque a `shouldAutoReply` qui sotto.
      const autoReplyOn = await getAutoReply(supabase);

      // Il gate dell'interruttore va valutato PRIMA del conteggio degli outbound: a bot
      // spento (come in produzione) non deve costare nessuna query in piu' al webhook,
      // che deve restare veloce perche' Twilio ritenta. Sta qui sopra perche' serve anche
      // alla decisione del pulsante, subito sotto.
      const adozioneAttiva = process.env.INBOUND_ADOPTION_ENABLED === '1';

      // Pulsante del webinar (spec lancio §5.4, §6.3): scatta sull'inbound CORRENTE e
      // vince su chi possiede la chat e su quello che il lead aveva detto prima — anche
      // su una chat gia' di Mario, anche su una gia' dentro il lancio. Il lead della
      // lista d'attesa ha la chat aperta da settimane e preme il pulsante la sera del 5:
      // e' quel messaggio che conta, non il primo. Un inbound SENZA marker invece non
      // tocca mai `lancio_fase`: le fasi le muove il turno del lancio dentro il drain.
      const markerPulsante = isMarkerPulsanteWebinar(messageBody);
      // L'interruttore `lancio_pulsante_attivo` si legge SOLO quando il marker c'e'
      // davvero: sull'inbound normale — cioe' su tutti — il gate non costa nessuna query
      // in piu', e sulla frase del pulsante ne costa una sola (`app_settings`, la stessa
      // riga che legge il resto del lancio). Spento, il marker vale come assente: non
      // arriva a `shouldAdoptInbound`, non arriva a `classificaPrimoMessaggio`, e
      // `pulsanteScriveFase` lo dice con `pulsante_spento`.
      const pulsanteAttivo = markerPulsante ? (await getLancioSettings(supabase)).pulsanteAttivo : false;
      const lancioPulsante = markerPulsante && pulsanteAttivo;
      if (conv && markerPulsante) {
        // Il gate dell'adozione, valutato qui perche' e' la seconda delle due sole
        // condizioni che autorizzano a scrivere lo stato del lancio (vedi
        // `pulsanteScriveFase`). Col pulsante `shouldAdoptInbound` non guarda
        // `hasOutbound` — la richiesta e' esplicita e fatta adesso — quindi qui il
        // conteggio degli outbound non serve, e resta dentro il ramo dell'adozione dove
        // si paga solo quando serve davvero. `hasOutbound: true` e' il valore prudente:
        // se un domani quella regola cambiasse, di qui si uscirebbe con un evento orfano
        // e nessuna scrittura, non col contrario.
        const adottaOra = shouldAdoptInbound({
          toMatchesFenice,
          adoptionOn: adozioneAttiva,
          autoReplyOn,
          aiOwner: conv.ai_owner,
          aiPausedAt: conv.ai_paused_at,
          handedOffAt: conv.handed_off_at,
          hasOutbound: true,
          lancioPulsante,
        });
        const decisione = pulsanteScriveFase({
          pulsanteAttivo,
          aiOwner: conv.ai_owner,
          aiPausedAt: conv.ai_paused_at,
          handedOffAt: conv.handed_off_at,
          adottaOra,
          autoReplyOn,
          adozioneAttiva,
        });

        if (!decisione.scrive) {
          // Finestra orfana: scrivere `lancio_slug` qui toglierebbe questa chat da
          // `adotta-mai-risposti` (che esclude lo slug non nullo) e dalle altre reti di
          // recupero, senza che nessuno le risponda. Si lascia intatta e si registra il
          // pulsante: quando l'adozione si accende, il cron lo riclassifica e la porta
          // lui in `post_pitch`.
          await supabase.from('event_log').insert({
            type: 'lancio_pulsante',
            payload: {
              conversationId,
              giaDiMario: conv.ai_owner === 'mario',
              orfano: true,
              motivo: decisione.motivo,
            } as never,
            message: `[lancio] ${phone} ha premuto il pulsante del webinar ma la chat non e' governata (${decisione.motivo}): nessuna scrittura sul lancio (conv ${conversationId})`,
            level: 'warn',
          });
        } else {
          // La fase si calcola PRIMA delle colonne perche' decide anche la riapertura:
          // l'elenco delle fasi da cui si rientra e' chiuso (vedi `pulsanteRiportaInPostPitch`)
          // e da `followup_inviato` e `restituito` la fase NON si muove — dopo il follow-up
          // la chat e' del flusso standard di B5, e un restituito e' tornato al GDO.
          const cambiaFase = pulsanteRiportaInPostPitch(conv.lancio_fase);
          // Se la chat di Mario era 'closed' (un no di settimane fa, o il congedo del
          // lancio) si riapre: sta scrivendo adesso, e col pulsante. Mai su una chat
          // senza padrone, in pausa o passata a una persona: quelle non arrivano qui — e
          // mai quando la fase resta dov'e' (ruling C8, vedi `pulsanteRiapreChat`).
          // Le colonne d'ingresso si scrivono solo se mancano: chi e' entrato dalla
          // lista resta 'lista'.
          const riapri = pulsanteRiapreChat({
            cambiaFase, aiOwner: conv.ai_owner, aiStatus: conv.ai_status,
          });
          const colonne = {
            ...(conv.lancio_slug ? {} : { lancio_slug: LANCIO_SLUG }),
            ...(conv.lancio_ingresso ? {} : { lancio_ingresso: 'pulsante_webinar' }),
            ...(riapri ? { ai_status: 'active' } : {}),
          };
          if (Object.keys(colonne).length > 0) {
            const { error: erroreColonne } = await supabase
              .from('conversations').update(colonne).eq('id', conversationId);
            if (erroreColonne) {
              await supabase.from('event_log').insert({
                type: 'lancio_pulsante_colonne_non_scritte',
                payload: { conversationId, phone, colonne, errore: erroreColonne.message } as never,
                message: `[lancio] conv ${conversationId}: colonne d'ingresso del pulsante NON scritte — ${erroreColonne.message}`,
                level: 'warn',
              });
            } else if (riapri) {
              // La copia in memoria serve subito dopo: e' quella che `shouldAutoReply` legge.
              conv.ai_status = 'active';
            }
          }
          // `impostaFaseLancio` (lib/lancio-db.ts) e' l'unico scrittore di `lancio_fase` e
          // si scrive da solo l'evento `lancio_fase_cambiata`. Await e non `after()`: e' un
          // update solo, e la fase deve essere sul posto prima che il drain parta qui sotto.
          if (cambiaFase) {
            await impostaFaseLancio(supabase, conversationId, 'post_pitch');
            conv.lancio_fase = 'post_pitch';
          }
          // L'evento si scrive SEMPRE, anche a fase invariata: che quella persona abbia
          // premuto il pulsante si deve vedere nei pannelli comunque.
          await supabase.from('event_log').insert({
            type: 'lancio_pulsante',
            payload: {
              conversationId,
              giaDiMario: conv.ai_owner === 'mario',
              ...(cambiaFase ? {} : { faseInvariata: true }),
            } as never,
            message: `[lancio] ${phone} ha premuto il pulsante del webinar (conv ${conversationId})${cambiaFase ? '' : `, fase ${conv.lancio_fase} invariata`}`,
            level: 'info',
          });
        }
      }

      // Adozione: il lead ha scritto per primo e questa chat non e' di nessuno.
      //
      // Il conteggio degli outbound si fa SOLO quando `ai_owner` e' nullo: sulle chat
      // gia' arruolate (la stragrande maggioranza degli inbound) non si aggiunge nessuna
      // query al webhook.
      // `autoReplyOn` sta qui per la stessa ragione dell'interruttore: a bot spento
      // il conteggio non serve, perche' `shouldAdoptInbound` direbbe no comunque.
      if (adozioneAttiva && autoReplyOn && conv && conv.ai_owner === null) {
        const { count, error: erroreCount } = await supabase
          .from('messages')
          .select('id', { count: 'exact', head: true })
          .eq('conversation_id', conversationId)
          .eq('direction', 'out');
        // Se il conteggio fallisce non sappiamo se questa chat ha una storia (un lead GDO,
        // una campagna, una chat lavorata a mano): senza la certezza che nessuno abbia mai
        // scritto, non si adotta. L'incertezza chiude, non apre.
        const hasOutbound = erroreCount ? true : (count ?? 0) > 0;
        if (shouldAdoptInbound({
          toMatchesFenice,
          adoptionOn: adozioneAttiva,
          autoReplyOn,
          aiOwner: conv.ai_owner,
          aiPausedAt: conv.ai_paused_at,
          handedOffAt: conv.handed_off_at,
          hasOutbound,
          lancioPulsante,
        })) {
          // La provenienza si legge dal PRIMO messaggio della conversazione, non da
          // quello appena arrivato: chi e' in arretrato e riscrive "Scusa poi risponde"
          // verrebbe classificato INBOUND invece di TELEGRAM, e la sua provenienza sulle
          // statistiche del CRM sarebbe falsa. E' quello che fa gia'
          // `app/api/cron/adotta-mai-risposti/route.ts`. La query sta dentro il ramo
          // dell'adozione, che e' raro: il webhook normale non paga niente.
          // Il pulsante del webinar fa eccezione e si legge dal messaggio corrente: vedi lib/primo-messaggio.ts.
          const { data: primiInbound } = await supabase
            .from('messages')
            .select('body, created_at')
            .eq('conversation_id', conversationId)
            .eq('direction', 'in')
            .order('created_at', { ascending: true })
            .limit(1);
          const primoRigaInbound = (primiInbound ?? [])[0] as { body: string | null; created_at: string } | undefined;
          // Il messaggio corrente e' il fallback: se la lettura fallisce o la riga non si
          // vede ancora, e' comunque il primo inbound di questa conversazione.
          const primoMessaggioTesto = primoRigaInbound?.body ?? messageBody;
          const esito = classificaPrimoMessaggio({ primoInbound: primoMessaggioTesto, inboundCorrente: messageBody, pulsanteAttivo });
          const provenienza = esito.provenienza;
          // Cinque minuti indietro, e non `now`: il messaggio che ha innescato questa
          // adozione e' stato inserito qui sopra col `created_at` di default, cioe'
          // l'orologio di Postgres, mentre `now` viene da quello di Node. Con
          // `ai_started_at` anche solo un istante piu' recente, il filtro
          // `.gte('created_at', startedAt)` di `loadHistory` (lib/fenice-autoreply.ts)
          // lascia fuori proprio quel messaggio: la cronologia esce vuota e il drain
          // non risponde a nessuno. E' lo stesso scarto fra i due orologi per cui
          // `app/api/cron/sequence-touches/route.ts` usa un buffer di 5 minuti.
          // Effetto voluto: chi manda tre messaggi di fila in due minuti se li vede
          // leggere tutti, invece che solo l'ultimo.
          const startedAtAdozione = new Date(Date.now() - 5 * 60_000).toISOString();
          // Compare-and-set su `ai_owner`, come nel cron: due messaggi dello stesso numero
          // nuovo arrivano insieme (succede: il lead manda "ciao" e poi il vero
          // messaggio), Twilio apre due richieste e senza questa condizione entrambe
          // adottano e entrambe spingono il lead al CRM. Nessuna riga tornata = l'ha
          // presa l'altra richiesta: qui non si logga e non si spinge niente.
          const { data: adottate, error: erroreAdozione } = await supabase.from('conversations').update({
            ai_owner: 'mario',
            ai_status: 'active',
            ai_started_at: startedAtAdozione,
            crm_funnel: provenienza,
          }).eq('id', conversationId).is('ai_owner', null).select('id');
          if (erroreAdozione) {
            // Sul database lo stato e' rimasto quello vecchio: NON si muta la copia in
            // memoria e NON si scrive il log di adozione, altrimenti mentirebbe (il claim
            // di `drainMarioReplies` su ai_status='active' non passerebbe comunque).
            await supabase.from('event_log').insert({
              type: 'inbound_adozione_fallita',
              payload: { conversationId, phone, provenienza, error: erroreAdozione.message } as never,
              message: `[bot-fissatore] adozione fallita per ${phone}: ${erroreAdozione.message}`,
              level: 'error',
            });
          } else if (!adottate || adottate.length === 0) {
            // Presa da un'altra richiesta in volo. Non si tocca la copia in memoria: e'
            // quella richiesta a rispondere (il suo `drainMarioReplies` risponde anche a
            // questo inbound, che a quel punto e' gia' in `messages`), e il suo push al
            // CRM e' gia' partito. Un secondo giro qui vorrebbe dire due lead entranti.
          } else {
            // La copia in memoria serve subito dopo: e' quella che `shouldAutoReply` legge.
            conv.ai_owner = 'mario';
            conv.ai_status = 'active';
            await supabase.from('event_log').insert({
              type: 'inbound_adottato',
              payload: { conversationId, phone, provenienza, tipo: esito.tipo } as never,
              message: `[bot-fissatore] adottato ${phone}: ha scritto per primo (${provenienza})`,
              level: 'info',
            });
            // Spinge il lead al CRM cosi' l'esito ha dove tornare. Dopo la risposta a
            // Twilio, come `drainMarioReplies` qui sotto: la rete del CRM non deve
            // rallentare il webhook, che Twilio ritenta se e' lento.
            after(pushLeadEntrante(supabase, {
              conversationId,
              telefono: phone,
              nome: null,
              provenienza,
              primoMessaggio: primoMessaggioTesto,
              scrittoIl: primoRigaInbound?.created_at ?? now,
            }));
          }
        }
      }

      // Il lead ha risposto dopo il messaggio del terzo tentativo di chiamata: da parte
      // del CRM è già stato scartato in automatico e solo le Conferme possono riaprirlo.
      // Sta PRIMA della riapertura e fuori da `shouldAutoReply` apposta: deve partire
      // anche da una chat rimasta 'booked' o messa in pausa a mano, cioè proprio da
      // quella di un lead con l'appuntamento in piedi, che è il caso per cui esiste.
      // Dopo la risposta a Twilio: la rete del CRM non deve rallentare il webhook.
      if (conv?.crm_lead_id) {
        after(segnalaRispostaDopoTerzoNr(supabase, conversationId, conv.crm_lead_id));
      }

      // Lead del lancio gia' restituito al pool (B5, ruling C8): non si riapre, il bot
      // tace, e chi lo ha in carico sul CRM viene avvisato con una nota — e' l'unico
      // modo perche' non chiami a vuoto una persona che intanto sta scrivendo qui.
      const restituito = !!conv?.lancio_slug && conv.lancio_fase === 'restituito';
      if (conv && restituito) {
        await supabase.from('event_log').insert({
          type: 'lancio_inbound_dopo_restituzione',
          payload: {
            conversationId, phone, crmLeadId: conv.crm_lead_id, testo: messageBody.slice(0, 300),
            ...(conv.crm_lead_id && !serveNotaRestituzione(conv.lancio_info, Date.now())
              ? { notaSoppressa: true }
              : {}),
          } as never,
          message: `[lancio] ${phone} ha riscritto dopo il ritorno nel pool (conv ${conversationId}): il bot non risponde`,
          level: 'info',
        });
        // Dopo la risposta a Twilio, come tutte le altre note: la rete del CRM non deve
        // rallentare il webhook. Senza `crm_lead_id` non c'e' nessuno da avvisare —
        // `sendCrmNota` lo rileggerebbe da se' e uscirebbe con 'not_crm_lead'.
        // Una nota all'ora per chat (ruling C8): chi manda cinque messaggi non deve
        // produrre cinque campanelle. L'evento qui sopra invece si scrive sempre.
        // Il marcatore si stampa PRIMA dell'invio, e con l'await: due inbound in volo
        // insieme devono trovarlo gia' li' e mandarne una sola.
        if (conv.crm_lead_id && serveNotaRestituzione(conv.lancio_info, Date.now())) {
          const quandoNota = new Date().toISOString();
          await marcaNotaRestituzione(supabase, conversationId, quandoNota);
          after(sendCrmNota(supabase, conversationId, notaInboundDopoRestituzione(messageBody, quandoNota)));
        }
      }

      if (conv && shouldReopen({
        aiOwner: conv.ai_owner,
        aiStatus: conv.ai_status,
        aiPausedAt: conv.ai_paused_at,
        // Chat del lancio gia' congedata o restituita: non si riapre (vedi `shouldReopen`).
        lancioSlug: conv.lancio_slug,
        lancioInfo: conv.lancio_info,
        lancioFase: conv.lancio_fase,
      })) {
        await supabase.from('conversations').update({ ai_status: 'active' }).eq('id', conversationId);
        conv.ai_status = 'active';
        // Il lead era già stato restituito al CRM e ha riscritto: da adesso il bot e i
        // GDO lavorano la stessa persona. Avvisarli è l'unico modo perché non chiamino
        // a vuoto (caso Marina Destefanis). APPUNTAMENTO è escluso: lì il lead è già in
        // agenda e la riapertura ha il suo canale, le note del lead terminale.
        // Dopo la risposta a Twilio: la loro rete non deve rallentare il webhook.
        if (conv.crm_lead_id && conv.bot_outcome && conv.bot_outcome !== 'APPUNTAMENTO') {
          after(
            sendCrmNota(
              supabase,
              conversationId,
              buildBotRipresoNote({ esitoPrecedente: conv.bot_outcome, quandoIso: new Date().toISOString() }),
            ),
          );
        }
      }

      if (!restituito && shouldAutoReply({
        toMatchesFenice,
        autoReplyOn,
        aiOwner: conv?.ai_owner ?? null,
        aiStatus: conv?.ai_status ?? null,
        aiPausedAt: conv?.ai_paused_at ?? null,
      })) {
        // Dopo aver risposto 200 a Twilio: Mario risponde in background, con latenza.
        after(drainMarioReplies(supabase, conversationId, phone));
      }
    }
  }

  return new NextResponse(TWIML_OK, { status: 200, headers: TWIML_HEADERS });
}
