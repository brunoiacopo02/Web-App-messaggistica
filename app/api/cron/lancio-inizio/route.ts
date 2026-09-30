import { NextRequest, NextResponse } from 'next/server';
import { mittenteDiConversazione } from '@/lib/mittente';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { getTemplateBody } from '@/lib/twilio';
import { renderBodyTemplate } from '@/lib/campaigns';
import { templateName } from '@/lib/name';
import { getLancioSettings } from '@/lib/lancio-settings';
import { logCronQueryError } from '@/lib/cron-query-error';
import { batchMax, LANCIO_BLAST_CONCURRENCY } from '@/lib/lancio-zoom-blast';
import {
  inFinestraInizio,
  finestraInizioChiusa,
  scegliLottoInizio,
  idoneoAllInizio,
  inizioBody,
  FASI_INIZIO,
  LANCIO_INIZIO_BATCH_MAX_DEFAULT,
} from '@/lib/lancio-inizio';
import {
  autorizzatoCron,
  leggiParametriCron,
  logEvento,
  leggiCoda,
  allarmeEventoStantio,
  nuovoStatoRun,
  inviaTemplateTimbrato,
  eseguiLotti,
  frenaLancio,
  type EsitoInvio,
} from '@/lib/lancio-blast-motore';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// "La live sta iniziando" (decisione PO 5 del 25/09/2026): template UTILITY
// `fenice_lancio_inizio_v1` ({{1}} nome, {{2}} link Zoom) a chi ha scritto almeno una
// volta DOPO il benvenuto e non si e' congedato, dalle 20:30 alle 21:30 del giorno
// dell'evento (finestra derivata da `lancio_evento_at`, ±30').
//
// Spalmato: ogni run (ogni 5') manda i rimanenti divisi per i run che restano, per
// eccesso, dentro al tetto `LANCIO_INIZIO_BATCH_MAX` (300). Cosi' 1.000 destinatari
// diventano ~77 invii ogni 5 minuti invece di un'ondata alle 20:30 — il numero e' a
// qualita' LOW e le ondate sono quello che Meta punisce.
//
// Le difese sono quelle del blast Zoom, perche' il motore e' lo stesso
// (`lib/lancio-blast-motore.ts`): timbro `lancio_inizio_inviato_at` preso con un
// compare-and-set PRIMA di Twilio, righe `messages` col SID come seconda idempotenza,
// freno al 10% di fallimenti o al primo 63018/63051 (spegne `lancio_attivo`), presidio
// UTILITY_ONLY dentro `sendTemplate`, stop a 240s. A differenza del blast, la fase NON
// cambia: il messaggio e' un promemoria, non un passo del percorso.

type Candidata = {
  id: number;
  crm_lead_id: string | null;
  wa_number: string | null;
  lancio_slug: string | null;
  lancio_fase: string | null;
  lancio_info: unknown;
  lancio_benvenuto_at: string | null;
  last_inbound_at: string | null;
  lancio_link_inviato_at: string | null;
  lancio_inizio_inviato_at: string | null;
  leads: { phone_e164: string | null; first_name: string | null } | null;
};

