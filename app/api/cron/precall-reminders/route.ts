import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { sendTemplateAndLog } from '@/lib/messaging';
import { dueReminder, slotLabel, pickReminder24Template, type ReminderKind } from '@/lib/precall-reminders';
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
  // Variante "senza domanda sul video" del promemoria T-24h (Task 6): opzionale,
  // la sua assenza non blocca il cron. Finché non è configurata si comporta
  // esattamente come oggi (pickReminder24Template ricade sempre su sid24).
  const novideoSid = process.env.REMINDER_24H_NOVIDEO_TEMPLATE_SID ?? null;
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
    // Fermo manuale dal pannello: nessun invio automatico su una chat presa in
    // carico da una persona, promemoria pre-call compresi.
    .is('ai_paused_at', null)
    .gte('bot_scheduled_at', windowStart)
    .lte('bot_scheduled_at', windowEnd);

  const convs = (convData ?? []) as any[];

  let sent = 0;
  let skipped = 0;
  let failed = 0; // solo per decidere se loggare il summary (come send-video), non esposto in risposta

  if (convs.length > 0) {
    const convIds = convs.map((c) => c.id as number);

    // Un'unica query per sapere quali promemoria sono già stati inviati su queste
    // conversazioni: idempotenza derivata da messages.template_sid. Le righe
    // 'failed'/'undelivered' NON contano come "già inviato" (stesso filtro di
    // send-video, stesso raggruppamento di allOutboundDeadNoDelivery in
    // lib/sequence.ts): un fallimento transitorio va ritentato al run successivo,
    // non perso per sempre — qui non c'è un domani dopo la finestra dei 15'.
    // L'R24 ha due possibili SID (standard e "senza domanda sul video", Task 6):
    // entrambi contano come "R24 già inviato", altrimenti un lead a cui è già
    // partita la variante novideo si ritroverebbe anche lo standard.
    const r24Sids = [sid24, ...(novideoSid ? [novideoSid] : [])];
    const { data: sentMsgs } = await supabase
      .from('messages')
      .select('conversation_id, template_sid')
      .in('conversation_id', convIds)
      .in('template_sid', [...r24Sids, sid3])
      .not('twilio_status', 'in', '(failed,undelivered)');

    const sentByConv = new Map<number, ReminderKind[]>();
    for (const m of (sentMsgs ?? []) as any[]) {
      const kind: ReminderKind | null =
        r24Sids.includes(m.template_sid) ? 'r24' : m.template_sid === sid3 ? 'r3' : null;
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

      let sid = sid3;
      if (kind === 'r24') {
        // Due segnali che il lead ha già visto il video (Task 6): il tag
        // [VIDEO_VISTO] persistito in event_log, oppure — più grossolano ma
        // affidabile quando il tag non è stato emesso — un inbound arrivato
        // dopo l'ultimo link del video mandato in conversazione.
        const { data: vw } = await supabase
          .from('event_log')
          .select('id')
          .eq('type', 'video_watched')
          .eq('payload->>conversationId', String(c.id))
          .limit(1);

        const { data: videoMsg } = await supabase
          .from('messages')
          .select('created_at')
          .eq('conversation_id', c.id)
          .eq('direction', 'out')
          .ilike('body', '%corso.feniceacademy.it/conferenza-%')
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();

        let inboundAfterVideoMs: number | null = null;
        if (videoMsg?.created_at) {
          const { data: dopo } = await supabase
            .from('messages')
            .select('created_at')
            .eq('conversation_id', c.id)
            .eq('direction', 'in')
            .gt('created_at', videoMsg.created_at)
            .limit(1)
            .maybeSingle();
          if (dopo?.created_at) inboundAfterVideoMs = Date.parse(dopo.created_at);
        }

        sid = pickReminder24Template({
          hasVideoWatchedEvent: (vw ?? []).length > 0,
          inboundAfterVideoMs,
          novideoSid,
          defaultSid: sid24,
        });
      }
      const label = kind === 'r24' ? 'Promemoria T-24h' : 'Promemoria T-3h';
      const firstName = (c.leads?.first_name as string | null | undefined) ?? null;

      const res = await sendTemplateAndLog(supabase, c.id as number, phone, sid, label, from, {
        '1': templateName(firstName),
        '2': slotLabel(scheduledAt, now),
      });
      if (res.ok) sent++;
      else {
        skipped++;
        failed++;
      }
    }
  }

  // Come send-video: nessun event_log se il run non ha fatto nulla.
  if (sent > 0 || failed > 0) {
    await supabase.from('event_log').insert({
      type: 'precall_reminders',
      payload: { sent, skipped } as never,
      message: `[precall] run: ${sent} invii, ${skipped} skip`,
      level: 'info',
    });
  }

  return NextResponse.json({ ok: true, sent, skipped });
}
