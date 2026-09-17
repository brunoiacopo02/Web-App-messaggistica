import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { getTemplateBody } from '@/lib/twilio';
import { renderBodyTemplate } from '@/lib/campaigns';
import { templateName } from '@/lib/name';
import { getLancioSettings } from '@/lib/lancio-settings';
import { fineNotteLancio } from '@/lib/lancio-scelta';
import { marcaCongedo, leggiIngressoLancioAt } from '@/lib/lancio-db';
import { congedoLancio } from '@/lib/lancio-effetti';
import { logCronQueryError } from '@/lib/cron-query-error';
import { batchMax, LANCIO_BLAST_CONCURRENCY } from '@/lib/lancio-zoom-blast';
import type { RigaLancio } from '@/lib/lancio-fase';
import {
  FASI_FOLLOWUP,
  inFinestraFollowup,
  finestraFollowupChiusa,
  ancoraLancio,
  decideFollowup,
  lancioFollowupText,
  NOTA_CONGEDO_FOLLOWUP,
  type MotivoSalto,
} from '@/lib/lancio-followup';
// Timbro, freno, 63049, esito incerto e sveglia dei 240s stanno nel motore condiviso col
// blast Zoom (B4): qui restano la finestra, la scelta dei bersagli e il riepilogo.
import {
  autorizzatoCron,
  leggiParametriCron,
  logEvento,
  leggiCoda,
  nuovoStatoRun,
  inviaTemplateTimbrato,
  eseguiLotti,
  frenaLancio,
  TEMPO_MASSIMO_MS,
  type EsitoInvio,
} from '@/lib/lancio-blast-motore';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// Follow-up del giorno dopo la live (spec §5.5): ogni 5' nelle fasce 12:00-14:00 e
// 17:30-19:30 di Roma del giorno dopo l'evento e di dopodomani, a lotti di
// LANCIO_BATCH_MAX (200), a chi ha interagito dopo il benvenuto e non ha scelto.
// Mai a chi si e' congedato (C4), mai a chi ha appena detto di no (C1: si congeda senza
// bolla). Stesso motore del blast Zoom: timbro `lancio_followup_inviato_at` PRIMA di
// Twilio, 63049 = capped, esito incerto = timbro tenuto, freno che spegne il lancio.
//
// Il silenzio non e' mai muto (C7): se `lancio_attivo` e' spento — per esempio dal freno
// della sera del blast — dentro la finestra ogni run scrive un warn `lancio_followup_fermo`
// invece di uscire in punta di piedi. Riaccendere e' un gesto umano dal pannello.

type Supa = ReturnType<typeof getSupabaseAdmin>;

type Candidata = {
  id: number;
  crm_lead_id: string | null;
  lancio_fase: string | null;
  lancio_info: unknown;
  lancio_benvenuto_at: string | null;
  lancio_followup_inviato_at: string | null;
  last_inbound_at: string | null;
  leads: { phone_e164: string | null; first_name: string | null } | null;
};
type RigaMessaggio = RigaLancio & { conversation_id: number };

/** Quante candidate si valutano per giro: una sola query `messages` per blocco. */
const BLOCCO_VALUTAZIONE = 200;
const MAX_RIGHE_BLOCCO = BLOCCO_VALUTAZIONE * 40;
/**
 * Quanto indietro si legge la cronologia: `lancio_evento_at` meno 30 giorni. Le chat
 * RIUSATE si portano dietro tutto il giro di Mario (mesi di messaggi), ma l'ancora del
 * lancio e' sempre dopo il 14/09 — benvenuto o `lancio_intake` — quindi niente di utile
 * vive prima di questo taglio. Senza, un blocco di chat riusate sfonda il tetto delle
 * righe e il troncamento si porta via proprio le righe NUOVE (l'ordine e' crescente).
 */
