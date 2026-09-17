import { NextRequest, NextResponse } from 'next/server';
import { mittenteDiConversazione } from '@/lib/mittente';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { getTemplateBody } from '@/lib/twilio';
import { renderBodyTemplate } from '@/lib/campaigns';
import { templateName } from '@/lib/name';
import { getLancioSettings } from '@/lib/lancio-settings';
import type { LancioFase } from '@/lib/lancio-fase';
import { logCronQueryError } from '@/lib/cron-query-error';
import {
  inFinestraBlast,
  finestraBlastChiusa,
  zoomBlastBody,
  batchMax,
  idoneoAlBlast,
  ordinaCandidatiBlast,
  LANCIO_BLAST_CONCURRENCY,
  type PerimetroBlast,
} from '@/lib/lancio-zoom-blast';
// Il timbro, il freno, il 63049 e l'esito incerto stanno nel motore condiviso col
// follow-up del 6 (B5): qui restano la finestra, la scelta dei candidati e il riepilogo.
import {
  autorizzatoCron,
  leggiParametriCron,
  logEvento,
  leggiCoda,
  nuovoStatoRun,
  inviaTemplateTimbrato,
  eseguiLotti,
  frenaLancio,
  type EsitoInvio,
} from '@/lib/lancio-blast-motore';

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
//     al primo 63018/63051) il run si ferma E spegne `lancio_attivo`, cosi' anche i run
//     successivi restano fermi finche' un admin non riaccende dal pannello. Il 63049 NON
//     e' un codice del freno: e' il cap del destinatario, si conta come mancato invio e
//     il blast tira dritto.
//  3. PERIMETRO. `lancio_blast_perimetro` restringe il bersaglio a chi ha risposto almeno
//     una volta (piano B della spec §11), senza deploy.

/** Le fasi che il link non l'hanno ancora avuto: sono il bersaglio della query E la
 *  guardia della scrittura della fase (vedi `impostaFaseLancio` con `soloDaFasi`). */
const FASI_BERSAGLIO: readonly LancioFase[] = ['attesa', 'posto_bloccato'];

type Candidata = {
  id: number;
  crm_lead_id: string | null;
  wa_number: string | null;
  lancio_fase: string | null;
  lancio_info: unknown;
  last_inbound_at: string | null;
  leads: { phone_e164: string | null; first_name: string | null } | null;
};

export async function GET(req: NextRequest) {
  if (!autorizzatoCron(req)) return new NextResponse('unauthorized', { status: 401 });

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
  // Orologio (`?now=`) e prova generale (`?forza=1`, che salta SOLO il filtro della
  // finestra e vale SOLO insieme a `?solo=<conversationId>`: senza, un run forzato prima
  // del 5/10 manderebbe il link a tutti i lead in attesa).
  const parametri = leggiParametriCron(req, { nowRichiedeSolo: false });
  if (!parametri.ok) return NextResponse.json({ ok: false, error: parametri.errore }, { status: 400 });
  const { now, forza, solo } = parametri;

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
  // Il budget dei 240s parte da qui, non dal primo invio: con venti pagine da leggere e
  // un DB lento la coda si legge in minuti, e quel tempo lo toglie a Vercel esattamente
  // come gli invii.
  const t0 = Date.now();
  // Una coda letta a meta' e una coda vuota danno lo stesso numero: `queryKo` dice quale
  // delle due e' successa, o "0 inviati" a serata finita non si sa interpretare.
  const { righe: tutti, queryKo } = await leggiCoda<Candidata>(supabase, 'lancio_zoom_query_error', (da, a) =>
    bersaglio('id, crm_lead_id, wa_number, lancio_fase, lancio_info, last_inbound_at, leads(phone_e164, first_name)')
      .order('id', { ascending: true })
      .range(da, a),
  );

  // Gli stessi filtri della query, ma in memoria: se la migrazione del congedo non fosse
  // applicata, o il filtro JSON cambiasse forma, qui il congedato viene fuori lo stesso.
  const candidati = ordinaCandidatiBlast(tutti.filter((c) => idoneoAlBlast(c, perimetro)));
  const max = batchMax(process.env.LANCIO_BATCH_MAX);
  const lotto = candidati.slice(0, max);

  if (parametri.dry) {
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

  // Da qui in giu' il lavoro e' del motore condiviso (`lib/lancio-blast-motore.ts`):
  // timbro prima di Twilio, riparazione, 63049, esito incerto, freno e sveglia dei 240s.
  // Qui resta solo COSA si manda: le due variabili del template e la fase di arrivo.
  const stato = nuovoStatoRun();
  const inviaUno = (c: Candidata): Promise<EsitoInvio> => {
    const phone = c.leads?.phone_e164 ?? null;
    if (stato.fermo || !phone) return Promise.resolve('skip');
    return inviaTemplateTimbrato(supabase, stato, {
      conv: { id: c.id, crm_lead_id: c.crm_lead_id, phone, nome: c.leads?.first_name ?? null, wa_number: c.wa_number },
      colonna: 'lancio_link_inviato_at',
      faseDopo: 'link_inviato',
      sid,
      // Il numero della CHAT, non quello del run: dal 17/09 le conversazioni
      // possono nascere sul secondo numero, e mandare il link del lancio
      // dall'altro la spezzerebbe in due thread chiudendo la finestra 24h.
      from: mittenteDiConversazione(c) ?? from,
      // Le due variabili del template ({{1}} nome, {{2}} link) e il corpo reso. Le
      // costruisce il motore, dentro il suo try/catch: un nome che facesse saltare il
      // render sarebbe un destinatario saltato, non il blocco di 25 perso.
      costruisci: (conv) => {
        const vars = { '1': templateName(conv.nome), '2': link };
        return { vars, body: renderBodyTemplate(bodyRaw, vars) };
      },
      giaSpedito: giaSpediti.has(c.id),
      // La guardia contro il turno concorrente (B1, il pulsante del webinar): la fase
      // avanza a `link_inviato` solo da una fase che il link non l'ha ancora avuto.
      soloDaFasi: FASI_BERSAGLIO,
      prefisso: 'lancio_zoom',
      etichetta: 'link Zoom',
    });
  };

  const conti = await eseguiLotti(lotto, stato, {
    concorrenza: LANCIO_BLAST_CONCURRENCY,
    t0,
    inviaUno,
    suFreno: (s, c) =>
      frenaLancio(supabase, s, c, {
        prefisso: 'lancio_zoom',
        etichetta: 'blast Zoom',
        candidati: candidati.length,
        lotto: lotto.length,
      }),
  });
  const { inviati, riparati, capped, falliti, incerti, saltati, errori, report } = conti;
  const { tentati, codici, fermo } = stato;

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
