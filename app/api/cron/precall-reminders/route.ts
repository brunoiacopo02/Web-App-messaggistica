import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { sendTemplateAndLog } from '@/lib/messaging';
import { dueReminder, slotLabel, type ReminderKind } from '@/lib/precall-reminders';
import { templateName } from '@/lib/name';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

// Promemoria pre-call: T-24h e T-3h prima di una videocall già fissata dal bot
// (bot_outcome = 'APPUNTAMENTO'). L'appuntamento è terminale: questa route fa
// SOLO invii + event_log, non scrive mai su conversations (né bot_outcome, né
// bot_scheduled_at, né ai_status). "Già inviato" si deriva dalla presenza di
// messages.template_sid = sid promemoria sulla stessa conversazione — nessuna
// colonna nuova, stesso pattern di send-video/sequence-touches.

const H = 3600_000;

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  if (req.headers.get('authorization') === `Bearer ${secret}`) return true;
  if (req.nextUrl.searchParams.get('secret') === secret) return true;
  return false;
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return new NextResponse('unauthorized', { status: 401 });

  // Kill-switch: uscita immediata, prima di toccare Supabase o Twilio.
  if (process.env.PRECALL_REMINDERS_ENABLED !== '1') {
    return NextResponse.json({ ok: true, skipped: 'disabled' });
  }

  const sid24 = process.env.REMINDER_24H_TEMPLATE_SID;
  const sid3 = process.env.REMINDER_3H_TEMPLATE_SID;
  const supabase = getSupabaseAdmin();

  if (!sid24 || !sid3) {
    await supabase.from('event_log').insert({
      type: 'precall_reminders_config_error',
      payload: {
        missing: [
          !sid24 ? 'REMINDER_24H_TEMPLATE_SID' : null,
          !sid3 ? 'REMINDER_3H_TEMPLATE_SID' : null,
        ].filter(Boolean),
      } as never,
      message: '[precall] SID template promemoria mancanti (Task 2 non ancora eseguito su Meta): run saltato',
      level: 'error',
    });
    return NextResponse.json({ ok: true, sent: 0, skipped: 'config' });
  }

  // Stesso numero Fenice usato dai follow-up della sequenza (sequence-touches).
  const from =
    process.env.TWILIO_WHATSAPP_NUMBER_FOLLOWUP ?? process.env.TWILIO_WHATSAPP_NUMBER_FENICE;

  const now = Date.now();
  const windowStart = new Date(now - 1 * H).toISOString();
  const windowEnd = new Date(now + 30 * H).toISOString();

  // Appuntamenti fissati (terminali) la cui data cade nella finestra utile ai promemoria.
  const { data: convData } = await supabase
    .from('conversations')
    .select('id, bot_scheduled_at, leads(phone_e164, first_name)')
    .eq('bot_outcome', 'APPUNTAMENTO')
    .gte('bot_scheduled_at', windowStart)
    .lte('bot_scheduled_at', windowEnd);

  const convs = (convData ?? []) as any[];

  let sent = 0;
  let skipped = 0;

  if (convs.length > 0) {
    const convIds = convs.map((c) => c.id as number);

    // Un'unica query per sapere quali promemoria sono già stati inviati su queste
    // conversazioni: idempotenza derivata da messages.template_sid.
    const { data: sentMsgs } = await supabase
      .from('messages')
      .select('conversation_id, template_sid')
      .in('conversation_id', convIds)
      .in('template_sid', [sid24, sid3]);

    const sentByConv = new Map<number, ReminderKind[]>();
    for (const m of (sentMsgs ?? []) as any[]) {
      const kind: ReminderKind | null =
        m.template_sid === sid24 ? 'r24' : m.template_sid === sid3 ? 'r3' : null;
      if (!kind) continue;
      const list = sentByConv.get(m.conversation_id) ?? [];
      list.push(kind);
      sentByConv.set(m.conversation_id, list);
    }

    for (const c of convs) {
      const phone = c.leads?.phone_e164 as string | undefined;
      const scheduledAtRaw = c.bot_scheduled_at as string | null;
      const scheduledAt = scheduledAtRaw ? Date.parse(scheduledAtRaw) : NaN;
      if (!phone || Number.isNaN(scheduledAt)) {
        skipped++;
        continue;
      }

      const already = sentByConv.get(c.id as number) ?? [];
      const kind = dueReminder(scheduledAt, now, already);
      if (!kind) {
        skipped++;
        continue;
      }

      const sid = kind === 'r24' ? sid24 : sid3;
      const label = kind === 'r24' ? 'Promemoria T-24h' : 'Promemoria T-3h';
      const firstName = (c.leads?.first_name as string | null | undefined) ?? null;

      const res = await sendTemplateAndLog(supabase, c.id as number, phone, sid, label, from, {
        '1': templateName(firstName),
        '2': slotLabel(scheduledAt, now),
      });
      if (res.ok) sent++;
      else skipped++;
    }
  }

  await supabase.from('event_log').insert({
    type: 'precall_reminders',
    payload: { sent, skipped } as never,
    message: `[precall] run: ${sent} invii, ${skipped} skip`,
    level: 'info',
  });

  return NextResponse.json({ ok: true, sent, skipped });
}
