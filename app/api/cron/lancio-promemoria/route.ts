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
  inFinestraPromemoria,
  finestraPromemoriaChiusa,
  scegliLottoPromemoria,
  idoneoAlPromemoria,
  promemoriaBody,
  LANCIO_PROMEMORIA_BATCH_MAX_DEFAULT,
} from '@/lib/lancio-promemoria';
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

// Il promemoria della mattina della live (PO 30/09/2026): template UTILITY
// `fenice_lancio_promemoria_v1` ({{1}} nome) SOLO a chi ha bloccato il posto, dalle 10:00
// alle 12:00 del giorno dell'evento (finestra derivata da `lancio_evento_at`), spalmato a
// lotti ogni 5' come "la live sta iniziando". Stesso motore, stesse difese: timbro
// `lancio_promemoria_inviato_at` preso PRIMA di Twilio, righe `messages` col SID come
// seconda idempotenza, freno, presidio UTILITY_ONLY, stop a 240s. La fase non cambia.

type Candidata = {
  id: number;
  crm_lead_id: string | null;
  wa_number: string | null;
  lancio_slug: string | null;
  lancio_fase: string | null;
  lancio_info: unknown;
  lancio_promemoria_inviato_at: string | null;
  leads: { phone_e164: string | null; first_name: string | null } | null;
};

