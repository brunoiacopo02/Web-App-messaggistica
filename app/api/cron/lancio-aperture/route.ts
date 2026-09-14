import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { sendTemplate } from '@/lib/twilio';
import { getLancioSettings } from '@/lib/lancio-settings';
import {
  decideAperturaLancio,
  riassumiOutboundLancio,
  type RigaOutbound,
} from '@/lib/lancio-aperture';
import { lancioBenvenutoText } from '@/lib/lancio-fase';
import { templateName } from '@/lib/name';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// Benvenuti del lancio rimasti indietro (intake fuori dalla fascia 07-23 o lancio
// spento). Queste chat vengono escluse da sequence-touches (FILTRO_FUORI_LANCIO) dal
// Task 10: senza questo cron resterebbero mute per sempre — e nel frattempo il
// benvenuto lo manda solo chi lo sa mandare, cioe' questo route, perche' la sequenza
// non conosce il template del lancio. Schedule in vercel.json: ogni 15' dalle 05
// alle 21 UTC; il filtro sull'ora italiana lo fa `decideAperturaLancio` via
// `inOpeningWindow`, perche' l'ora legale sposta la fascia e il cron no.

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
  lancio_fase: string | null;
  leads: { phone_e164: string | null; first_name: string | null } | null;
};

export async function GET(req: NextRequest) {
  if (!authorized(req)) return new NextResponse('unauthorized', { status: 401 });

  const supabase = getSupabaseAdmin();
  const templateSid = process.env.LANCIO_WELCOME_TEMPLATE_SID;
  const from = process.env.TWILIO_WHATSAPP_NUMBER_FENICE;
  if (!templateSid || !from) {
    await supabase.from('event_log').insert({
      type: 'lancio_aperture_config_error',
      payload: {
        missing: [
          !templateSid ? 'LANCIO_WELCOME_TEMPLATE_SID' : null,
          !from ? 'TWILIO_WHATSAPP_NUMBER_FENICE' : null,
        ].filter(Boolean),
      } as never,
      message: '[lancio] env mancanti per i benvenuti differiti: run saltato',
      level: 'error',
    });
    return NextResponse.json({ ok: true, inviati: 0, skipped: 'config' });
  }

  const settings = await getLancioSettings(supabase);
  const now = Date.now();
  const maxPerRun = Math.max(1, Number(process.env.LANCIO_APERTURE_MAX_PER_RUN) || 100);

  const { data } = await supabase
    .from('conversations')
    .select('id, crm_lead_id, lancio_fase, leads(phone_e164, first_name)')
    .not('lancio_slug', 'is', null)
    .eq('lancio_fase', 'attesa')
    .eq('ai_status', 'active')
    // Fermo manuale dal pannello: la chat e' in mano a una persona, nessun automatismo
    // le scrive addosso.
    .is('ai_paused_at', null)
    .order('id', { ascending: true })
    .limit(1000);
  const convs = (data ?? []) as unknown as Conv[];

  let inviati = 0;
  let attesi = 0;
  let saltati = 0;
  let capped = 0;
  let falliti = 0;
  // Il tetto e' sui TENTATIVI, non sugli invii riusciti: un run che sbatte su 100
  // numeri morti ha comunque fatto 100 chiamate a Twilio.
  let tentati = 0;
  // Due conversazioni sullo stesso numero (lead doppio nel CRM) sono due righe qui ma
  // una sola chat su WhatsApp: il benvenuto parte una volta per numero.
  const numeriServiti = new Set<string>();

  for (const c of convs) {
    if (tentati >= maxPerRun) break;
    const phone = c.leads?.phone_e164 ?? null;
    if (!phone) {
      saltati++;
      continue;
    }
    if (numeriServiti.has(phone)) {
      saltati++;
      continue;
    }
    try {
      // Tutta la cronologia in uscita, senza tagli sull'arruolamento: su una chat
      // riusata l'apertura di Mario e' proprio quella che deve trattenere il
      // benvenuto per 12 ore (guardia `apertura_recente` dell'intake).
      const { data: outs } = await supabase
        .from('messages')
        .select('template_sid, twilio_status, created_at')
        .eq('conversation_id', c.id)
        .eq('direction', 'out')
        .order('created_at', { ascending: false })
        .limit(50);
      const riassunto = riassumiOutboundLancio((outs ?? []) as RigaOutbound[], templateSid);

      const azione = decideAperturaLancio({
        nowMs: now,
        attivo: settings.attivo,
        fase: c.lancio_fase,
        ...riassunto,
      });
      if (azione === 'attendi') {
        attesi++;
        continue;
      }
      if (azione === 'salta') {
        saltati++;
        continue;
      }

      const nome = c.leads?.first_name ?? null;
      const corpo = lancioBenvenutoText(nome);
      tentati++;
      numeriServiti.add(phone);
      try {
        const res = await sendTemplate({
          to: phone,
          contentSid: templateSid,
          variables: { '1': templateName(nome) },
          from,
        });
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
        await supabase.from('event_log').insert({
          type: 'lancio_apertura_inviata',
          payload: { conversationId: c.id, crmLeadId: c.crm_lead_id, sid: res.sid } as never,
          message: `[lancio] benvenuto differito inviato a ${phone}`,
          level: 'info',
        });
        inviati++;
      } catch (err) {
        const e = err as { message?: string; code?: number };
        if (e?.code === 63049) {
          // Frequency cap Meta: NESSUNA riga (non consuma un tentativo) e si ritenta
          // al run dopo, come nella sequenza.
          // Il numero resta fra quelli serviti: il cap e' del numero, non della
          // conversazione, e ritentarlo subito su una chat gemella lo ribeccherebbe.
          capped++;
          await supabase.from('event_log').insert({
            type: 'lancio_apertura_freq_capped',
            payload: { conversationId: c.id, crmLeadId: c.crm_lead_id } as never,
            message: `[lancio] frequency cap Meta su conv ${c.id}: benvenuto rimandato al prossimo run`,
            level: 'info',
          });
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
        await supabase.from('event_log').insert({
          type: 'send_error',
          payload: { conversationId: c.id, crmLeadId: c.crm_lead_id, error: e?.message ?? 'errore' } as never,
          message: `[lancio] benvenuto differito fallito per ${phone}: ${e?.message ?? 'errore'}`,
          level: 'error',
        });
      }
    } catch (e) {
      await supabase.from('event_log').insert({
        type: 'lancio_aperture_error',
        payload: { conversationId: c.id, error: e instanceof Error ? e.message : 'errore' } as never,
        message: `[lancio] errore su conv ${c.id}: ${e instanceof Error ? e.message : 'errore'}`,
        level: 'error',
      });
    }
  }

  // Un run che non ha fatto niente non lascia righe: questo cron gira ogni 15' e
  // l'event_log non e' un posto dove scrivere "nulla di nuovo" 64 volte al giorno.
  if (inviati > 0 || falliti > 0 || capped > 0) {
    await supabase.from('event_log').insert({
      type: 'lancio_aperture_run',
      payload: { candidati: convs.length, inviati, attesi, saltati, capped, falliti, attivo: settings.attivo } as never,
      message: `[lancio] benvenuti differiti: ${inviati} inviati, ${attesi} in attesa, ${saltati} saltati, ${capped} cap, ${falliti} falliti`,
      level: falliti > 0 ? 'warn' : 'info',
    });
  }
  return NextResponse.json({
    ok: true,
    candidati: convs.length,
    inviati,
    attesi,
    saltati,
    capped,
    falliti,
    attivo: settings.attivo,
  });
}
