import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
// `sendTemplate` chiama da solo `assertTemplateSendable` (presidio UTILITY_ONLY): il
// rifiuto arriva come eccezione senza `code`, e lo riconosce `eRifiutoDiPolicy`.
import { sendTemplate, getTemplateBody } from '@/lib/twilio';
import { renderBodyTemplate } from '@/lib/campaigns';
import { templateName } from '@/lib/name';
import { runPool } from '@/lib/run-pool';
import { getLancioSettings, setLancioSetting } from '@/lib/lancio-settings';
import { impostaFaseLancio } from '@/lib/lancio-db';
import type { LancioFase } from '@/lib/lancio-fase';
import { logCronQueryError } from '@/lib/cron-query-error';
import {
  inFinestraBlast,
  finestraBlastChiusa,
  zoomBlastBody,
  batchMax,
  idoneoAlBlast,
  ordinaCandidatiBlast,
  decideFreno,
  LANCIO_BLAST_CONCURRENCY,
  type PerimetroBlast,
} from '@/lib/lancio-zoom-blast';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// Blast del link Zoom (spec §5.3, §11): ogni 5' dalle 19:30 alle 20:45 di Roma del giorno
// dell'evento, a lotti di LANCIO_BATCH_MAX (200), a chi e' ancora in `attesa` o
// `posto_bloccato` — anche a chi non ha mai risposto al benvenuto (decisione 14/09), mai
// a chi si e' congedato. ~3.000 lead in 16 run: il ritmo lo tiene il tetto del lotto, non
// una pausa dentro al run.
//
// Il numero WhatsApp e' a qualita' LOW e da qui non parte nient'altro che questo
// template. Le tre difese, in ordine di importanza:
//  1. IDEMPOTENZA. `lancio_link_inviato_at` e' insieme il filtro dei candidati e il
//     lucchetto: si timbra PRIMA di chiamare Twilio, con un compare-and-set, e si libera
//     solo se a Twilio non e' partito niente. La seconda guardia sono le righe `messages`
//     col SID del blast: coprono un run morto fra l'invio e la scrittura della fase.
//  2. FRENO. Ogni blocco di invii passa da `decideFreno`: sopra il 10% di fallimenti (o
//     al primo 63018/63049/63051) il run si ferma E spegne `lancio_attivo`, cosi' anche i
//     run successivi restano fermi finche' un admin non riaccende dal pannello.
//  3. PERIMETRO. `lancio_blast_perimetro` restringe il bersaglio a chi ha risposto almeno
//     una volta (piano B della spec §11), senza deploy.

type Supa = ReturnType<typeof getSupabaseAdmin>;

/** Ogni quanti invii si rivaluta il freno. Con lotti da 200 e concorrenza 5 sono 8
 *  controlli per run: il freno deve poter fermare il lotto mentre e' in corso, non
 *  scoprire a cose fatte che i primi 200 messaggi erano gia' tutti da buttare. */
const PASSO_FRENO = 25;
/** Quanto puo' durare il giro di invii prima di fermarsi da solo. `maxDuration` e' 300s:
 *  ci si ferma a 240 per avere il tempo di scrivere il riepilogo. */
const TEMPO_MASSIMO_MS = 240_000;
/** Paracadute sulla paginazione dei candidati: 20.000 e' gia' un'anomalia da guardare. */
const MAX_PAGINE = 20;
const PAGINA = 1000;
/** Le fasi che il link non l'hanno ancora avuto: sono il bersaglio della query E la
 *  guardia della scrittura della fase (vedi `impostaFaseLancio` con `soloDaFasi`). */
const FASI_BERSAGLIO: readonly LancioFase[] = ['attesa', 'posto_bloccato'];

type Esito = 'sent' | 'riparato' | 'capped' | 'failed' | 'incerto' | 'skip' | 'errore' | 'bloccato';

type Candidata = {
  id: number;
  crm_lead_id: string | null;
  lancio_fase: string | null;
  lancio_info: unknown;
  last_inbound_at: string | null;
  leads: { phone_e164: string | null; first_name: string | null } | null;
};

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  if (req.headers.get('authorization') === `Bearer ${secret}`) return true;
  if (req.nextUrl.searchParams.get('secret') === secret) return true;
  return false;
}