export async function GET(req: NextRequest) {
  if (!autorizzatoCron(req)) return new NextResponse('unauthorized', { status: 401 });

  const supabase = getSupabaseAdmin();
  const settings = await getLancioSettings(supabase);

  // Il run si scrive SEMPRE: un cron fermo per coda vuota e uno inceppato, da fuori, si
  // somigliano troppo.
  const scriviRun = (payload: Record<string, unknown>, message: string, level: 'info' | 'warn' | 'error' = 'info') =>
    logEvento(supabase, 'lancio_promemoria_run', { attivo: settings.attivo, ...payload }, message, level);

  if (!settings.attivo) {
    await scriviRun(
      { motivo: 'lancio_non_attivo', candidati: 0, inviati: 0, falliti: 0, rimanenti: null, fermo: null },
      '[lancio] promemoria: lancio spento, nessun invio',
    );
    return NextResponse.json({ ok: true, skipped: 'lancio_non_attivo' });
  }

  const configError = async (missing: string[]) => {
    await logEvento(
      supabase,
      'lancio_promemoria_config_error',
      { missing },
      `[lancio] promemoria saltato: manca ${missing.join(', ')}`,
      'error',
    );
    await scriviRun(
      { motivo: 'config', missing, candidati: 0, inviati: 0, falliti: 0, rimanenti: null, fermo: 'config' },
      `[lancio] promemoria: run saltato per configurazione mancante (${missing.join(', ')})`,
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
  await allarmeEventoStantio(supabase, 'lancio-promemoria', now, evento);

  const sid = process.env.LANCIO_PROMEMORIA_TEMPLATE_SID;
  const from = process.env.TWILIO_WHATSAPP_NUMBER_FENICE;

  const missing = [
    !sid && 'LANCIO_PROMEMORIA_TEMPLATE_SID',
    !from && 'TWILIO_WHATSAPP_NUMBER_FENICE',
  ].filter((x): x is string => typeof x === 'string');
  if (missing.length > 0 || !sid || !from) return configError(missing);

  // La coda: chat del lancio a posto bloccato, promemoria non ancora partito, mai
  // congedate. `idoneoAlPromemoria` ripete i filtri in memoria.
  const coda = () => {
    let q = supabase
      .from('conversations')
      .select('id, crm_lead_id, wa_number, lancio_slug, lancio_fase, lancio_info, lancio_promemoria_inviato_at, leads(phone_e164, first_name)')
      .not('lancio_slug', 'is', null)
      .eq('lancio_fase', 'posto_bloccato')
      .is('lancio_promemoria_inviato_at', null)
      .is('lancio_info->>congedo_at', null);
    if (solo !== null) q = q.eq('id', solo);
    return q;
  };

  const leggiTutta = () =>
    leggiCoda<Candidata>(supabase, 'lancio_promemoria_query_error', (da, a) => coda().order('id', { ascending: true }).range(da, a));

  if (!forza && !inFinestraPromemoria(now, evento)) {
    // A finestra chiusa i rimanenti sono definitivi: e' l'unico momento in cui "quanti
    // non l'hanno ricevuto" e' un numero e non una fotografia.
    const chiusa = finestraPromemoriaChiusa(now, evento);
    let rimanenti: number | null = null;
    if (chiusa) {
      const { righe, queryKo } = await leggiTutta();
      rimanenti = queryKo ? null : righe.filter(idoneoAlPromemoria).length;
    }
    await scriviRun(
      { motivo: 'fuori_finestra', finestraChiusa: chiusa, candidati: 0, inviati: 0, falliti: 0, rimanenti, fermo: null },
      chiusa
        ? `[lancio] promemoria: finestra chiusa, ${rimanenti ?? '?'} destinatari senza messaggio`
        : '[lancio] promemoria: fuori dalla finestra, nessun invio',
      chiusa && rimanenti ? 'warn' : 'info',
    );
    return NextResponse.json({ ok: true, skipped: 'fuori_finestra', finestraChiusa: chiusa, rimanenti });
  }

  // Il budget dei 240s parte dalla lettura della coda, non dal primo invio.
  const t0 = Date.now();
  const { righe: tutti, queryKo } = await leggiTutta();
  const max = batchMax(process.env.LANCIO_PROMEMORIA_BATCH_MAX, LANCIO_PROMEMORIA_BATCH_MAX_DEFAULT);
  const scelta = scegliLottoPromemoria(tutti, now, evento, max, forza);
  const { lotto } = scelta;

  if (parametri.dry) {
    return NextResponse.json({
      ok: true, dry: true, queryKo,
      rimanenti: scelta.rimanenti.length,
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
    if (error) await logCronQueryError(supabase, 'lancio_promemoria_messages_query_error', error);
    for (const m of (spediti ?? []) as unknown as { conversation_id: number }[]) giaSpediti.add(m.conversation_id);
  }

  const bodyRaw = (await getTemplateBody(sid)) ?? promemoriaBody('{{1}}');

  const stato = nuovoStatoRun();
  const inviaUno = (c: Candidata): Promise<EsitoInvio> => {
    const phone = c.leads?.phone_e164 ?? null;
    if (stato.fermo || !phone) return Promise.resolve('skip');
    return inviaTemplateTimbrato(supabase, stato, {
      conv: { id: c.id, crm_lead_id: c.crm_lead_id, phone, nome: c.leads?.first_name ?? null, wa_number: c.wa_number },
      colonna: 'lancio_promemoria_inviato_at',
      sid,
      // Il numero della CHAT: mandarlo dall'altro spezzerebbe il thread. Se il template
      // non e' spedibile da li' (copia assente o non UTILITY sull'account 2) il motore
      // ripiega sul numero storico e scrive `lancio_mittente_ripiego`.
      from: mittenteDiConversazione(c) ?? from,
      costruisci: (conv) => {
        const vars = { '1': templateName(conv.nome) };
        return { vars, body: renderBodyTemplate(bodyRaw, vars) };
      },
      giaSpedito: giaSpediti.has(c.id),
      prefisso: 'lancio_promemoria',
      etichetta: 'promemoria',
    });
  };

  const conti = await eseguiLotti(lotto, stato, {
    concorrenza: LANCIO_BLAST_CONCURRENCY,
    t0,
    inviaUno,
    suFreno: (s, c) =>
      frenaLancio(supabase, s, c, {
        prefisso: 'lancio_promemoria',
        etichetta: 'promemoria della live',
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
    candidati: scelta.rimanenti.length,
    run: scelta.run, quota: scelta.quota, lotto: lotto.length,
    inviati, riparati, capped, falliti, incerti, saltati, errori, rimanenti, fermo,
  };

  await scriviRun(
    { ...riepilogo, tentati, codici, max, queryKo, forza },
    `[lancio] promemoria: ${inviati} inviati, ${falliti} falliti, ${capped} cap, ${incerti} incerti, ${saltati} saltati, ${errori} errori — ${rimanenti} rimanenti su ${scelta.run} run (lotto ${lotto.length}/${scelta.rimanenti.length})${fermo ? ` — FERMO: ${fermo}` : ''}`,
    fermo || falliti > 0 || incerti > 0 || errori > 0 || queryKo ? 'warn' : 'info',
  );

  return NextResponse.json({ ok: true, queryKo, ...riepilogo, tentati, max });
}