const GIORNI_STORICO = 30;
/**
 * Letture dell'evento `lancio_intake` per run (le chat riusate, senza benvenuto in
 * cronologia ne' colonna): oltre questo tetto quelle chat contano `ancora_ignota` adesso
 * e si rivalutano al run dopo, cinque minuti dopo. E' una `maybeSingle` a chat: in
 * sequenza su un blocco patologico si mangerebbe il budget dei 240s.
 */
const MAX_LETTURE_INTAKE = 50;

/**
 * Il marcatore su `lancio_info` delle chat che l'ancora non ce l'hanno proprio: ne'
 * benvenuto, ne' colonna, ne' evento `lancio_intake`. Senza, quelle chat tornerebbero
 * prime in coda (id bassi) a ogni run e si mangerebbero le 50 letture dell'intake per
 * tutta la finestra, affamando le chat che l'ancora invece ce l'hanno. Restano candidate
 * — entrano nei residui e nella restituzione al pool del Task 5 — ma non costano piu'
 * una lettura.
 */
const CHIAVE_ANCORA_IGNOTA = 'followup_ancora_ignota_at';

const ancoraIgnotaMarcata = (info: unknown): boolean => {
  if (!info || typeof info !== 'object' || Array.isArray(info)) return false;
  const v = (info as Record<string, unknown>)[CHIAVE_ANCORA_IGNOTA];
  return typeof v === 'string' && v.trim() !== '';
};

/**
 * Scrive il marcatore con un merge su quello che c'e' gia': `lancio_info` porta il
 * congedo (C4) e le risposte di riscaldamento di B4, e un update alla cieca le
 * cancellerebbe. Stessa regola di `marcaCongedo`: se la lettura fallisce NON si scrive —
 * un marcatore in piu' non vale la perdita di quello che c'era.
 */
async function marcaAncoraIgnota(supabase: Supa, conversationId: number): Promise<void> {
  const { data, error: erroreLettura } = await supabase
    .from('conversations')
    .select('lancio_info')
    .eq('id', conversationId)
    .maybeSingle();
  if (erroreLettura) {
    await logEvento(supabase, 'lancio_followup_ancora_non_marcata',
      { conversationId, errore: erroreLettura.message, fase: 'lettura' },
      `[lancio] conv ${conversationId}: lancio_info non letto, ancora ignota NON marcata — ${erroreLettura.message}`, 'warn');
    return;
  }
  const attuale = (data as { lancio_info?: unknown } | null)?.lancio_info;
  const base = attuale && typeof attuale === 'object' && !Array.isArray(attuale) ? (attuale as Record<string, unknown>) : {};
  const { error } = await supabase
    .from('conversations')
    .update({ lancio_info: { ...base, [CHIAVE_ANCORA_IGNOTA]: new Date().toISOString() } as never })
    .eq('id', conversationId);
  if (error) {
    await logEvento(supabase, 'lancio_followup_ancora_non_marcata',
      { conversationId, errore: error.message, fase: 'scrittura' },
      `[lancio] conv ${conversationId}: ancora ignota NON marcata — ${error.message}`, 'warn');
  }
}

/** I motivi di `decideFollowup` piu' quello che nasce qui: da congedare ma senza numero. */
type MotivoSaltoRoute = MotivoSalto | 'senza_telefono';

const contatoreSalti = (): Record<MotivoSaltoRoute, number> => ({
  fase: 0,
  gia_inviato: 0,
  congedato: 0,
  ancora_ignota: 0,
  mai_scritto: 0,
  in_scelta: 0,
  senza_telefono: 0,
});

