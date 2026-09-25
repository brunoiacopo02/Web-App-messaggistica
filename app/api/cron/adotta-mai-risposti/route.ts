import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { fetchAllRows } from '@/lib/supabase/paginate';
import { sendTemplateAndLog } from '@/lib/messaging';
import { classificaPrimoMessaggio, vaRiagganciato, LANCIO_INGRESSO_LINK_SVILUPPATORE } from '@/lib/primo-messaggio';
import { LANCIO_SLUG, conMarioDopoNotte } from '@/lib/lancio-fase';
import { dopoLaNotteDelLancio } from '@/lib/lancio-scelta';
import { adessoLancio } from '@/lib/lancio-orologio';
import type { Json } from '@/lib/supabase/types';
import { impostaFaseLancio } from '@/lib/lancio-db';
import { getLancioSettings } from '@/lib/lancio-settings';
import { templateName } from '@/lib/name';
import { inSendWindow } from '@/lib/sequence';
import { assertTemplateSendable } from '@/lib/twilio';
import { pushLeadEntrante } from '@/lib/lead-entrante';
import { mittenteDiConversazione, numeriDelBot } from '@/lib/mittente';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * I lead che ci hanno scritto per primi e a cui non ha mai risposto nessuno.
 *
 * Fino al 04/09/2026 il bot rispondeva solo a chi gli mandava l'intake del CRM: chi
 * scriveva per primo non aveva padrone. Fra il 26/08 e il 04/09 sono 29 persone su 43
 * arrivate dal canale Telegram, con un silenzio mediano di 113 ore, e sei di loro hanno
 * scritto di nuovo nel vuoto ("Scusa poi risponde").
 *
 * Sono tutte fuori dalla finestra 24h, quindi per riaprire serve un template. Si usa il
 * RIAGGANCIO gia' approvato, non le aperture: l'apertura Telegram dice "l'accesso al
 * canale ti arriva via email a breve" a gente che nel canale c'e' gia' — e' da li' che ha
 * preso il nostro numero — e quella del corso promette 10 ore che nessuno ha chiesto.
 * Il riaggancio non promette niente.
 *
 * Rotta manuale come `riapri-mute`, NON in vercel.json. Con l'adozione accesa la sua
 * lista deve restare vuota: ricontrollarla ogni tanto e' il modo per accorgersi se
 * l'adozione ha smesso di funzionare.
 *
 * Non guarda `INBOUND_ADOPTION_ENABLED`, ed e' voluto: e' il recupero a mano dell'
 * arretrato, si lancia quando lo si vuole lanciare e deve poter adottare anche mentre
 * l'adozione automatica del webhook e' spenta. Il pulsante del webinar invece ha il suo
 * interruttore condiviso col webhook (`lancio_pulsante_attivo` in `app_settings`).
 *
 * POST { dal?: 'YYYY-MM-DD', esegui?: boolean, max?: number }
 */

const BUDGET_MS = 240_000;

