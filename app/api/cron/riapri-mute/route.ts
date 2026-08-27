import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { enrollLeadIntoMario } from '@/lib/fenice-enroll';
import { fetchAllRows } from '@/lib/supabase/paginate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * I lead a cui il primo messaggio non e' mai partito.
 *
 * Dal 24/08/2026 le sei aperture con la dichiarazione IA erano fuori da
 * `UTILITY_ONLY_ALLOW`: il presidio le bloccava, l'arruolamento falliva e restava una
 * conversazione muta. Per il lead il bot non e' mai esistito, e per il CRM quel lead
 * risultava consegnato — e' una delle voci della lista dei "fermi al bot".
 *
 * Il criterio non e' "l'invio ha dato errore" ma **non esiste un messaggio in uscita con
 * un SID Twilio**: e' l'unica prova che qualcosa sia davvero partito. Cosi' la stessa
 * rotta recupera qualunque causa, anche una che non abbiamo ancora visto.
 *
 * Rimandare l'apertura e' sicuro: `enrollLeadIntoMario` sceglie la variante A/B in modo
 * deterministico sul `conversationId`, quindi il lead riceve esattamente l'apertura che
 * gli era stata assegnata e il test A/B resta onesto.
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

  const dal = typeof body.dal === 'string' ? body.dal : '2026-08-24';
  const esegui = body.esegui === true;
  const max = typeof body.max === 'number' && body.max > 0 ? Math.min(body.max, 200) : 50;
  const admin = getSupabaseAdmin();
  const started = Date.now();

  const convs = await fetchAllRows<any>((from, to) => admin
    .from('conversations')
    .select('id, wa_number, crm_lead_id, crm_funnel, lead_id, ai_status, bot_outcome')
    .eq('ai_owner', 'mario')
    .gte('ai_started_at', dal)
    .order('id', { ascending: true })
    .range(from, to));

  // Chi ha almeno un messaggio in uscita davvero partito non va toccato.
  const conMessaggio = new Set<number>();
  const ids = convs.map((c: any) => c.id);
  for (let i = 0; i < ids.length; i += 100) {
    const { data } = await admin.from('messages')
      .select('conversation_id').eq('direction', 'out')
      .not('twilio_sid', 'is', null).in('conversation_id', ids.slice(i, i + 100));
    for (const m of (data ?? []) as Array<{ conversation_id: number }>) conMessaggio.add(m.conversation_id);
  }

  // Un lead gia' esitato non si riapre: e' stato chiuso per una ragione.
  const mute = convs.filter((c: any) => !conMessaggio.has(c.id) && !c.bot_outcome && c.wa_number);

  const nomi = new Map<number, { first_name: string | null; email: string | null }>();
  const leadIds = [...new Set(mute.map((c: any) => c.lead_id).filter(Boolean))];
  for (let i = 0; i < leadIds.length; i += 100) {
    const { data } = await admin.from('leads')
      .select('id, first_name, email').in('id', leadIds.slice(i, i + 100));
    for (const l of (data ?? []) as Array<{ id: number; first_name: string | null; email: string | null }>) {
      nomi.set(l.id, { first_name: l.first_name, email: l.email });
    }
  }

  let inviati = 0, falliti = 0, differiti = 0;
  const errori: string[] = [];
  const esempi = mute.slice(0, 5).map((c: any) => ({ conv: c.id, lead: c.crm_lead_id, funnel: c.crm_funnel }));

  if (esegui) {
    for (const c of mute) {
      if (inviati + falliti >= max || Date.now() - started > BUDGET_MS) break;
      const l = nomi.get(c.lead_id) ?? { first_name: null, email: null };
      try {
        const res = await enrollLeadIntoMario(admin, {
          phone: c.wa_number,
          firstName: l.first_name,
          email: l.email,
          crmLeadId: c.crm_lead_id,
          crmFunnel: c.crm_funnel,
        });
        if (res.deferred) differiti++;
        else if (res.ok) inviati++;
        else { falliti++; if (errori.length < 5) errori.push(res.error ?? 'errore'); }
      } catch (e) {
        falliti++;
        if (errori.length < 5) errori.push(e instanceof Error ? e.message : 'errore');
      }
    }

    await admin.from('event_log').insert({
      type: 'riapri_mute',
      payload: { candidate: mute.length, inviati, falliti, differiti, dal } as never,
      message: `[bot-fissatore] recupero conversazioni mute: ${inviati} aperture partite, ${falliti} fallite, ${differiti} differite fuori fascia`,
      level: falliti > 0 ? 'warn' : 'info',
    });
  }

  return NextResponse.json({
    ok: true, dal, candidate: mute.length, esaminate: convs.length,
    inviati, falliti, differiti, esegui, errori, esempi,
  });
}