export async function GET(req: NextRequest) {
  if (!autorizzatoCron(req)) return new NextResponse('unauthorized', { status: 401 });

  const supabase = getSupabaseAdmin();
  const settings = await getLancioSettings(supabase);

  // Il run si scrive SEMPRE: un cron fermo per coda vuota e uno inceppato, da fuori, si
  // somigliano troppo.
  const scriviRun = (payload: Record<string, unknown>, message: string, level: 'info' | 'warn' | 'error' = 'info') =>
    logEvento(supabase, 'lancio_inizio_run', { attivo: settings.attivo, ...payload }, message, level);

  if (!settings.attivo) {
    await scriviRun(
      { motivo: 'lancio_non_attivo', candidati: 0, inviati: 0, falliti: 0, rimanenti: null, fermo: null },
      '[lancio] inizio live: lancio spento, nessun invio',
    );
    return NextResponse.json({ ok: true, skipped: 'lancio_non_attivo' });
  }

  const configError = async (missing: string[]) => {
    await logEvento(
      supabase,
      'lancio_inizio_config_error',
      { missing },
      `[lancio] inizio live saltato: manca ${missing.join(', ')}`,
      'error',
    );
    await scriviRun(
      { motivo: 'config', missing, candidati: 0, inviati: 0, falliti: 0, rimanenti: null, fermo: 'config' },
      `[lancio] inizio live: run saltato per configurazione mancante (${missing.join(', ')})`,
      'error',
    );
    return NextResponse.json({ ok: true, skipped: 'config', missing });
  };

  const eventoMs = settings.eventoAt ? Date.parse(settings.eventoAt) : NaN;
  if (Number.isNaN(eventoMs)) return configError(['lancio_evento_at']);
  const evento = new Date(eventoMs);
  // Prova generale: `forza=1` vale solo con `solo=<conversationId>`; `now=<iso>` pure,
  // perche' spostare l'orologio sull'intera coda vorrebbe dire mandare a tutti.
  const parametri = leggiParametriCron(req, { nowRichiedeSolo: true });
  if (!parametri.ok) return NextResponse.json({ ok: false, error: parametri.errore }, { status: 400 });
  const { now, forza, solo } = parametri;
  await allarmeEventoStantio(supabase, 'lancio-inizio', now, evento);

  const sid = process.env.LANCIO_INIZIO_TEMPLATE_SID;
  const from = process.env.TWILIO_WHATSAPP_NUMBER_FENICE;
  const link = settings.zoomLink;

  // Config PRIMA della finestra: il cron gira dalle 20:00 (vercel.json, ore 18-19 UTC),
  // cosi' un SID mancante suona mezz'ora prima che la finestra si apra.
  const missing = [
    !sid && 'LANCIO_INIZIO_TEMPLATE_SID',
    !from && 'TWILIO_WHATSAPP_NUMBER_FENICE',
    !link && 'lancio_zoom_link',
  ].filter((x): x is string => typeof x === 'string');
  if (missing.length > 0 || !sid || !from || !link) return configError(missing);

  // La coda: chat del lancio nelle fasi a cui si manda, non ancora servite, mai
  // congedate, con benvenuto e almeno un inbound. Il confronto "inbound DOPO il
  // benvenuto" fra due colonne PostgREST non lo sa fare: lo fa `idoneoAllInizio` in
  // memoria, insieme agli stessi filtri (se il filtro JSON del congedo cambiasse forma,
  // il congedato verrebbe fuori lo stesso).
  const coda = () => {
    let q = supabase
      .from('conversations')
      .select(
        'id, crm_lead_id, wa_number, lancio_slug, lancio_fase, lancio_info, lancio_benvenuto_at, last_inbound_at, lancio_link_inviato_at, lancio_inizio_inviato_at, leads(phone_e164, first_name)',
      )
      .not('lancio_slug', 'is', null)
      .in('lancio_fase', FASI_INIZIO as string[])
      .is('lancio_inizio_inviato_at', null)
      .is('lancio_info->>congedo_at', null)
      .not('lancio_benvenuto_at', 'is', null)
      .not('last_inbound_at', 'is', null);
    if (solo !== null) q = q.eq('id', solo);
    return q;
  };

  const leggiTutta = () =>
    leggiCoda<Candidata>(supabase, 'lancio_inizio_query_error', (da, a) => coda().order('id', { ascending: true }).range(da, a));

  if (!forza && !inFinestraInizio(now, evento)) {
    // A finestra chiusa i rimanenti sono definitivi: e' l'unico momento in cui "quanti
    // non l'hanno ricevuto" e' un numero e non una fotografia.
    const chiusa = finestraInizioChiusa(now, evento);
    let rimanenti: number | null = null;
    if (chiusa) {
      const { righe, queryKo } = await leggiTutta();
      rimanenti = queryKo ? null : righe.filter(idoneoAllInizio).length;
    }
    await scriviRun(
      { motivo: 'fuori_finestra', finestraChiusa: chiusa, candidati: 0, inviati: 0, falliti: 0, rimanenti, fermo: null },
      chiusa
        ? `[lancio] inizio live: finestra chiusa, ${rimanenti ?? '?'} destinatari senza messaggio`
        : '[lancio] inizio live: fuori dalla finestra, nessun invio',
      chiusa && rimanenti ? 'warn' : 'info',
    );
    return NextResponse.json({ ok: true, skipped: 'fuori_finestra', finestraChiusa: chiusa, rimanenti });
  }

  // Il budget dei 240s parte dalla lettura della coda, non dal primo invio.
  const t0 = Date.now();
  const { righe: tutti, queryKo } = await leggiTutta();
  const max = batchMax(process.env.LANCIO_INIZIO_BATCH_MAX, LANCIO_INIZIO_BATCH_MAX_DEFAULT);
  const scelta = scegliLottoInizio(tutti, now, evento, max, forza);
  const { lotto } = scelta;

  if (parametri.dry) {
    return NextResponse.json({
      ok: true, dry: true, queryKo,
      rimanenti: scelta.rimanenti.length, pronti: scelta.pronti.length, rimandati: scelta.rimandati,
      run: scelta.run, quota: scelta.quota, lotto: lotto.length, max,
    });
  }

  // Seconda idempotenza: un run morto fra l'invio e la scrittura lascia il messaggio a
  // DB. Le righe failed/undelivered non contano: sono proprio i tentativi da rifare.
  const giaSpediti = new Set<number>();
  if (lotto.length > 0) {
    const { data: spediti, error } = await supabase
      .from('messages')
      .select('conversation_id')
      .in('conversation_id', lotto.map((c) => c.id))
      .eq('template_sid', sid)
      .not('twilio_status', 'in', '(failed,undelivered)');
    if (error) await logCronQueryError(supabase, 'lancio_inizio_messages_query_error', error);
    for (const m of (spediti ?? []) as unknown as { conversation_id: number }[]) giaSpediti.add(m.conversation_id);
  }

  const bodyRaw = (await getTemplateBody(sid)) ?? inizioBody('{{1}}', '{{2}}');

  const stato = nuovoStatoRun();
  const inviaUno = (c: Candidata): Promise<EsitoInvio> => {
    const phone = c.leads?.phone_e164 ?? null;
    if (stato.fermo || !phone) return Promise.resolve('skip');
    return inviaTemplateTimbrato(supabase, stato, {
      conv: { id: c.id, crm_lead_id: c.crm_lead_id, phone, nome: c.leads?.first_name ?? null, wa_number: c.wa_number },
      colonna: 'lancio_inizio_inviato_at',
      // Nessuna `faseDopo`: il promemoria non sposta la chat nel percorso del lancio.
      sid,
      // Il numero della CHAT: mandarlo dall'altro spezzerebbe il thread. Se il template
      // non e' spedibile da li' (copia assente o non UTILITY sull'account 2) il motore
      // ripiega sul numero storico e scrive `lancio_mittente_ripiego`.
      from: mittenteDiConversazione(c) ?? from,
      costruisci: (conv) => {
        const vars = { '1': templateName(conv.nome), '2': link };
        return { vars, body: renderBodyTemplate(bodyRaw, vars) };
      },
      giaSpedito: giaSpediti.has(c.id),
      prefisso: 'lancio_inizio',
      etichetta: 'inizio live',
    });
  };

  const conti = await eseguiLotti(lotto, stato, {
    concorrenza: LANCIO_BLAST_CONCURRENCY,
    t0,
    inviaUno,
    suFreno: (s, c) =>
      frenaLancio(supabase, s, c, {
        prefisso: 'lancio_inizio',
        etichetta: 'messaggio di inizio live',
        candidati: scelta.rimanenti.length,
        lotto: lotto.length,
      }),
  });
  const { inviati, riparati, capped, falliti, incerti, saltati, errori } = conti;
  const { tentati, codici, fermo } = stato;

  // Chi resta per i run successivi: tutti i rimanenti meno chi in questo run e' uscito
  // dalla coda (inviato, riparato, o incerto — il timbro degli incerti resta e li toglie).
  const usciti = inviati + riparati + incerti;
  const rimanenti = Math.max(0, scelta.rimanenti.length - usciti);
  const riepilogo = {
    candidati: scelta.rimanenti.length, pronti: scelta.pronti.length, rimandati: scelta.rimandati,
    run: scelta.run, quota: scelta.quota, lotto: lotto.length,
    inviati, riparati, capped, falliti, incerti, saltati, errori, rimanenti, fermo,
  };

  await scriviRun(
    { ...riepilogo, tentati, codici, max, queryKo, forza },
    `[lancio] inizio live: ${inviati} inviati, ${falliti} falliti, ${capped} cap, ${incerti} incerti, ${saltati} saltati, ${errori} errori — ${rimanenti} rimanenti su ${scelta.run} run (lotto ${lotto.length}/${scelta.rimanenti.length})${fermo ? ` — FERMO: ${fermo}` : ''}`,
    fermo || falliti > 0 || incerti > 0 || errori > 0 || queryKo ? 'warn' : 'info',
  );

  return NextResponse.json({ ok: true, queryKo, ...riepilogo, tentati, max });
}