/** `?now=` sposta l'orologio SOLO per la prova generale (B6): l'auth del cron e' gia'
 *  passata quando si arriva qui. */
function orologio(req: NextRequest): Date {
  const forzato = req.nextUrl.searchParams.get('now');
  const t = forzato ? Date.parse(forzato) : NaN;
  return Number.isNaN(t) ? new Date() : new Date(t);
}

/**
 * Il presidio categoria (`UTILITY_ONLY`) ha detto no: nessuna chiamata a Twilio e'
 * partita. Vale identico per ogni conversazione, quindi il run si ferma invece di
 * sbatterci contro duecento volte — e nessuna riga `messages` racconta un invio che non
 * c'e' stato.
 */
function eRifiutoDiPolicy(e: { message?: string; code?: number }): boolean {
  if (typeof e?.code === 'number') return false;
  const m = e?.message ?? '';
  return m.includes('bloccato: categoria') || m.includes('non verificabile');
}

async function logEvento(
  supabase: Supa,
  type: string,
  payload: Record<string, unknown>,
  message: string,
  level: 'info' | 'warn' | 'error' = 'info',
): Promise<void> {
  await supabase.from('event_log').insert({ type, payload: payload as never, message, level });
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return new NextResponse('unauthorized', { status: 401 });

  const supabase = getSupabaseAdmin();
  const settings = await getLancioSettings(supabase);

  // Il run si scrive SEMPRE, anche quando non parte niente: un cron fermo perche' la coda
  // e' vuota e uno fermo perche' e' inceppato, da fuori, si somigliano troppo.
  const scriviRun = (payload: Record<string, unknown>, message: string, level: 'info' | 'warn' | 'error' = 'info') =>
    logEvento(supabase, 'lancio_zoom_run', { attivo: settings.attivo, ...payload }, message, level);

  // Kill-switch dal pannello (ed e' anche quello che il freno spegne): vince su tutto,
  // `forza` compreso, e si esce prima di leggere anche una sola conversazione.
  if (!settings.attivo) {
    await scriviRun(
      { motivo: 'lancio_non_attivo', candidati: 0, inviati: 0, falliti: 0, saltati: 0, residui: null, fermo: null },
      '[lancio] blast Zoom: lancio spento, nessun invio',
    );
    return NextResponse.json({ ok: true, skipped: 'lancio_non_attivo' });
  }

  const configError = async (missing: string[]) => {
    await logEvento(
      supabase,
      'lancio_zoom_config_error',
      { missing },
      `[lancio] blast Zoom saltato: manca ${missing.join(', ')}`,
      'error',
    );
    await scriviRun(
      { motivo: 'config', missing, candidati: 0, inviati: 0, falliti: 0, saltati: 0, residui: null, fermo: 'config' },
      `[lancio] blast Zoom: run saltato per configurazione mancante (${missing.join(', ')})`,
      'error',
    );
    return NextResponse.json({ ok: true, skipped: 'config', missing });
  };

  const eventoMs = settings.eventoAt ? Date.parse(settings.eventoAt) : NaN;
  if (Number.isNaN(eventoMs)) return configError(['lancio_evento_at']);
  const evento = new Date(eventoMs);
  const now = orologio(req);

  // Prova generale: `?forza=1` salta SOLO il filtro della finestra e vale SOLO insieme a
  // `?solo=<conversationId>`. Senza `solo`, un run forzato prima del 5/10 manderebbe il
  // link a tutti i lead in attesa — ed e' un messaggio che non si richiama indietro.
  const forza = req.nextUrl.searchParams.get('forza') === '1';
  const soloRaw = parseInt(req.nextUrl.searchParams.get('solo') ?? '', 10);
  const solo = Number.isFinite(soloRaw) ? soloRaw : null;
  if (forza && solo === null) {
    return NextResponse.json({ ok: false, error: 'forza=1 richiede solo=<conversationId>' }, { status: 400 });
  }

  const sid = process.env.LANCIO_ZOOM_TEMPLATE_SID;
  const from = process.env.TWILIO_WHATSAPP_NUMBER_FENICE;
  const link = settings.zoomLink;
  const perimetro: PerimetroBlast = settings.blastPerimetro;

  // Query dei candidati, uguale per il conteggio e per la lettura: chat del lancio non
  // ancora servite, in una fase che il link non l'ha ancora avuto, mai congedate.
  const bersaglio = (select: string, opzioni?: { head: true; count: 'exact' }, timbrati = false) => {
    let q = supabase
      .from('conversations')
      .select(select, opzioni)
      .not('lancio_slug', 'is', null)
      .in('lancio_fase', FASI_BERSAGLIO);
    // Col timbro ma ancora in una fase da servire: sono gli invii dall'esito incerto —
    // il timbro c'e' (l'abbiamo tenuto apposta), la fase no perche' non sappiamo se il
    // messaggio e' arrivato. Sono invisibili ai residui, e a fine serata sono proprio
    // quelli da guardare a mano.
    q = timbrati ? q.not('lancio_link_inviato_at', 'is', null) : q.is('lancio_link_inviato_at', null);
    q = q
      // Chi si e' tirato indietro non riceve il link, in qualunque fase sia rimasto: il
      // congedo vince sulla fase (la fase puo' essere ferma ad 'attesa' perche' il CRM ha
      // rifiutato lo scarto).
      .is('lancio_info->>congedo_at', null);
    if (perimetro === 'risposto') q = q.not('last_inbound_at', 'is', null);
    if (solo !== null) q = q.eq('id', solo);
    return q;
  };

  // Config PRIMA della finestra: un template o un mittente che mancano devono suonare
  // al primo run fuori finestra — cioe' la sera del 5 alle 19:00, l'ultimo giro prima
  // che la finestra si apra alle 19:30 — e non a blast gia' partito. Il cron gira anche
  // fuori finestra apposta: e' l'unico modo perche' l'allarme arrivi prima della serata
  // invece che durante.
  const missing = [
    !sid && 'LANCIO_ZOOM_TEMPLATE_SID',
    !from && 'TWILIO_WHATSAPP_NUMBER_FENICE',
    !link && 'lancio_zoom_link',
  ].filter((x): x is string => typeof x === 'string');
  if (missing.length > 0 || !sid || !from || !link) return configError(missing);

  if (!forza && !inFinestraBlast(now, evento)) {
    // A serata finita i residui sono definitivi: e' l'unico momento in cui "quanti
    // iscritti non hanno mai ricevuto il link" e' un numero e non una fotografia.
    const chiusa = finestraBlastChiusa(now, evento);
    let residui: number | null = null;
    let incerti: number | null = null;
    if (chiusa) {
      const { count, error } = await bersaglio('id', { head: true, count: 'exact' });
      residui = error ? null : (count ?? 0);
      const { count: cIncerti, error: erroreIncerti } = await bersaglio('id', { head: true, count: 'exact' }, true);
      incerti = erroreIncerti ? null : (cIncerti ?? 0);
    }
    await scriviRun(
      { motivo: 'fuori_finestra', finestraChiusa: chiusa, candidati: 0, inviati: 0, falliti: 0, saltati: 0, residui, incerti, fermo: null },
      chiusa
        ? `[lancio] blast Zoom: finestra chiusa, ${residui ?? '?'} iscritti senza link e ${incerti ?? '?'} senza link certo`
        : '[lancio] blast Zoom: fuori dalla finestra, nessun invio',
      chiusa ? 'warn' : 'info',
    );
    return NextResponse.json({ ok: true, skipped: 'fuori_finestra', finestraChiusa: chiusa, residui, incerti });
  }

  // Mittente (spec §11.1): il secondo client Twilio arriva col task "Mittente
  // secondario". Finche' non c'e', `secondario` non e' eseguibile — e mandare 3.000
  // messaggi dal numero sbagliato in silenzio sarebbe il modo peggiore di scoprirlo.
  if (settings.sender === 'secondario') {
    await logEvento(
      supabase,
      'lancio_sender_secondario_non_disponibile',
      { sender: settings.sender, from },
      '[lancio] blast Zoom: chiesto il mittente secondario, non ancora disponibile — si parte dal principale',
      'warn',
    );
  }

  // ─────────────────────── candidati ───────────────────────
  // Si legge TUTTA la coda e si taglia dopo l'ordinamento: l'ordine per intenzione
  // (`posto_bloccato` → chi ha scritto → chi non ha mai risposto) ha senso solo se il
  // lotto si sceglie sull'intera coda. Tagliando nella query si riordinerebbero 200
  // candidati presi a caso per id.
  const tutti: Candidata[] = [];
  // Il budget dei 240s parte da qui, non dal primo invio: con venti pagine da leggere e
  // un DB lento la coda si legge in minuti, e quel tempo lo toglie a Vercel esattamente
  // come gli invii.
  const t0 = Date.now();
  // Una coda letta a meta' e una coda vuota danno lo stesso numero: il run deve dire
  // quale delle due e' successa, o "0 inviati" a serata finita non si sa interpretare.
  let queryKo = false;
  for (let pagina = 0; pagina < MAX_PAGINE; pagina++) {
    const { data, error } = await bersaglio('id, crm_lead_id, lancio_fase, lancio_info, last_inbound_at, leads(phone_e164, first_name)')
      .order('id', { ascending: true })
      .range(pagina * PAGINA, pagina * PAGINA + PAGINA - 1);
    // Una query fallita torna `data: null`, cioe' zero candidati: senza questa riga il
    // run risponderebbe `sent: 0` identico a una coda vuota. E' proprio il caso della
    // migrazione `lancio_*` non ancora applicata (Postgres 42703).
    if (error) {
      queryKo = true;
      await logCronQueryError(supabase, 'lancio_zoom_query_error', error);
      break;
    }
    const lotto = (data ?? []) as unknown as Candidata[];
    tutti.push(...lotto);
    if (lotto.length < PAGINA) break;
  }

  // Gli stessi filtri della query, ma in memoria: se la migrazione del congedo non fosse
  // applicata, o il filtro JSON cambiasse forma, qui il congedato viene fuori lo stesso.
  const candidati = ordinaCandidatiBlast(tutti.filter((c) => idoneoAlBlast(c, perimetro)));
  const max = batchMax(process.env.LANCIO_BATCH_MAX);
  const lotto = candidati.slice(0, max);

  if (req.nextUrl.searchParams.get('dry') === '1') {
    return NextResponse.json({ ok: true, dry: true, candidati: candidati.length, lotto: lotto.length, max, perimetro });
  }

  // ─────────────────────── seconda idempotenza ───────────────────────
  // Un run morto fra l'invio e la scrittura della fase lascia il messaggio a DB e il
  // timbro indietro: qui si ripara senza rimandare. Le righe `failed`/`undelivered` NON
  // contano — quelle sono proprio i tentativi da rifare.
  const giaSpediti = new Set<number>();
  if (lotto.length > 0) {
    const { data: spediti, error } = await supabase
      .from('messages')
      .select('conversation_id')
      .in('conversation_id', lotto.map((c) => c.id))
      .eq('template_sid', sid)
      .not('twilio_status', 'in', '(failed,undelivered)');
    if (error) await logCronQueryError(supabase, 'lancio_zoom_messages_query_error', error);
    for (const m of (spediti ?? []) as unknown as { conversation_id: number }[]) giaSpediti.add(m.conversation_id);
  }

  const bodyRaw = (await getTemplateBody(sid)) ?? zoomBlastBody('{{1}}', '{{2}}');

  let inviati = 0;
  let riparati = 0;
  let capped = 0;
  let falliti = 0;
  let saltati = 0;
  let errori = 0;
  // Invii dall'esito incerto: Twilio non ha risposto, il timbro e' rimasto e NESSUNO li
  // ritentera'. Contati a parte dagli `errori` (quelli sono invii RIUSCITI che non siamo
  // riusciti a registrare) perche' nel freno pesano come un fallimento: una caduta di
  // rete che fa sbagliare ogni invio non porta nessun codice Twilio, e senza questi il
  // freno guarderebbe un lotto di zeri e direbbe che va tutto bene.
  let incerti = 0;
  // Il freno guarda i TENTATIVI, non gli invii riusciti: un run che sbatte su trenta
  // numeri morti ha comunque fatto trenta chiamate a Twilio, e Meta le ha viste tutte.
  let tentati = 0;
  const codici: (number | string)[] = [];
  let fermo: string | null = null;

  const inviaUno = async (c: Candidata): Promise<Esito> => {
    // Il worker non lascia MAI passare un'eccezione: `runPool` le mette in un
    // `Promise.all`, e una sola farebbe cadere tutto il blocco di invii in corso —
    // compresi quelli gia' partiti su WhatsApp, che nessuno registrerebbe piu'.
    try {
      if (fermo) return 'skip';
      const phone = c.leads?.phone_e164 ?? null;
      if (!phone) return 'skip';

      if (giaSpediti.has(c.id)) {
        // Riparazione: il messaggio era gia' a DB e manca solo la fase. Stessa guardia
        // dell'invio — fra la select e adesso la chat puo' essere andata avanti da sola.
        await impostaFaseLancio(supabase, c.id, 'link_inviato', {
          lancio_link_inviato_at: new Date().toISOString(),
        }, { soloDaFasi: FASI_BERSAGLIO });
        return 'riparato';
      }

      // Il timbro PRIMA dell'invio: se due run si accavallano (il cron gira ogni 5' e un
      // run lento non e' un'ipotesi di scuola), il secondo trova la riga gia' presa e
      // passa oltre. `is('lancio_link_inviato_at', null)` rende l'update un
      // compare-and-set: chi non si riprende righe ha perso la gara.
      const timbro = new Date().toISOString();
      const { data: preso, error: erroreClaim } = await supabase
        .from('conversations')
        .update({ lancio_link_inviato_at: timbro })
        .eq('id', c.id)
        .is('lancio_link_inviato_at', null)
        .select('id');
      // Un claim fallito e uno perso in volata danno lo stesso `data` vuoto, e in
      // entrambi i casi si passa oltre — ma il primo e' il DB in affanno mentre stiamo
      // mandando 3.000 messaggi, e deve lasciare traccia invece di sparire fra i saltati.
      if (erroreClaim) {
        await logEvento(
          supabase,
          'lancio_zoom_claim_error',
          { conversationId: c.id, error: erroreClaim.message },
          `[lancio] conv ${c.id}: timbro non scritto, link non spedito — ${erroreClaim.message}`,
          'error',
        );
        return 'skip';
      }
      if (((preso ?? []) as unknown[]).length === 0) return 'skip';

      // Si libera SOLO il timbro che ha messo questo giro: se nel frattempo un altro run
      // ne ha scritto uno suo, quel timbro protegge un invio che non e' nostro.
      const liberaTimbro = () =>
        supabase
          .from('conversations')
          .update({ lancio_link_inviato_at: null })
          .eq('id', c.id)
          .eq('lancio_link_inviato_at', timbro);

      const vars = { '1': templateName(c.leads?.first_name), '2': link };
      const body = renderBodyTemplate(bodyRaw, vars);
      tentati++;
      let spedito = false;
      try {
        const res = await sendTemplate({ to: phone, contentSid: sid, variables: vars, from });
        // Il messaggio e' su WhatsApp: da qui in poi il timbro non si tocca piu'.
        // Qualunque cosa fallisca dopo non annulla un invio gia' partito, e liberare il
        // timbro rimetterebbe la chat fra i candidati: al run dopo il lead riceverebbe il
        // link una seconda volta.
        spedito = true;
        await supabase.from('messages').insert({
          conversation_id: c.id,
          direction: 'out',
          body,
          twilio_sid: res.sid,
          twilio_status: res.status,
          template_sid: sid,
          template_vars: vars as never,
          is_template: true,
          sender: 'automazione',
        });
        await supabase
          .from('conversations')
          .update({ last_message_at: new Date().toISOString() })
          .eq('id', c.id);
        // Compare-and-set sulla fase, non un update alla cieca: mentre il blast girava,
        // il turno dell'attesa (B1) puo' aver portato questa chat a `posto_bloccato` —
        // o il lead puo' aver gia' premuto il pulsante. Scrivere `link_inviato` sopra
        // una fase piu' avanzata la riporterebbe indietro col link ormai partito. Il
        // timbro invece si scrive comunque: l'invio e' andato e non si ripete.
        await impostaFaseLancio(supabase, c.id, 'link_inviato', { lancio_link_inviato_at: timbro }, { soloDaFasi: FASI_BERSAGLIO });
        return 'sent';
      } catch (err) {
        const e = err as { message?: string; code?: number };
        if (spedito) {
          // L'invio era andato: il guasto e' nostro, dopo Twilio. Si conta come errore e
          // si passa oltre SENZA liberare il timbro.
          await logEvento(
            supabase,
            'lancio_zoom_meta_incompleta',
            { conversationId: c.id, crmLeadId: c.crm_lead_id, error: e?.message ?? 'errore' },
            `[lancio] link Zoom inviato a ${phone} ma la registrazione e' fallita: ${e?.message ?? 'errore'}`,
            'error',
          );
          return 'errore';
        }
        if (eRifiutoDiPolicy(e)) {
          // Non e' un invio fallito: e' il presidio che non ci ha fatto nemmeno chiamare
          // Twilio, e vale identico per tutti. Nessuna riga, nessun tentativo consumato
          // (l'unico caso in cui `tentati` torna indietro), timbro restituito, e il run
          // finisce qui.
          await liberaTimbro();
          tentati--;
          fermo = 'template_bloccato';
          await logEvento(
            supabase,
            'lancio_zoom_config_error',
            { conversationId: c.id, templateSid: sid, error: e?.message ?? 'template non spedibile' },
            `[lancio] blast Zoom bloccato dal presidio template: run fermato — ${e?.message ?? 'template non spedibile'}`,
            'error',
          );
          return 'bloccato';
        }

        if (typeof e?.code !== 'number') {
          // Nessun codice e nessun rifiuto di policy: Twilio non ha risposto (timeout,
          // connessione caduta, abort). Il messaggio PUO' essere partito lo stesso e da
          // qui non c'e' modo di saperlo — quindi il timbro RESTA. Un lead senza link e'
          // un problema che si recupera a mano; un lead con due link sullo stesso numero
          // a qualita' LOW e' danno al mittente, cioe' a tutti gli altri.
          await logEvento(
            supabase,
            'lancio_zoom_esito_incerto',
            { conversationId: c.id, crmLeadId: c.crm_lead_id, error: e?.message ?? 'errore' },
            `[lancio] conv ${c.id}: Twilio non ha risposto, esito dell'invio incerto — timbro tenuto, nessun ritentativo`,
            'warn',
          );
          return 'incerto';
        }

        // Twilio ha risposto con un codice: l'invio non e' partito davvero. Solo qui il
        // timbro va tolto, o la chat non sarebbe piu' candidata e il lead resterebbe
        // senza link per sempre.
        await liberaTimbro();

        if (e.code === 63049) {
          // Frequency cap Meta: e' del DESTINATARIO (quella persona ha gia' ricevuto
          // troppi template in 24h), non del mittente. Quindi non entra nei codici del
          // freno e non fa riga `messages`: si riprova al run dopo.
          await logEvento(
            supabase,
            'lancio_zoom_freq_capped',
            { conversationId: c.id, templateSid: sid },
            `[lancio] frequency cap Meta su conv ${c.id}: link non spedito, ritento al prossimo run`,
          );
          return 'capped';
        }

        codici.push(e.code);

        await logEvento(
          supabase,
          'send_error',
          { conversationId: c.id, crmLeadId: c.crm_lead_id, code: e.code, error: e?.message ?? 'errore' },
          `[lancio] link Zoom fallito per ${phone}: ${e?.message ?? 'errore'}`,
          'error',
        );
        // La riga failed si vede nel pannello e NON conta nell'idempotenza: si riprova.
        await supabase.from('messages').insert({
          conversation_id: c.id,
          direction: 'out',
          body,
          twilio_status: 'failed',
          twilio_error_code: e.code,
          template_sid: sid,
          template_vars: vars as never,
          is_template: true,
          sender: 'automazione',
        });
        return 'failed';
      }
    } catch (err) {
      await logEvento(
        supabase,
        'lancio_zoom_error',
        { conversationId: c.id, error: err instanceof Error ? err.message : 'errore' },
        `[lancio] errore su conv ${c.id}: ${err instanceof Error ? err.message : 'errore'}`,
        'error',
      );
      return 'errore';
    }
  };

  const report: Esito[] = [];
  for (let i = 0; i < lotto.length && !fermo; i += PASSO_FRENO) {
    // Sveglia prima del taglio di Vercel (`maxDuration = 300`): una tempesta su Twilio
    // (retry, timeout) allunga ogni invio, e una funzione uccisa a meta' non scrive il
    // riepilogo — cioe' proprio la riga che serve per sapere dove ripartire. Ci si ferma
    // con un minuto di margine; i residui li prende il run dopo, fra 5 minuti.
    if (Date.now() - t0 > TEMPO_MASSIMO_MS) {
      fermo = 'tempo';
      break;
    }
    const esiti = await runPool(lotto.slice(i, i + PASSO_FRENO), LANCIO_BLAST_CONCURRENCY, inviaUno);
    report.push(...esiti);
    for (const e of esiti) {
      if (e === 'sent') inviati++;
      else if (e === 'riparato') riparati++;
      else if (e === 'capped') capped++;
      else if (e === 'failed') falliti++;
      else if (e === 'incerto') incerti++;
      else if (e === 'errore') errori++;
      else saltati++;
    }
    if (fermo) break;
    if (decideFreno({ tentati, falliti: falliti + incerti, codici }) === 'ferma') {
      fermo = 'freno';
      await logEvento(
        supabase,
        'lancio_zoom_freno',
        { tentati, inviati, falliti, incerti, capped, codici, candidati: candidati.length, lotto: lotto.length },
        `[lancio] FRENO sul blast Zoom: ${falliti + incerti} non arrivati su ${tentati} tentativi (${falliti} falliti, ${incerti} incerti; codici: ${codici.join(', ') || 'nessuno'}). Lancio spento, riaccendere a mano dal pannello.`,
        'error',
      );
      // Il freno spegne il lancio: senza, il run dopo (fra 5 minuti) ricomincerebbe da
      // dove questo si e' fermato, con lo stesso numero nelle stesse condizioni.
      await setLancioSetting(supabase, 'lancio_attivo', false);
    }
  }

  // Quello che il lotto non ha servito: chi e' oltre il tetto e chi e' rimasto dentro il
  // lotto quando il run si e' fermato. Il run dopo li riprende — se il lancio e' ancora
  // acceso.
  const residui = candidati.length - report.length;
  const riepilogo = { candidati: candidati.length, inviati, riparati, capped, falliti, incerti, saltati, errori, residui, fermo };

  await scriviRun(
    { ...riepilogo, tentati, codici, max, perimetro, sender: settings.sender, queryKo },
    `[lancio] blast Zoom: ${inviati} inviati, ${riparati} riparati, ${capped} cap, ${falliti} falliti, ${incerti} incerti, ${saltati} saltati, ${errori} errori, ${residui} residui (su ${candidati.length} candidati)${fermo ? ` — FERMO: ${fermo}` : ''}`,
    fermo || falliti > 0 || incerti > 0 || errori > 0 ? 'warn' : 'info',
  );

  return NextResponse.json({
    ok: true,
    candidati: candidati.length,
    queryKo,
    sent: inviati,
    riparati,
    capped,
    failed: falliti,
    incerti,
    skip: saltati,
    errori,
    residui,
    fermo,
    max,
    perimetro,
    report,
  });
}
