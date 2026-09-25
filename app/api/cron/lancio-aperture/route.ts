import { NextRequest, NextResponse } from 'next/server';
import { mittenteDiConversazione } from '@/lib/mittente';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
// `sendTemplate` chiama da solo `assertTemplateSendable` (presidio UTILITY_ONLY): il
// rifiuto arriva come eccezione senza `code`, e lo riconosce `eRifiutoDiPolicy`.
import { sendTemplate } from '@/lib/twilio';
import { getLancioSettings } from '@/lib/lancio-settings';
import {
  decideAperturaLancio,
  riassumiOutboundLancio,
  benvenutoLancioChiuso,
  CODICE_FREQUENCY_CAP,
  type RigaOutbound,
} from '@/lib/lancio-aperture';
import { leggiTettoOrario, sottoTettoOrario } from '@/lib/lancio-tetto';
import { contaBenvenutiUltimaOra, leggiIngressiLancioAt, impostaFaseLancio } from '@/lib/lancio-db';
import { conMarioDopoNotte } from '@/lib/lancio-fase';
import type { Json } from '@/lib/supabase/types';
import { inOpeningWindow } from '@/lib/sequence';
import { componiBenvenutoLancio, messaggioBenvenutoNonComponibile } from '@/lib/lancio-benvenuto';
import { logCronQueryError } from '@/lib/cron-query-error';
import { eRifiutoDiPolicy, allarmeEventoStantio } from '@/lib/lancio-blast-motore';
import { spedibileDa } from '@/lib/lancio-mittente';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// Benvenuti del lancio rimasti indietro (intake fuori dalla fascia 07-23 o lancio
// spento). Queste chat sono escluse dai cron di Mario (sequenza, nudge, promemoria,
// solleciti) da `FILTRO_FUORI_LANCIO`, esclusioni gia' in piedi (Task 10): senza questo
// cron resterebbero mute per sempre — e comunque il benvenuto lo manda solo chi lo sa
// mandare, cioe' questo route, perche' la sequenza non conosce il template del lancio.
// Schedule in vercel.json: ogni 15' dalle 05 alle 21 UTC; il filtro sull'ora italiana lo
// fa `inOpeningWindow`, perche' l'ora legale sposta la fascia e il cron no.
//
// L'invio e' protetto da `conversations.lancio_benvenuto_at`, timbrato PRIMA della
// chiamata a Twilio: e' insieme il filtro dei candidati (una chat servita non si
// ripresenta mai piu', quindi la coda non si intasa) e il lucchetto contro due run
// sovrapposti. Il timbro si toglie SOLO se a Twilio non e' partito niente: dopo un invio
// riuscito resta dov'e', qualunque cosa fallisca dopo.

type Supa = ReturnType<typeof getSupabaseAdmin>;

/** Quanti candidati per giro di letture. Una sola query `messages` per lotto. */
const LOTTO = 100;
/** Righe in uscita lette per lotto: le chat del lancio ne hanno una manciata. */
const MAX_RIGHE_LOTTO = LOTTO * 20;
/** Paracadute sulla paginazione: 20.000 candidati sono gia' un'anomalia da guardare. */
const MAX_PAGINE = 20;

/** `whatsapp:+39…` e `+39…` sono lo stesso numero. */
function stessoNumero(a: string, b: string): boolean {
  const n = (x: string) => x.trim().replace(/^whatsapp:/i, '');
  return n(a) === n(b);
}

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  if (req.headers.get('authorization') === `Bearer ${secret}`) return true;
  if (req.nextUrl.searchParams.get('secret') === secret) return true;
  return false;
}

type Conv = {
  id: number;
  crm_lead_id: string | null;
  /** Il numero da cui questa chat parla: il benvenuto differito deve uscire di li'. */
  wa_number: string | null;
  lancio_fase: string | null;
  lancio_benvenuto_at: string | null;
  last_inbound_at: string | null;
  leads: { phone_e164: string | null; first_name: string | null } | null;
};

type RigaLotto = RigaOutbound & { conversation_id: number };

