import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { renderTemplateVariables, type CampaignRow } from '@/lib/campaigns';
import { fetchListContacts } from '@/lib/ac-api';
import { planBatch, type PlannedSend } from '@/lib/batch';
import { sendTemplate, getTemplateBody } from '@/lib/twilio';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const CONCURRENCY = 5;

type Supa = ReturnType<typeof getSupabaseAdmin>;

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  // Vercel Cron invia: Authorization: Bearer <CRON_SECRET>
  if (req.headers.get('authorization') === `Bearer ${secret}`) return true;
  // Trigger manuale (test/dry-run): ?secret=<CRON_SECRET>
  if (req.nextUrl.searchParams.get('secret') === secret) return true;
  return false;
}

/** Telefoni già contattati con successo per questa campagna (idempotenza). */
async function getSentPhones(supabase: Supa, campaign: CampaignRow): Promise<Set<string>> {
  const { data: msgs } = await supabase
    .from('messages')
    .select('conversation_id')
    .eq('is_template', true)
    .eq('direction', 'out')
    .eq('template_sid', campaign.twilio_template_sid)
    .not('twilio_status', 'in', '(failed,undelivered)');

  const convIds = [...new Set((msgs ?? []).map((m) => m.conversation_id).filter((x): x is number => x != null))];
  if (convIds.length === 0) return new Set();

  const { data: convs } = await supabase.from('conversations').select('lead_id').in('id', convIds);
  const leadIds = [...new Set((convs ?? []).map((c) => c.lead_id))];
  if (leadIds.length === 0) return new Set();

  const { data: leads } = await supabase.from('leads').select('phone_e164').in('id', leadIds);
  return new Set((leads ?? []).map((l) => l.phone_e164));
}

async function runPool<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, idx: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      results[idx] = await worker(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return results;
}

