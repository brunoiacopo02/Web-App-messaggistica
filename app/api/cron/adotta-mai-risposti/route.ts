import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { fetchAllRows } from '@/lib/supabase/paginate';
import { sendTemplateAndLog } from '@/lib/messaging';
import { funnelDaPrimoMessaggio } from '@/lib/persona';
import { templateName } from '@/lib/name';
import { inSendWindow } from '@/lib/sequence';

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

  const conOutbound = new Set<number>();
  const ids = convs.map((c: any) => c.id);
  for (let i = 0; i < ids.length; i += 100) {
    const { data } = await admin.from('messages')
      .select('conversation_id').eq('direction', 'out').in('conversation_id', ids.slice(i, i + 100));
    for (const m of (data ?? []) as Array<{ conversation_id: number }>) conOutbound.add(m.conversation_id);
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
  const errori: string[] = [];
  const esempi = muti.slice(0, 5).map((c: any) => ({ conv: c.id, scrittoIl: c.last_inbound_at }));

  if (esegui) {
    if (!inSendWindow(Date.now())) {
      return NextResponse.json({ ok: true, candidate: muti.length, inviati: 0, falliti: 0, esegui, fuoriFascia: true, esempi });
    }
    for (const c of muti) {
      if (inviati + falliti >= max || Date.now() - started > BUDGET_MS) break;
      const l = anagrafica.get(c.lead_id);
      if (!l) { falliti++; if (errori.length < 5) errori.push(`conv ${c.id}: nessun numero`); continue; }

      const { data: primi } = await admin.from('messages')
        .select('body').eq('conversation_id', c.id).eq('direction', 'in')
        .order('created_at', { ascending: true }).limit(1);
      const provenienza = funnelDaPrimoMessaggio(((primi ?? [])[0] as { body: string | null } | undefined)?.body);

      const now = new Date().toISOString();
      await admin.from('conversations').update({
        ai_owner: 'mario', ai_status: 'active', ai_started_at: now, crm_funnel: provenienza,
      }).eq('id', c.id);

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
      payload: { candidate: muti.length, inviati, falliti, dal } as never,
      message: `[bot-fissatore] recupero di chi ci ha scritto per primo: ${inviati} riaggancio partiti, ${falliti} falliti`,
      level: falliti > 0 ? 'warn' : 'info',
    });
  }

  return NextResponse.json({
    ok: true, dal, candidate: muti.length, esaminate: convs.length, inviati, falliti, esegui, errori, esempi,
  });
}