async function logEvento(
  supabase: Supa,
  type: string,
  payload: Record<string, unknown>,
  message: string,
  level: 'info' | 'warn' | 'error' = 'info',
): Promise<void> {
  await supabase.from('event_log').insert({ type, payload: payload as never, message, level });
}

/**
 * La coda dei benvenuti rimasta a live finita passa a Mario standard (PO 25/09). Stessa
 * query dei candidati (lancio, `attesa`, mai servite, attive, non in pausa); la fase si
 * scrive con `impostaFaseLancio` e la guardia `soloDaFasi: ['attesa']`, cosi' una chat
 * che nel frattempo si e' mossa (il lead ha scritto, il turno l'ha portata avanti) non
 * torna indietro. Una chat senza `crm_lead_id` non la vede `sequence-touches`: si conta a
 * parte, e va guardata a mano.
 */
async function passaCodaAMario(supabase: Supa, attivo: boolean): Promise<NextResponse> {
  const coda: { id: number; crm_lead_id: string | null; lancio_info: unknown }[] = [];
  let queryKo = false;
  for (let pagina = 0; pagina < MAX_PAGINE; pagina++) {
    const { data, error } = await supabase
      .from('conversations')
      .select('id, crm_lead_id, lancio_info')
      .not('lancio_slug', 'is', null)
      .eq('lancio_fase', 'attesa')
      .eq('ai_status', 'active')
      .is('ai_paused_at', null)
      .is('lancio_benvenuto_at', null)
      .order('id', { ascending: true })
      .range(pagina * 1000, pagina * 1000 + 999);
    if (error) {
      queryKo = true;
      await logCronQueryError(supabase, 'lancio_aperture_query_error', error);
      break;
    }
    const lotto = (data ?? []) as unknown as typeof coda;
    coda.push(...lotto);
    if (lotto.length < 1000) break;
  }
  const at = new Date().toISOString();
  let passati = 0;
  let nonPassati = 0;
  let senzaLeadCrm = 0;
  for (const c of coda) {
    const esito = await impostaFaseLancio(
      supabase, c.id, 'chiuso',
      { lancio_info: conMarioDopoNotte(c.lancio_info, 'iscritto_dopo_live', at) as unknown as Json },
      { soloDaFasi: ['attesa'] },
    );
    if (esito !== 'cambiata') {
      nonPassati++;
      continue;
    }
    passati++;
    if (!c.crm_lead_id) senzaLeadCrm++;
    await logEvento(
      supabase,
      'lancio_benvenuto_dopo_live_a_mario',
      { conversationId: c.id, crmLeadId: c.crm_lead_id },
      `[lancio] conv ${c.id}: live finita senza benvenuto, la chat passa a Mario standard${c.crm_lead_id ? '' : ' (SENZA crm_lead_id: la sequenza non la vede, guardarla a mano)'}`,
      c.crm_lead_id ? 'info' : 'warn',
    );
  }
  await logEvento(
    supabase,
    'lancio_aperture_run',
    { motivo: 'dopo_live', candidati: coda.length, inviati: 0, passatiAMario: passati, nonPassati, senzaLeadCrm, queryKo, attivo },
    `[lancio] benvenuti differiti: live finita, ${passati} chat passate a Mario standard (${nonPassati} non passate, ${senzaLeadCrm} senza lead CRM)`,
    queryKo || nonPassati > 0 || senzaLeadCrm > 0 ? 'warn' : 'info',
  );
  return NextResponse.json({ ok: true, motivo: 'dopo_live', candidati: coda.length, inviati: 0, passatiAMario: passati, nonPassati, senzaLeadCrm, queryKo, attivo });
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return new NextResponse('unauthorized', { status: 401 });

  const supabase = getSupabaseAdmin();
  const templateSid = process.env.LANCIO_WELCOME_TEMPLATE_SID;
  const from = process.env.TWILIO_WHATSAPP_NUMBER_FENICE;
  if (!templateSid || !from) {
    await logEvento(
      supabase,
      'lancio_aperture_config_error',
      {
        missing: [
          !templateSid ? 'LANCIO_WELCOME_TEMPLATE_SID' : null,
          !from ? 'TWILIO_WHATSAPP_NUMBER_FENICE' : null,
        ].filter(Boolean),
      },
      '[lancio] env mancanti per i benvenuti differiti: run saltato',
      'error',
    );
    return NextResponse.json({ ok: true, inviati: 0, skipped: 'config' });
  }

  const settings = await getLancioSettings(supabase);
  const now = Date.now();
  const maxPerRun = Math.max(1, Number(process.env.LANCIO_APERTURE_MAX_PER_RUN) || 100);

  // Dopo la live (decisione PO del 25/09) il benvenuto non parte piu' — un benvenuto
  // differito direbbe "lunedi' 5 alle 21" col link Zoom di una live finita. Chi e' rimasto
  // in coda senza benvenuto passa a Mario standard, come chi si iscrive dopo
  // (`enrollLancio`): fase `chiuso` col marcatore della nota "la live c'e' gia' stata",
  // e l'apertura la manda `sequence-touches` con le sue regole. Da qui non parte nessun
  // messaggio, quindi non conta ne' il kill-switch del lancio ne' la fascia oraria.
  //
  // ATTENZIONE: se `lancio_evento_at` resta indietro (una prova generale non riportata
  // al 5/10) questo ramo scatta PRIMA della live e manda a Mario gli iscritti senza
  // benvenuto. Per questo, a lancio acceso, l'allarme della data stantia suona anche qui.
  if (benvenutoLancioChiuso(now, settings.eventoAt)) {
    if (settings.attivo) await allarmeEventoStantio(supabase, 'lancio-aperture', new Date(now), settings.eventoAt);
    return passaCodaAMario(supabase, settings.attivo);
  }

  // Kill-switch e fascia oraria valgono per TUTTI i candidati: si esce prima di
  // leggere anche una sola conversazione (il cron gira ogni 15', di notte gira a vuoto
  // 40 volte). Il run resta scritto, cosi' il silenzio ha una spiegazione.
  const motivoFermo = !settings.attivo ? 'lancio_spento' : !inOpeningWindow(now) ? 'fuori_fascia' : null;
  if (motivoFermo) {
    await logEvento(
      supabase,
      'lancio_aperture_run',
      { motivo: motivoFermo, candidati: 0, inviati: 0, attivo: settings.attivo },
      `[lancio] benvenuti differiti: nessun invio (${motivoFermo})`,
    );
    return NextResponse.json({ ok: true, inviati: 0, attesi: 0, saltati: 0, capped: 0, falliti: 0, motivo: motivoFermo, attivo: settings.attivo });
  }

  // Allarme e basta (non ferma il run): `lancio_evento_at` rimasto indietro spegne in
  // silenzio le finestre di blast, follow-up e restituzioni. Sta DOPO il kill-switch di
  // proposito: questo e' l'unico dei quattro cron del lancio che gira tutto l'anno ogni
  // 15', e a lancio spento un evento passato e' solo un lancio finito, non un guasto.
  await allarmeEventoStantio(supabase, 'lancio-aperture', new Date(now), settings.eventoAt);

  // Tetto orario (spec §11.3): lo stesso dell'intake, contato sulle stesse righe. Senza,
  // questo cron sarebbe proprio il modo di rifare il picco che il tetto dell'intake
  // evita — la coda differita si e' formata apposta perche' si stava andando troppo
  // forte. Il conteggio comprende i benvenuti dell'intake: il numero WhatsApp e' uno solo
  // e Meta guarda lui, non da quale pezzo di codice e' partito il messaggio.
  const tettoOrario = leggiTettoOrario(process.env.LANCIO_WELCOME_MAX_PER_HOUR);
  const conteggio = await contaBenvenutiUltimaOra(supabase, templateSid, now);
  // Conteggio illeggibile: il run non parte. Mandare alla cieca proprio mentre il DB e'
  // in affanno e' il modo di rifare il picco; la coda non si perde, il cron ripassa fra
  // 15 minuti. (L'evento `lancio_tetto_non_letto` lo scrive gia' il conteggio.)
  if (conteggio === null) {
    await logEvento(
      supabase,
      'lancio_aperture_run',
      { fermo: 'tetto_non_leggibile', tetto: tettoOrario, candidati: 0, inviati: 0, attivo: settings.attivo },
      '[lancio] benvenuti differiti: run fermo, tetto orario non leggibile',
      'warn',
    );
    return NextResponse.json({
      ok: true, candidati: 0, inviati: 0, attesi: 0, saltati: 0, capped: 0, falliti: 0, errori: 0,
      fermo: 'tetto_non_leggibile', inviatiUltimaOra: null, tetto: tettoOrario, attivo: settings.attivo,
    });
  }
  const inviatiUltimaOra = conteggio;
  if (!sottoTettoOrario({ inviatiUltimaOra, cap: tettoOrario })) {
    await logEvento(
      supabase,
      'lancio_aperture_run',
      { fermo: 'tetto_orario', inviatiUltimaOra, tetto: tettoOrario, candidati: 0, inviati: 0, attivo: settings.attivo },
      `[lancio] benvenuti differiti: run fermo, tetto orario raggiunto (${inviatiUltimaOra}/${tettoOrario})`,
      'warn',
    );
    return NextResponse.json({
      ok: true, candidati: 0, inviati: 0, attesi: 0, saltati: 0, capped: 0, falliti: 0, errori: 0,
      fermo: 'tetto_orario', inviatiUltimaOra, tetto: tettoOrario, attivo: settings.attivo,
    });
  }

  // Candidati: chat del lancio in attesa, mai servite (`lancio_benvenuto_at is null`) e
  // non in mano a una persona. Il filtro sul timbro e' quello che tiene la coda corta:
  // senza, le chat gia' servite riempirebbero la prima pagina per sempre e le nuove non
  // arriverebbero mai in fondo alla query.
  const convs: Conv[] = [];
  for (let pagina = 0; pagina < MAX_PAGINE; pagina++) {
    const { data, error } = await supabase
      .from('conversations')
      .select('id, crm_lead_id, wa_number, lancio_fase, lancio_benvenuto_at, last_inbound_at, leads(phone_e164, first_name)')
      .not('lancio_slug', 'is', null)
      .eq('lancio_fase', 'attesa')
      .eq('ai_status', 'active')
      // Fermo manuale dal pannello: la chat e' in mano a una persona, nessun
      // automatismo le scrive addosso.
      .is('ai_paused_at', null)
      .is('lancio_benvenuto_at', null)
      .order('id', { ascending: true })
      .range(pagina * 1000, pagina * 1000 + 999);
    // Una query fallita torna `data: null`, cioe' zero candidati: senza questa riga il
    // run risponderebbe `inviati: 0` identico a una coda vuota. E' proprio il caso della
    // migrazione `lancio_*` non ancora applicata (Postgres 42703).
    if (error) {
      await logCronQueryError(supabase, 'lancio_aperture_query_error', error);
      break;
    }
    const lotto = (data ?? []) as unknown as Conv[];
    convs.push(...lotto);
    if (lotto.length < 1000) break;
  }

  let inviati = 0;
  let attesi = 0;
  let saltati = 0;
  let capped = 0;
  let falliti = 0;
  let errori = 0;
  // Il tetto e' sui TENTATIVI, non sugli invii riusciti: un run che sbatte su 100
  // numeri morti ha comunque fatto 100 chiamate a Twilio.
  let tentati = 0;
  // Due conversazioni sullo stesso numero (lead doppio nel CRM) sono due righe qui ma
  // una sola chat su WhatsApp: il benvenuto parte una volta per numero.
  const numeriServiti = new Set<string>();
  let fermo: string | null = null;

  for (let i = 0; i < convs.length && tentati < maxPerRun && !fermo; i += LOTTO) {
    const lotto = convs.slice(i, i + LOTTO);
    // Una query per lotto, non una per conversazione: 100 candidati = 1 round trip.
    const { data: righeData } = await supabase
      .from('messages')
      .select('conversation_id, template_sid, twilio_status, twilio_error_code, created_at')
      .in('conversation_id', lotto.map((c) => c.id))
      .eq('direction', 'out')
      .order('created_at', { ascending: false })
      .limit(MAX_RIGHE_LOTTO);
    const perConv = new Map<number, RigaOutbound[]>();
    for (const r of (righeData ?? []) as unknown as RigaLotto[]) {
      const lista = perConv.get(r.conversation_id);
      if (lista) lista.push(r);
      else perConv.set(r.conversation_id, [r]);
    }
    // Da quando questa chat e' nel giro corrente del lancio. Una query per lotto, come
    // quella dei messaggi. Serve alle RIPARTENZE: chi aveva chiuso e si e' riscritto al
    // lancio ha un ingresso nuovo, e i benvenuti della vita precedente non devono piu'
    // contare, o il cron lo salterebbe per sempre e la ripartenza sarebbe muta.
    const ingressi = await leggiIngressiLancioAt(supabase, lotto.map((c) => c.id));

    for (const c of lotto) {
      if (tentati >= maxPerRun || fermo) break;
      const phone = c.leads?.phone_e164 ?? null;
      if (!phone || numeriServiti.has(phone)) {
        saltati++;
        continue;
      }
      try {
        // Tutta la cronologia in uscita, senza tagli sull'arruolamento: su una chat
        // riusata l'apertura di Mario e' proprio quella che deve trattenere il
        // benvenuto per 12 ore (guardia `apertura_recente` dell'intake). Il taglio
        // sull'ingresso vale SOLO per il conteggio dei benvenuti gia' partiti, e senza
        // ingresso (nessun evento: pulsante della live, righe vecchie) si conta su tutto,
        // cioe' il comportamento di sempre.
        const ingressoAt = ingressi.get(c.id) ?? null;
        const ingressoMs = ingressoAt ? Date.parse(ingressoAt) || null : null;
        const riassunto = riassumiOutboundLancio(perConv.get(c.id) ?? [], templateSid, ingressoMs);
        const azione = decideAperturaLancio({
          nowMs: now,
          attivo: settings.attivo,
          fase: c.lancio_fase,
          benvenutoAt: c.lancio_benvenuto_at,
          ...riassunto,
          ultimoInboundMs: c.last_inbound_at ? Date.parse(c.last_inbound_at) || null : null,
        });
        if (azione === 'attendi') {
          attesi++;
          continue;
        }
        if (azione === 'salta') {
          saltati++;
          continue;
        }

        // Il tetto vale anche DENTRO il run: letto una volta sola all'inizio, un run da
        // 100 invii potrebbe sfondarlo di 100. `tentati` e' quello che questo giro ha
        // gia' aggiunto al numero.
        if (!sottoTettoOrario({ inviatiUltimaOra: inviatiUltimaOra + tentati, cap: tettoOrario })) {
          fermo = 'tetto_orario';
          break;
        }

        const nome = c.leads?.first_name ?? null;
        // Le variabili del benvenuto le detta il TEMPLATE, non questo codice: quello
        // nuovo (`fenice_lancio_benvenuto_v2`) ne vuole due, e la seconda e' il link
        // della live. Se il template le chiede e `lancio_zoom_link` e' vuoto NON si
        // manda: partirebbe un messaggio col buco al posto del link, a tutta la coda.
        // Sta PRIMA del timbro, cosi' nessuna chat viene consumata, e ferma il run come
        // fa il presidio dei template: la causa e' del lancio, non di questa chat, e
        // ripeterla per 100 candidati sarebbe cento volte lo stesso allarme.
        const benvenuto = await componiBenvenutoLancio({ templateSid, nome, zoomLink: settings.zoomLink });
        if (!benvenuto.ok) {
          fermo = 'benvenuto_non_componibile';
          await logEvento(
            supabase,
            'lancio_benvenuto_senza_link',
            {
              conversationId: c.id,
              crmLeadId: c.crm_lead_id,
              origine: 'lancio-aperture',
              motivo: benvenuto.motivo,
              templateSid,
              variabili: benvenuto.variabili,
              inCoda: convs.length,
            },
            messaggioBenvenutoNonComponibile(benvenuto.motivo, c.id, templateSid) +
              ` Run fermato: ${convs.length} chat restano in coda.`,
            'error',
          );
          break;
        }
        const corpo = benvenuto.corpo;

        // Il timbro PRIMA dell'invio: se due run si accavallano (il cron gira ogni 15'
        // e un run lento non e' un'ipotesi di scuola), il secondo trova la riga gia'
        // presa e passa oltre. `is('lancio_benvenuto_at', null)` rende l'update un
        // compare-and-set: chi non si riprende righe ha perso la gara.
        const timbro = new Date().toISOString();
        const { data: preso } = await supabase
          .from('conversations')
          .update({ lancio_benvenuto_at: timbro })
          .eq('id', c.id)
          .is('lancio_benvenuto_at', null)
          .select('id');
        if (((preso ?? []) as unknown[]).length === 0) {
          saltati++;
          continue;
        }
        // Si libera SOLO il timbro che ha messo questo giro: se nel frattempo un altro
        // run (o l'intake) ne ha scritto uno suo, quel timbro protegge un invio che non
        // e' nostro e toglierlo lo farebbe ripartire.
        const liberaTimbro = () =>
          supabase
            .from('conversations')
            .update({ lancio_benvenuto_at: null })
            .eq('id', c.id)
            .eq('lancio_benvenuto_at', timbro);

        // Il numero della CHAT, non quello del run: una conversazione nata sul secondo
        // numero deve ricevere anche il benvenuto differito da li', o il lead si ritrova
        // due thread e la finestra 24h si chiude.
        let mittente = mittenteDiConversazione(c) ?? from;
        // ...ma prima si verifica che il benvenuto sia davvero spedibile da quel numero.
        // I Content template vivono dentro un account, e la copia sul secondo puo' non
        // esserci o avere una categoria che `UTILITY_ONLY` rifiuta: mandare lo stesso
        // vorrebbe dire una riga `failed` senza SID e un lead che non riceve niente. In
        // quel caso si parte dal numero storico — `wa_number` non si tocca, lo riallinea
        // da solo il webhook in ingresso alla prima risposta del lead.
        if (!stessoNumero(mittente, from)) {
          const spedibile = await spedibileDa(templateSid, mittente);
          if (!spedibile.ok) {
            await logEvento(
              supabase,
              'lancio_mittente_ripiego',
              {
                conversationId: c.id,
                crmLeadId: c.crm_lead_id,
                origine: 'lancio-aperture',
                motivo: spedibile.motivo,
                numero: mittente,
                templateSid,
                sidTradotto: spedibile.sidTradotto,
                errore: spedibile.errore,
              },
              `[lancio] benvenuto differito non spedibile da ${mittente} (${spedibile.motivo}): parte dal numero storico — ${spedibile.errore ?? 'senza dettaglio'}`,
              'warn',
            );
            mittente = from;
          }
        }
        tentati++;
        numeriServiti.add(phone);
        // Il messaggio e' su WhatsApp: da qui in poi il timbro non si tocca piu'.
        // Qualunque cosa fallisca dopo (l'insert della riga `messages`, il bump della
        // conversazione, il log) non annulla un invio gia' partito, e liberare il timbro
        // rimetterebbe la chat fra i candidati: al run dopo il lead riceverebbe il
        // benvenuto una seconda volta.
        let spedito = false;
        try {
          const res = await sendTemplate({
            to: phone,
            contentSid: templateSid,
            variables: benvenuto.variables,
            from: mittente,
          });
          spedito = true;
          await supabase.from('messages').insert({
            conversation_id: c.id,
            direction: 'out',
            body: corpo,
            twilio_sid: res.sid,
            twilio_status: res.status,
            template_sid: templateSid,
            is_template: true,
            sender: 'automazione',
          });
          await supabase
            .from('conversations')
            .update({ last_message_at: new Date().toISOString() })
            .eq('id', c.id);
          await logEvento(
            supabase,
            'lancio_apertura_inviata',
            { conversationId: c.id, crmLeadId: c.crm_lead_id, sid: res.sid },
            `[lancio] benvenuto differito inviato a ${phone}`,
          );
          inviati++;
        } catch (err) {
          const e = err as { message?: string; code?: number };
          if (spedito) {
            // L'invio era andato: il guasto e' nostro, dopo Twilio. Si conta come
            // errore e si passa oltre SENZA liberare il timbro.
            errori++;
            await logEvento(
              supabase,
              'lancio_apertura_meta_incompleta',
              { conversationId: c.id, crmLeadId: c.crm_lead_id, error: e?.message ?? 'errore' },
              `[lancio] benvenuto inviato a ${phone} ma la registrazione e' fallita: ${e?.message ?? 'errore'}`,
              'error',
            );
            continue;
          }
          // Niente e' partito in nessuno dei rami sotto: il timbro va tolto, o la chat
          // resterebbe muta per sempre (non sarebbe piu' nemmeno candidata).
          await liberaTimbro();

          if (eRifiutoDiPolicy(e)) {
            // Non e' un invio fallito: e' il presidio che non ci ha fatto nemmeno
            // chiamare Twilio. Nessuna riga, budget intatto, e il run finisce qui.
            tentati--;
            numeriServiti.delete(phone);
            fermo = 'template_bloccato';
            await logEvento(
              supabase,
              'lancio_aperture_config_error',
              { conversationId: c.id, templateSid, error: e?.message ?? 'template non spedibile' },
              `[lancio] benvenuto bloccato dal presidio template: run fermato — ${e?.message ?? 'template non spedibile'}`,
              'error',
            );
            break;
          }

          if (e?.code === CODICE_FREQUENCY_CAP) {
            // Frequency cap Meta: nessuna riga (non consuma il budget dei ritentativi)
            // e si ritenta al run dopo, come nella sequenza. Il numero resta fra quelli
            // serviti: il cap e' del numero, non della conversazione, e ritentarlo
            // subito su una chat gemella lo ribeccherebbe.
            capped++;
            await logEvento(
              supabase,
              'lancio_apertura_freq_capped',
              { conversationId: c.id, crmLeadId: c.crm_lead_id },
              `[lancio] frequency cap Meta su conv ${c.id}: benvenuto rimandato al prossimo run`,
            );
            continue;
          }

          falliti++;
          // La riga fallita e' il contatore dei tentativi: senza, il ritentativo non
          // saprebbe mai di essere il secondo.
          await supabase.from('messages').insert({
            conversation_id: c.id,
            direction: 'out',
            body: corpo,
            twilio_status: 'failed',
            twilio_error_code: e?.code ?? null,
            template_sid: templateSid,
            is_template: true,
            sender: 'automazione',
          });
          await logEvento(
            supabase,
            'send_error',
            { conversationId: c.id, crmLeadId: c.crm_lead_id, error: e?.message ?? 'errore' },
            `[lancio] benvenuto differito fallito per ${phone}: ${e?.message ?? 'errore'}`,
            'error',
          );
        }
      } catch (e) {
        errori++;
        await logEvento(
          supabase,
          'lancio_aperture_error',
          { conversationId: c.id, error: e instanceof Error ? e.message : 'errore' },
          `[lancio] errore su conv ${c.id}: ${e instanceof Error ? e.message : 'errore'}`,
          'error',
        );
      }
    }
  }

  // Il run si scrive SEMPRE, anche a zero invii: un cron che non manda niente perche'
  // la coda e' vuota e uno che non manda niente perche' e' inceppato, da fuori, si
  // somigliano troppo.
  await logEvento(
    supabase,
    'lancio_aperture_run',
    { candidati: convs.length, inviati, attesi, saltati, capped, falliti, errori, fermo, inviatiUltimaOra, tetto: tettoOrario, attivo: settings.attivo },
    `[lancio] benvenuti differiti: ${inviati} inviati, ${attesi} in attesa, ${saltati} saltati, ${capped} cap, ${falliti} falliti, ${errori} errori su ${convs.length} candidati`,
    falliti > 0 || errori > 0 || fermo ? 'warn' : 'info',
  );

  return NextResponse.json({
    ok: true,
    candidati: convs.length,
    inviati,
    attesi,
    saltati,
    capped,
    falliti,
    errori,
    fermo,
    inviatiUltimaOra,
    tetto: tettoOrario,
    attivo: settings.attivo,
  });
}
