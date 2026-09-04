import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { fetchAllRows } from '@/lib/supabase/paginate';
import { sendTemplateAndLog } from '@/lib/messaging';
import { funnelDaPrimoMessaggio } from '@/lib/persona';
import { templateName } from '@/lib/name';
import { inSendWindow } from '@/lib/sequence';
import { assertTemplateSendable } from '@/lib/twilio';

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
  const from = process.env.TWILIO_WHATSAPP_NUMBER_FENICE;
  if (!templateSid || !from) {
    return NextResponse.json({ ok: false, error: 'MARTA_REENGAGE_TEMPLATE_SID o TWILIO_WHATSAPP_NUMBER_FENICE non configurati' }, { status: 503 });
  }

  const admin = getSupabaseAdmin();
  const started = Date.now();

  // Candidati: nessun padrone, il lead ha scritto, sul numero Fenice, nessuno l'ha
  // presa in mano. Il filtro sugli outbound si fa dopo, in memoria: PostgREST non sa
  // fare "nessuna riga collegata" senza una vista.
  const convs = await fetchAllRows<any>((from_, to) => admin
    .from('conversations')
    .select('id, lead_id, wa_number, ai_paused_at, handed_off_at, last_inbound_at')
    .is('ai_owner', null)
    .is('handed_off_at', null)
    .is('ai_paused_at', null)
    .not('last_inbound_at', 'is', null)
    .eq('wa_number', from)
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
        .select('body').eq('conversation_id', c.id).eq('direction', 'in')
        .order('created_at', { ascending: true }).limit(1);
      const provenienza = funnelDaPrimoMessaggio(((primi ?? [])[0] as { body: string | null } | undefined)?.body);

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

      const nome = templateName(l.first_name);
      const res = await sendTemplateAndLog(
        admin, c.id, l.phone, templateSid, 'Riaggancio (mai risposto)', from,
        { '1': nome },
        `Ciao ${nome}, sono Marta di Fenice Academy: ci eravamo persi a metà discorso 🙂 Se ti va riprendiamo da dove eravamo rimasti, altrimenti scrivimi NO e non ti disturbo più.`,
      );
      if (res.ok) inviati++;
      else { falliti++; if (errori.length < 5) errori.push(res.error ?? 'errore'); }
    }

    await admin.from('event_log').insert({
      type: 'adotta_mai_risposti',
      payload: { candidate: muti.length, inviati, falliti, giaPrese, dal } as never,
      message: `[bot-fissatore] recupero di chi ci ha scritto per primo: ${inviati} riaggancio partiti, ${falliti} falliti, ${giaPrese} gia' prese dal webhook`,
      level: falliti > 0 ? 'warn' : 'info',
    });
  }

  return NextResponse.json({
    ok: true, dal, candidate: muti.length, esaminate: convs.length, inviati, falliti, giaPrese, esegui, errori, esempi,
  });
}