export async function GET(req: NextRequest) {
  if (!autorizzatoCron(req)) return new NextResponse('unauthorized', { status: 401 });

  const supabase: Supa = getSupabaseAdmin();
  const settings = await getLancioSettings(supabase);

  // Il run si scrive SEMPRE, anche quando non parte niente: un cron fermo perche' la coda
  // e' vuota e uno fermo perche' e' inceppato, da fuori, si somigliano troppo.
  const scriviRun = (payload: Record<string, unknown>, message: string, level: 'info' | 'warn' | 'error' = 'info') =>
    logEvento(supabase, 'lancio_followup_run', { attivo: settings.attivo, ...payload }, message, level);

  // `forza=1` salta SOLO il filtro della finestra e `now=` sposta l'orologio: qui valgono
  // entrambi solo con `solo=<conversationId>` (`nowRichiedeSolo`), perche' un run forzato
  // fuori data manderebbe il template a tutta la coda.
  const parametri = leggiParametriCron(req, { nowRichiedeSolo: true });
  if (!parametri.ok) return NextResponse.json({ ok: false, error: parametri.errore }, { status: 400 });
  const { now, forza, solo, dry } = parametri;

  const configError = async (missing: string[]) => {
    await logEvento(supabase, 'lancio_followup_config_error', { missing },
      `[lancio] follow-up saltato: manca ${missing.join(', ')}`, 'error');
    await scriviRun({ motivo: 'config', missing, candidati: 0, inviati: 0 },
      `[lancio] follow-up: run saltato per configurazione mancante (${missing.join(', ')})`, 'error');
    return NextResponse.json({ ok: true, skipped: 'config', missing });
  };

  const eventoMs = settings.eventoAt ? Date.parse(settings.eventoAt) : NaN;
  if (Number.isNaN(eventoMs)) return configError(['lancio_evento_at']);
  const evento = new Date(eventoMs);
  // Le 03:00 di Roma del 6: da li' in poi un `post_pitch` che scrive sta scegliendo, e il
  // follow-up non lo interrompe (`decideFollowup`, motivo `in_scelta`).
  const fineNotte = fineNotteLancio(evento);
  // Il fondo della cronologia da leggere: tutte le ancore del lancio stanno dopo.
  const tagliaStorico = new Date(eventoMs - GIORNI_STORICO * 24 * 60 * 60 * 1000).toISOString();

  // Config PRIMA della finestra, come nel blast Zoom: un template o un mittente che
  // mancano devono suonare al run fuori fascia del 6 mattina, non a follow-up iniziato.
  const sid = process.env.LANCIO_FOLLOWUP_TEMPLATE_SID;
  const from = process.env.TWILIO_WHATSAPP_NUMBER_FENICE;
  const welcomeSid = process.env.LANCIO_WELCOME_TEMPLATE_SID || null;
  const missing = [
    !sid && 'LANCIO_FOLLOWUP_TEMPLATE_SID',
    !from && 'TWILIO_WHATSAPP_NUMBER_FENICE',
  ].filter((x): x is string => typeof x === 'string');
  if (missing.length > 0 || !sid || !from) return configError(missing);

  // Query dei candidati, uguale per il conteggio dei residui e per la lettura della coda.
  const bersaglio = (select: string, opzioni?: { head: true; count: 'exact' }) => {
    let q = supabase
      .from('conversations')
      .select(select, opzioni)
      .not('lancio_slug', 'is', null)
      .in('lancio_fase', [...FASI_FOLLOWUP])
      .is('lancio_followup_inviato_at', null)
      // Il congedo vince sulla fase (C4): chi si e' tirato indietro non riceve niente,
      // anche se la fase e' rimasta indietro perche' il CRM ha rifiutato lo scarto.
      .is('lancio_info->>congedo_at', null)
      // Pre-filtro economico: chi non ha MAI scritto non e' un bersaglio. La regola vera
      // (un inbound DOPO l'ancora del lancio) si applica sulle righe, piu' sotto.
      .not('last_inbound_at', 'is', null)
      // Chat in mano a una persona: un template di marketing sopra sarebbe una seconda voce.
      .is('ai_paused_at', null)
      .is('handed_off_at', null);
    if (solo !== null) q = q.eq('id', solo);
    return q;
  };

  if (!forza && !inFinestraFollowup(now, evento)) {
    // A finestra chiusa i residui sono definitivi: e' l'unico momento in cui "quanti
    // hanno interagito e non hanno avuto il follow-up" e' un numero e non una fotografia.
    const chiusa = finestraFollowupChiusa(now, evento);
    let residui: number | null = null;
    if (chiusa) {
      const { count, error } = await bersaglio('id', { head: true, count: 'exact' });
      residui = error ? null : (count ?? 0);
    }
    await scriviRun(
      { motivo: 'fuori_finestra', finestraChiusa: chiusa, candidati: 0, inviati: 0, residui },
      chiusa
        ? `[lancio] follow-up: finestra chiusa, ${residui ?? '?'} chat candidate senza follow-up`
        : '[lancio] follow-up: fuori dalla finestra, nessun invio',
      chiusa ? 'warn' : 'info',
    );
    return NextResponse.json({ ok: true, skipped: 'fuori_finestra', finestraChiusa: chiusa, residui });
  }

  // C7: il freno della sera prima spegne `lancio_attivo`, e questo cron non manderebbe
  // nulla in silenzio per due giorni. Dentro la finestra il silenzio si dichiara a ogni
  // run, a livello warn: la riaccensione e' un gesto umano dal pannello (runbook B6).
  if (!settings.attivo) {
    await logEvento(supabase, 'lancio_followup_fermo', { motivo: 'lancio_attivo_spento', now: now.toISOString() },
      "[lancio] follow-up FERMO: lancio_attivo e' spento dentro la finestra del follow-up. Riaccendere dal pannello /fenice/impostazioni se il freno della sera prima e' stato capito.",
      'warn');
    await scriviRun({ motivo: 'lancio_non_attivo', candidati: 0, inviati: 0 }, '[lancio] follow-up: lancio spento, nessun invio');
    return NextResponse.json({ ok: true, skipped: 'lancio_non_attivo' });
  }

  // Mittente (spec §11.1): il secondo client Twilio non c'e' ancora. Mandare migliaia di
  // messaggi dal numero sbagliato in silenzio sarebbe il modo peggiore di scoprirlo.
  if (settings.sender === 'secondario') {
    await logEvento(supabase, 'lancio_sender_secondario_non_disponibile', { sender: settings.sender, from },
      '[lancio] follow-up: chiesto il mittente secondario, non ancora disponibile — si parte dal principale', 'warn');
  }

  // Il budget dei 240s parte dalla lettura della coda, non dal primo invio: venti pagine
  // e le letture dell'intake costano tempo a Vercel esattamente come gli invii.
  const t0 = Date.now();
  // Una coda letta a meta' e una coda vuota danno lo stesso numero: `queryKo` dice quale
  // delle due e' successa, o "0 inviati" a finestra chiusa non si sa interpretare.
  const { righe: coda, queryKo } = await leggiCoda<Candidata>(supabase, 'lancio_followup_query_error', (da, a) =>
    bersaglio('id, crm_lead_id, lancio_fase, lancio_info, lancio_benvenuto_at, lancio_followup_inviato_at, last_inbound_at, leads(phone_e164, first_name)')
      .order('id', { ascending: true })
      .range(da, a),
  );

  // ───────────── valutazione a blocchi: una query `messages` per blocco ─────────────
  // Si legge TUTTA la coda e si valuta a blocchi finche' i BERSAGLI non sono `max`: chi
  // viene saltato (`mai_scritto`, `ancora_ignota`) resta candidato a ogni run, e prendendo
  // i primi 200 per id un centinaio di righe saltate in testa affamerebbe la coda per
  // tutta la finestra.
  const max = batchMax(process.env.LANCIO_BATCH_MAX);
  const saltati = contatoreSalti();
  const targets: Candidata[] = [];
  const daCongedare: { c: Candidata; leadWords: string }[] = [];
  let valutati = 0;
  let lettureIntake = 0;
  let ancoreIgnoteMarcate = 0;
  let blocchiTroncati = 0;
  for (let i = 0; i < coda.length && targets.length < max; i += BLOCCO_VALUTAZIONE) {
    if (Date.now() - t0 > TEMPO_MASSIMO_MS) break;
    const blocco = coda.slice(i, i + BLOCCO_VALUTAZIONE);
    const { data, error } = await supabase
      .from('messages')
      .select('conversation_id, direction, body, template_sid, created_at')
      .in('conversation_id', blocco.map((c) => c.id))
      // Taglio dello storico: prima del lancio non c'e' niente che serva a decidere.
      .gte('created_at', tagliaStorico)
      // Servono SOLO i messaggi del lead (l'interazione, l'ultimo testo) e il benvenuto
      // (l'ancora): tutto il resto dell'outbound di Mario e' peso morto nel tetto righe.
      .or(welcomeSid ? `direction.eq.in,template_sid.eq.${welcomeSid}` : 'direction.eq.in')
      .order('created_at', { ascending: true })
      .limit(MAX_RIGHE_BLOCCO);
    if (error) {
      await logCronQueryError(supabase, 'lancio_followup_messages_query_error', error);
      break;
    }
    const righeBlocco = (data ?? []) as unknown as RigaMessaggio[];
    // Il troncamento non e' innocuo: l'ordine e' crescente, quindi a cadere sono le righe
    // PIU' NUOVE di tutte le chat del blocco — cioe' proprio quelle su cui si decide. Una
    // chat letta a meta' sembrerebbe "non ha mai scritto" a ogni run (niente follow-up per
    // tutta la finestra, in silenzio) o, peggio, farebbe leggere come ultimo testo un "no"
    // vecchio e la manderebbe a DA_SCARTARE. Su una lettura tagliata non si decide nulla:
    // il blocco intero conta `ancora_ignota` e si rivaluta al run dopo.
    if (righeBlocco.length >= MAX_RIGHE_BLOCCO) {
      blocchiTroncati++;
      valutati += blocco.length;
      saltati.ancora_ignota += blocco.length;
      await logEvento(supabase, 'lancio_followup_blocco_troncato',
        { blocco: Math.floor(i / BLOCCO_VALUTAZIONE), righe: righeBlocco.length, tetto: MAX_RIGHE_BLOCCO, conversazioni: blocco.length, primaChat: blocco[0]?.id ?? null, ultimaChat: blocco[blocco.length - 1]?.id ?? null },
        `[lancio] follow-up: cronologia troncata sul blocco da ${blocco.length} chat (${righeBlocco.length} righe, tetto ${MAX_RIGHE_BLOCCO}) — nessuna decisione presa su queste chat`,
        'warn');
      continue;
    }
    const perConv = new Map<number, RigaLancio[]>();
    for (const r of righeBlocco) {
      const lista = perConv.get(r.conversation_id) ?? [];
      lista.push(r);
      perConv.set(r.conversation_id, lista);
    }
    for (const c of blocco) {
      valutati++;
      const rows = perConv.get(c.id) ?? [];
      // L'ancora del lancio: colonna, poi benvenuto in cronologia, poi — solo per le chat
      // riusate, solo entro il tetto e solo se non l'abbiamo gia' cercata invano in un run
      // precedente — l'evento `lancio_intake`.
      let ancora = ancoraLancio({ rows, welcomeSid, benvenutoAt: c.lancio_benvenuto_at, ingressoAt: null });
      if (!ancora && !ancoraIgnotaMarcata(c.lancio_info) && lettureIntake < MAX_LETTURE_INTAKE) {
        lettureIntake++;
        ancora = await leggiIngressoLancioAt(supabase, c.id);
        if (!ancora) {
          await marcaAncoraIgnota(supabase, c.id);
          ancoreIgnoteMarcate++;
        }
      }
      // `decideFollowup` rifa' in memoria il filtro del congedo (C4) e quello della fase:
      // se il filtro JSON della query cambiasse forma, il congedato esce comunque qui.
      const decisione = decideFollowup({
        lancio_fase: c.lancio_fase,
        lancio_followup_inviato_at: c.lancio_followup_inviato_at,
        lancio_info: c.lancio_info,
        rows,
        ancora,
        fineNotte,
      });
      if (decisione.kind === 'salta') {
        saltati[decisione.motivo]++;
        continue;
      }
      if (decisione.kind === 'congeda') {
        daCongedare.push({ c, leadWords: decisione.leadWords });
        continue;
      }
      targets.push(c);
      if (targets.length >= max) break;
    }
  }

  if (dry) {
    return NextResponse.json({
      ok: true, dry: true, candidati: coda.length, valutati, nonValutati: coda.length - valutati,
      targets: targets.length, daCongedare: daCongedare.length, saltati, lettureIntake, blocchiTroncati, max, queryKo,
    });
  }

  // ─────────────── C1: chi ha detto di no si congeda, senza bolla ───────────────
  // `congedoLancio` con `giaInviato: true` non manda nessun messaggio e non scrive il
  // marcatore: qui il marcatore lo scrive il cron (`marcaCongedo`), cosi' il lead esce
  // dai candidati anche se il CRM rifiuta lo scarto, e al lead non arriva niente.
  let congedati = 0;
  for (const { c, leadWords } of daCongedare) {
    if (Date.now() - t0 > TEMPO_MASSIMO_MS) break;
    const phone = c.leads?.phone_e164 ?? null;
    // Un congedo senza numero non e' un non-evento: il lead ha detto di no e nessuno lo
    // sta scartando al CRM. Si conta e si scrive, invece di sparire fra le righe.
    if (!phone) {
      saltati.senza_telefono++;
      await logEvento(supabase, 'lancio_followup_congedo_senza_telefono',
        { conversationId: c.id, crmLeadId: c.crm_lead_id, leadWords: leadWords.slice(0, 300) },
        `[lancio] conv ${c.id}: aveva detto di no ma non ha un numero, congedo non registrato`, 'warn');
      continue;
    }
    await marcaCongedo(supabase, c.id);
    const esitoCongedo = await congedoLancio(
      supabase,
      { conversationId: c.id, phone, from, crmLeadId: c.crm_lead_id, fase: c.lancio_fase },
      leadWords,
      NOTA_CONGEDO_FOLLOWUP,
      { giaInviato: true },
    );
    congedati++;
    await logEvento(supabase, 'lancio_followup_congedo_da_cron',
      { conversationId: c.id, crmLeadId: c.crm_lead_id, stato: esitoCongedo, leadWords: leadWords.slice(0, 300) },
      `[lancio] conv ${c.id}: aveva detto di no, niente follow-up (${esitoCongedo})`);
  }

  // ─────────────── seconda idempotenza ───────────────
  // Un run morto fra l'invio e la scrittura della fase lascia il messaggio a DB e il
  // timbro indietro: qui si ripara senza rimandare. Le righe `failed`/`undelivered` NON
  // contano — quelle sono proprio i tentativi da rifare.
  const giaSpediti = new Set<number>();
  if (targets.length > 0) {
    const { data: spediti, error } = await supabase
      .from('messages')
      .select('conversation_id')
      .in('conversation_id', targets.map((c) => c.id))
      .eq('template_sid', sid)
      .not('twilio_status', 'in', '(failed,undelivered)');
    // Type suo: da `event_log` si deve capire QUALE delle due query su `messages` e'
    // caduta — la cronologia (si smette di valutare) o questa (si rischia di rimandare).
    if (error) await logCronQueryError(supabase, 'lancio_followup_idempotenza_query_error', error);
    for (const m of (spediti ?? []) as unknown as { conversation_id: number }[]) giaSpediti.add(m.conversation_id);
  }

  const bodyRaw = await getTemplateBody(sid);
  const stato = nuovoStatoRun();
  const inviaUno = (c: Candidata): Promise<EsitoInvio> => {
    const phone = c.leads?.phone_e164 ?? null;
    if (stato.fermo || !phone) return Promise.resolve('skip');
    return inviaTemplateTimbrato(supabase, stato, {
      conv: { id: c.id, crm_lead_id: c.crm_lead_id, phone, nome: c.leads?.first_name ?? null },
      colonna: 'lancio_followup_inviato_at',
      faseDopo: 'followup_inviato',
      sid,
      from,
      // L'unica variabile del template ({{1}} nome) e il corpo reso. Li costruisce il
      // motore, dentro il suo try/catch: un nome che facesse saltare il render e' un
      // destinatario saltato, non il blocco di 25 perso. Senza il body da Twilio si usa
      // il testo del template a codice (`lancioFollowupText`), che e' lo stesso approvato.
      costruisci: (conv) => {
        const vars = { '1': templateName(conv.nome) };
        return { vars, body: bodyRaw ? renderBodyTemplate(bodyRaw, vars) : lancioFollowupText(conv.nome) };
      },
      giaSpedito: giaSpediti.has(c.id),
      // Mentre il template e' in volo il turno puo' aver portato la chat avanti (una
      // scelta fatta, un congedo): con `soloDaFasi` la fase non torna indietro. Il timbro
      // resta comunque (e' del claim), quindi la chat esce da sola dai candidati.
      // `post_pitch` e' DENTRO il perimetro (e quindi dentro il compare-and-set): da
      // quella fase il follow-up si manda, e chi lo riceve passa a `followup_inviato`.
      soloDaFasi: FASI_FOLLOWUP,
      prefisso: 'lancio_followup',
      etichetta: 'follow-up',
      eventoInvio: 'lancio_followup_inviato',
    });
  };

  const conti = await eseguiLotti(targets, stato, {
    concorrenza: LANCIO_BLAST_CONCURRENCY,
    t0,
    inviaUno,
    suFreno: (s, c) =>
      frenaLancio(supabase, s, c, {
        prefisso: 'lancio_followup',
        etichetta: 'follow-up',
        candidati: coda.length,
        lotto: targets.length,
      }),
  });

  // Due code diverse, e vanno lette come due cose diverse: i BERSAGLI che questo run non
  // ha servito (residui, come nel blast) e le CANDIDATE che non ha nemmeno valutato
  // perche' il lotto era gia' pieno. Le riprende entrambe il run dopo.
  const residui = targets.length - conti.report.length;
  const nonValutati = coda.length - valutati;
  const riepilogo = {
    candidati: coda.length,
    valutati,
    nonValutati,
    targets: targets.length,
    congedati,
    inviati: conti.inviati,
    riparati: conti.riparati,
    capped: conti.capped,
    falliti: conti.falliti,
    incerti: conti.incerti,
    saltatiInvio: conti.saltati,
    errori: conti.errori,
    residui,
    saltati,
    lettureIntake,
    ancoreIgnoteMarcate,
    blocchiTroncati,
    tentati: stato.tentati,
    codici: stato.codici,
    fermo: stato.fermo,
    max,
    sender: settings.sender,
    queryKo,
  };
  await scriviRun(
    riepilogo,
    `[lancio] follow-up: ${conti.inviati} inviati, ${conti.riparati} riparati, ${conti.capped} cap, ${conti.falliti} falliti, ${conti.incerti} incerti, ${congedati} congedati, ${residui} residui (su ${targets.length} bersagli, ${coda.length} candidati)${stato.fermo ? ` — FERMO: ${stato.fermo}` : ''}`,
    stato.fermo || conti.falliti > 0 || conti.incerti > 0 || conti.errori > 0 ? 'warn' : 'info',
  );

  return NextResponse.json({
    ok: true,
    candidati: coda.length,
    valutati,
    nonValutati,
    targets: targets.length,
    queryKo,
    sent: conti.inviati,
    riparati: conti.riparati,
    capped: conti.capped,
    failed: conti.falliti,
    incerti: conti.incerti,
    skip: conti.saltati,
    errori: conti.errori,
    congedati,
    saltati,
    residui,
    blocchiTroncati,
    fermo: stato.fermo,
    max,
    report: conti.report,
  });
}