/** Invia il template a un singolo destinatario, creando lead/conversazione/messaggio. */
async function sendOne(
  supabase: Supa,
  campaign: CampaignRow,
  planned: PlannedSend,
): Promise<'sent' | 'failed'> {
  const { contact, phone } = planned;

  const { data: leadRow, error: leadErr } = await supabase
    .from('leads')
    .upsert(
      {
        phone_e164: phone,
        first_name: contact.firstName,
        last_name: contact.lastName,
        email: contact.email,
        ac_contact_id: contact.id || null,
      },
      { onConflict: 'phone_e164' },
    )
    .select('id')
    .single();
  if (leadErr || !leadRow) {
    await supabase.from('event_log').insert({
      type: 'send_error',
      payload: { phone, error: leadErr } as never,
      message: `Batch: lead upsert fallito: ${leadErr?.message}`,
      level: 'error',
    });
    return 'failed';
  }

  const { data: convExisting } = await supabase
    .from('conversations')
    .select('id')
    .eq('lead_id', leadRow.id)
    .maybeSingle();
  let conversationId = convExisting?.id;
  if (!conversationId) {
    const { data: convNew, error: convErr } = await supabase
      .from('conversations')
      .insert({ lead_id: leadRow.id, campaign_id: campaign.id })
      .select('id')
      .single();
    if (convErr || !convNew) {
      await supabase.from('event_log').insert({
        type: 'send_error',
        payload: { leadId: leadRow.id } as never,
        message: `Batch: conv create fallito: ${convErr?.message}`,
        level: 'error',
      });
      return 'failed';
    }
    conversationId = convNew.id;
  }

  const vars = renderTemplateVariables(campaign.template_variables, {
    email: contact.email,
    firstName: contact.firstName,
    lastName: contact.lastName,
    phone,
    acContactId: contact.id || null,
    listName: null,
    listId: campaign.ac_list_match,
  });

  const tplBody = (await getTemplateBody(campaign.twilio_template_sid)) ?? `[template] ${campaign.name}`;
  try {
    const sent = await sendTemplate({ to: phone, contentSid: campaign.twilio_template_sid, variables: vars });
    await supabase.from('messages').insert({
      conversation_id: conversationId,
      direction: 'out',
      body: tplBody,
      twilio_sid: sent.sid,
      twilio_status: sent.status,
      template_sid: campaign.twilio_template_sid,
      template_vars: vars,
      is_template: true,
    });
    await supabase
      .from('conversations')
      .update({ last_message_at: new Date().toISOString() })
      .eq('id', conversationId);
    return 'sent';
  } catch (err: unknown) {
    const e = err as { message?: string; code?: number; status?: number };
    await supabase.from('event_log').insert({
      type: 'send_error',
      payload: { phone, code: e?.code, status: e?.status } as never,
      message: `Batch: Twilio send fallito: ${e?.message ?? 'unknown'}`,
      level: 'error',
    });
    await supabase.from('messages').insert({
      conversation_id: conversationId,
      direction: 'out',
      body: tplBody,
      twilio_status: 'failed',
      twilio_error_code: e?.code ?? null,
      template_sid: campaign.twilio_template_sid,
      template_vars: vars,
      is_template: true,
    });
    return 'failed';
  }
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return new NextResponse('unauthorized', { status: 401 });

  const sp = req.nextUrl.searchParams;
  const dry = sp.get('dry') === '1';
  // Tetto massimo invii: query ?max= (test) oppure env BATCH_MAX (salvaguardia per il limite WhatsApp/24h).
  const maxRaw = parseInt(sp.get('max') ?? process.env.BATCH_MAX ?? '0', 10);
  const max = Number.isFinite(maxRaw) && maxRaw > 0 ? maxRaw : 0;

  const supabase = getSupabaseAdmin();
  const campaignParam = sp.get('campaign');

  const { data: campaignsData } = await supabase.from('campaigns').select('*').eq('active', true);
  let campaigns = (campaignsData ?? []) as unknown as CampaignRow[];
  if (campaignParam) {
    const cid = parseInt(campaignParam, 10);
    campaigns = campaigns.filter((c) => c.id === cid);
  }

  // Salvaguardie: invio reale SOLO con una campagna specificata + BATCH_ENABLED=true.
  const enabled = process.env.BATCH_ENABLED === 'true';
  if (!dry) {
    if (!campaignParam) {
      return NextResponse.json({ ok: true, skipped: 'campaign param richiesto per invio reale' });
    }
    if (!enabled) {
      return NextResponse.json({ ok: true, skipped: 'BATCH_ENABLED non attivo', campaigns: campaigns.length });
    }
  }

  const report: Record<string, unknown>[] = [];

  for (const campaign of campaigns) {
    // Solo campagne con ac_list_match numerico (= id lista AC).
    if (!/^\d+$/.test(campaign.ac_list_match)) {
      report.push({ campaign: campaign.name, skipped: 'ac_list_match non numerico' });
      continue;
    }

    const contacts = await fetchListContacts(campaign.ac_list_match);
    const sentPhones = await getSentPhones(supabase, campaign);
    const plan = planBatch(contacts, sentPhones);

    let target = plan.toSend;
    if (max > 0) target = target.slice(0, max);

    const base = {
      campaign: campaign.name,
      listId: campaign.ac_list_match,
      contactsTotal: contacts.length,
      invalidPhone: plan.invalidPhone.length,
      duplicates: plan.duplicates.length,
      alreadySent: plan.alreadySent.length,
      toSend: plan.toSend.length,
    };

    if (dry) {
      report.push({ ...base, mode: 'dry-run', wouldSend: target.length });
      continue;
    }

    const outcomes = await runPool(target, CONCURRENCY, (p) => sendOne(supabase, campaign, p));
    const sent = outcomes.filter((o) => o === 'sent').length;
    const failed = outcomes.filter((o) => o === 'failed').length;

    await supabase.from('event_log').insert({
      type: 'batch_send',
      payload: { ...base, attempted: target.length, sent, failed } as never,
      message: `Batch '${campaign.name}': inviati ${sent}, falliti ${failed} (su ${target.length})`,
      level: failed > 0 ? 'warn' : 'info',
    });

    report.push({ ...base, attempted: target.length, sent, failed });
  }

  return NextResponse.json({ ok: true, dry, enabled, report });
}