export async function POST(req: NextRequest) {
  const cron = process.env.CRON_SECRET;
  if (!cron || req.headers.get('authorization') !== `Bearer ${cron}`) {
    return new NextResponse('unauthorized', { status: 401 });
  }

  let body: { dal?: string; esegui?: boolean; max?: number };
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'bad_json' }, { status: 400 }); }

  const dal = typeof body.dal === 'string' ? body.dal : '2026-08-01';
  const esegui = body.esegui === true;
  const max = typeof body.max === 'number' && body.max > 0 ? Math.min(body.max, 100) : 25;

  const templateSid = process.env.MARTA_REENGAGE_TEMPLATE_SID;
  // I numeri del bot, tutti: chi ha scritto per primo sul secondo numero e' "mai
  // risposto" quanto chi ha scritto sul primo, e il riaggancio gli parte da li'.
  const numeri = numeriDelBot();
  if (!templateSid || numeri.length === 0) {
    return NextResponse.json({ ok: false, error: 'MARTA_REENGAGE_TEMPLATE_SID o TWILIO_WHATSAPP_NUMBER_FENICE non configurati' }, { status: 503 });
  }

  const admin = getSupabaseAdmin();
  const started = Date.now();

  // Lo stesso interruttore del webhook, letto UNA volta per run e non per lead: spento,
  // il marker del pulsante vale come assente e questi lead tornano a essere TELEGRAM o
  // INBOUND, riaggancio di Marta compreso.
  const settingsLancio = await getLancioSettings(admin);
  // Dopo la notte del webinar (PO 25/09) il pulsante porta a Mario standard e vale anche a
  // interruttore spento, come nel webhook: qui si decide una volta per run.
  const pulsanteDopoNotte = dopoLaNotteDelLancio(adessoLancio(), settingsLancio.eventoAt);
  const pulsanteAttivo = settingsLancio.pulsanteAttivo || pulsanteDopoNotte;

  // Candidati: nessun padrone, il lead ha scritto, su uno dei numeri del bot, nessuno
  // l'ha presa in mano. Il filtro sugli outbound si fa dopo, in memoria: PostgREST non
  // sa fare "nessuna riga collegata" senza una vista.
  //
  // `lancio_slug` nullo: una chat del lancio e' gia' presa in carico da qualcun altro —
  // il suo benvenuto, il suo turno, la sua restituzione di fine lancio — e non e' mai
  // "mai risposta" in questo senso. Il riaggancio di Marta sopra una chat del lancio
  // sarebbe una seconda voce sulla stessa persona. E' piu' stretto di
  // `FILTRO_FUORI_LANCIO` (che lascia passare le fasi terminali) apposta: qui non
  // interessa se il lancio e' finito, interessa che quella chat e' roba sua.
  const convs = await fetchAllRows<any>((from_, to) => admin
    .from('conversations')
    .select('id, lead_id, wa_number, ai_paused_at, handed_off_at, last_inbound_at')
    .is('ai_owner', null)
    .is('handed_off_at', null)
    .is('ai_paused_at', null)
    .is('lancio_slug', null)
    .not('last_inbound_at', 'is', null)
    .in('wa_number', numeri)
    .gte('last_inbound_at', dal)
    .order('id', { ascending: true })
    .range(from_, to));

  // Paginata con fetchAllRows: senza, PostgREST taglia in silenzio a 1.000 righe (il
  // tetto documentato in lib/supabase/paginate.ts). Bastano una decina di messaggi in
  // uscita a conversazione su un chunk da 100 per superarlo — le conversazioni le cui
  // righe cadono oltre la millesima sparirebbero da `conOutbound` e risulterebbero
  // "mai risposte", prendendosi il riaggancio pur avendo gia' una storia.
  const conOutbound = new Set<number>();
  const ids = convs.map((c: any) => c.id);
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const righe = await fetchAllRows<{ conversation_id: number }>((f, t) => admin
      .from('messages').select('id, conversation_id').eq('direction', 'out')
      .in('conversation_id', chunk).order('id', { ascending: true }).range(f, t));
    for (const m of righe) conOutbound.add(m.conversation_id);
  }
  const muti = convs.filter((c: any) => !conOutbound.has(c.id) && c.lead_id);

  // Anagrafica e primo messaggio: il numero sta su `leads.phone_e164`, NON su
  // `conversations.wa_number` — quella colonna e' il NOSTRO mittente, e usarla come
  // destinatario vorrebbe dire mandare i riaggancio a noi stessi.
  const anagrafica = new Map<number, { phone: string; first_name: string | null }>();
  const leadIds = [...new Set(muti.map((c: any) => c.lead_id))];
  for (let i = 0; i < leadIds.length; i += 100) {
    const { data } = await admin.from('leads')
      .select('id, phone_e164, first_name').in('id', leadIds.slice(i, i + 100));
    for (const l of (data ?? []) as Array<{ id: number; phone_e164: string; first_name: string | null }>) {
      if (l.phone_e164) anagrafica.set(l.id, { phone: l.phone_e164, first_name: l.first_name });
    }
  }

  let inviati = 0, falliti = 0;
  // Prese dal webhook mentre il ciclo era in corso: non sono ne' invii ne' fallimenti.
  let giaPrese = 0;
  // Entrate nel lancio dal pulsante del webinar: adottate e passate a post_pitch, ma
  // senza riaggancio (vedi `vaRiagganciato`). Contate a parte perche' non sono ne'
  // invii ne' fallimenti, e perche' la loro presenza qui e' una notizia.
  let pulsante = 0;
  const errori: string[] = [];
  const esempi = muti.slice(0, 5).map((c: any) => ({ conv: c.id, scrittoIl: c.last_inbound_at }));

  if (esegui) {
    if (!inSendWindow(Date.now())) {
      return NextResponse.json({ ok: true, candidate: muti.length, inviati: 0, falliti: 0, esegui, fuoriFascia: true, esempi });
    }
    // Verifica una volta sola, prima del ciclo: se UTILITY_ONLY e' attivo e il SID del
    // riaggancio non e' in UTILITY_ONLY_ALLOW, senza questo controllo tutti gli invii
    // falliscono uno per uno — e ognuno che fallisce regala quella persona a
    // riapri-mute, che le manderebbe l'apertura vietata per questa lista.
    try {
      await assertTemplateSendable(templateSid);
    } catch (e) {
      return NextResponse.json({
        ok: false, error: e instanceof Error ? e.message : 'template non spedibile',
        candidate: muti.length, inviati: 0,
      }, { status: 503 });
    }
    for (const c of muti) {
      // La fascia va ricontrollata anche qui: il ciclo ha 240s di budget, un run
      // partito a ridosso delle 20:30 puo' arrivare a consegnare dopo la chiusura.
      if (inviati + falliti >= max || Date.now() - started > BUDGET_MS || !inSendWindow(Date.now())) break;
      const l = anagrafica.get(c.lead_id);
      if (!l) { falliti++; if (errori.length < 5) errori.push(`conv ${c.id}: nessun numero`); continue; }

      const { data: primi } = await admin.from('messages')
        .select('body, created_at').eq('conversation_id', c.id).eq('direction', 'in')
        .order('created_at', { ascending: true }).limit(1);
      const primoRiga = (primi ?? [])[0] as { body: string | null; created_at: string } | undefined;
      // Qui il primo inbound e' anche l'ultimo: la chat ha un solo messaggio, il suo.
      const esito = classificaPrimoMessaggio({ primoInbound: primoRiga?.body, inboundCorrente: primoRiga?.body, pulsanteAttivo });
      const provenienza = esito.provenienza;

      const now = new Date().toISOString();
      // Compare-and-set su `ai_owner`: la lista dei candidati si calcola all'inizio e
      // il ciclo dura fino a 240 secondi. Se in quel mentre uno dei 29 riscrive, il
      // webhook lo adotta e gli risponde a testo libero; senza questa condizione qui
      // arriverebbe subito dopo anche il riaggancio "ci eravamo persi a meta'
      // discorso", sopra una risposta appena data. Sei di quelle persone hanno gia'
      // dimostrato di riscrivere nel vuoto. Nessuna riga tornata = l'ha presa
      // qualcun altro: si salta senza inviare, e non e' un fallimento.
      const { data: adottate, error: adoptError } = await admin.from('conversations').update({
        ai_owner: 'mario', ai_status: 'active', ai_started_at: now, crm_funnel: provenienza,
      }).eq('id', c.id).is('ai_owner', null).select('id');
      // Se l'adozione non si scrive, l'invio NON parte: altrimenti la conversazione
      // resta senza padrone ma con una riga in uscita, e al prossimo messaggio del
      // lead il webhook la vede gia' "risposta" e non la adotta piu' — si ricrea
      // esattamente il silenzio che questa rotta esiste per chiudere.
      if (adoptError) {
        falliti++;
        if (errori.length < 5) errori.push(`conv ${c.id}: adozione fallita — ${adoptError.message}`);
        continue;
      }
      if (!adottate || adottate.length === 0) { giaPrese++; continue; }

      // Ha premuto il pulsante del webinar e nessuno gli ha mai risposto: la chat entra
      // nel lancio PRIMA del riaggancio, cosi' i cron del lancio (link, follow-up) la
      // trovano al loro primo giro. I candidati hanno `lancio_slug` nullo per
      // costruzione, quindi le colonne d'ingresso si scrivono sempre; la fase passa da
      // `impostaFaseLancio`, unico scrittore di `lancio_fase`, e l'evento del pulsante
      // si inserisce a parte come nel webhook.
      if (esito.tipo === 'lancio_pulsante') {
        await admin.from('conversations')
          .update({ lancio_slug: LANCIO_SLUG, lancio_ingresso: 'pulsante_webinar' })
          .eq('id', c.id);
        // Dopo la notte del webinar niente dopo-pitch: Mario standard con la nota della live.
        if (pulsanteDopoNotte) {
          await impostaFaseLancio(admin, c.id, 'chiuso', {
            lancio_info: conMarioDopoNotte(null, 'pulsante', now) as unknown as Json,
          });
        } else {
          await impostaFaseLancio(admin, c.id, 'post_pitch');
        }
        await admin.from('event_log').insert({
          type: 'lancio_pulsante',
          payload: { conversationId: c.id, giaDiMario: false, daCron: 'adotta-mai-risposti' } as never,
          message: `[lancio] ${l.phone} aveva premuto il pulsante del webinar e non gli ha mai risposto nessuno (conv ${c.id})`,
          level: 'info',
        });
      }

      // Ha scritto dal link "professione dello Sviluppatore AI" (PO 24/09/2026): entra nel
      // lancio in fase `chiuso` come fa il webhook, cosi' quando risponde al riaggancio il
      // drain usa la nota della live e il suo video. Lo slug e' nullo per costruzione.
      if (esito.tipo === 'lancio_link') {
        await admin.from('conversations')
          .update({ lancio_slug: LANCIO_SLUG, lancio_ingresso: LANCIO_INGRESSO_LINK_SVILUPPATORE })
          .eq('id', c.id);
        await impostaFaseLancio(admin, c.id, 'chiuso');
        await admin.from('event_log').insert({
          type: 'lancio_link_sviluppatore',
          payload: { conversationId: c.id, daCron: 'adotta-mai-risposti' } as never,
          message: `[lancio] ${l.phone} aveva scritto dal link "professione dello Sviluppatore AI" e non gli ha mai risposto nessuno (conv ${c.id})`,
          level: 'info',
        });
      }

      // Qui, prima del riaggancio: non c'e' nessun Twilio da non far aspettare, e il
      // CRM ha bisogno del leadId per poter accettare l'esito quando arriva. Il loro
      // lock e' per numero, non globale: fino a 35 push ravvicinati in un run vanno bene.
      await pushLeadEntrante(admin, {
        conversationId: c.id,
        telefono: l.phone,
        nome: l.first_name,
        provenienza,
        primoMessaggio: primoRiga?.body ?? null,
        scrittoIl: primoRiga?.created_at ?? now,
      });

      // Chi e' arrivato dal pulsante del webinar si ferma qui: ha la fase, ha il lead sul
      // CRM, e a rispondergli ci pensa il turno del lancio nel drain. Il riaggancio di
      // Marta ("ci eravamo persi a meta' discorso") sarebbe una seconda voce sulla stessa
      // persona, con un testo che col webinar non c'entra niente.
      // Dopo la notte del webinar la chat e' di Mario standard: il riaggancio parte come per
      // chi arriva dal link "Sviluppatore AI", o nessuno gli risponderebbe.
      if (!vaRiagganciato(esito) && !pulsanteDopoNotte) { pulsante++; continue; }

      const nome = templateName(l.first_name);
      // Dal numero su cui ci ha scritto: e' quello che ha in rubrica, ed e' l'unico
      // da cui il suo primo messaggio conta come inizio di conversazione.
      const res = await sendTemplateAndLog(
        admin, c.id, l.phone, templateSid, 'Riaggancio (mai risposto)', mittenteDiConversazione(c),
        { '1': nome },
        `Ciao ${nome}, sono Marta di Fenice Academy: ci eravamo persi a metà discorso 🙂 Se ti va riprendiamo da dove eravamo rimasti, altrimenti scrivimi NO e non ti disturbo più.`,
      );
      if (res.ok) inviati++;
      else { falliti++; if (errori.length < 5) errori.push(res.error ?? 'errore'); }
    }

    await admin.from('event_log').insert({
      type: 'adotta_mai_risposti',
      payload: { candidate: muti.length, inviati, falliti, giaPrese, pulsante, dal } as never,
      message: `[bot-fissatore] recupero di chi ci ha scritto per primo: ${inviati} riaggancio partiti, ${falliti} falliti, ${giaPrese} gia' prese dal webhook, ${pulsante} entrate nel lancio dal pulsante`,
      level: falliti > 0 ? 'warn' : 'info',
    });
  }

  return NextResponse.json({
    ok: true, dal, candidate: muti.length, esaminate: convs.length, inviati, falliti, giaPrese, pulsante, pulsanteAttivo, esegui, errori, esempi,
  });
}
