import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { sendTemplateAndLog } from '@/lib/messaging';
import { sendFreeText } from '@/lib/twilio';
import { generateMarioReply, type MarioTurn } from '@/lib/mario';
import { gdoContextNote } from '@/lib/gdo-context-note';
import { gdoVideoText } from '@/lib/gdo-agenda';
import { decideGdoVideoFollowup, VIDEO_TEMPLATE_ENV_BY_LINK, type GdoSlot } from '@/lib/gdo-video-followup';
import { romeHour, romeMinute, romeDaysBetween } from '@/lib/rome-time';
import { templateName } from '@/lib/name';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// Solleciti del video ai lead dei GDO: due touch ancorati al giorno dell'agenda —
// 21:30 quel giorno, 10:00 il giorno dopo. Chi non ha mai risposto riceve il video
// (finestra chiusa ⇒ template); chi ha risposto riceve un sollecito, scritto dal
// modello se la finestra è aperta. Questa rotta NON tocca mai bot_outcome, ai_status
// né gli altri campi del lead: è di un GDO, non nostro.

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  if (req.headers.get('authorization') === `Bearer ${secret}`) return true;
  if (req.nextUrl.searchParams.get('secret') === secret) return true;
  return false;
}

/** Lo slot italiano di adesso, o null se non è né le 21:30 né le 10:00. */
function slotOf(now: Date): GdoSlot | null {
  const h = romeHour(now);
  const m = romeMinute(now);
  if (h === 21 && m === 30) return 'sera';
  if (h === 10 && m === 0) return 'mattina';
  return null;
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return new NextResponse('unauthorized', { status: 401 });

  // Kill-switch, prima di toccare Supabase o Twilio.
  if (process.env.GDO_VIDEO_FOLLOWUPS_ENABLED !== '1') {
    return NextResponse.json({ ok: true, skipped: 'disabled' });
  }

  const now = new Date();
  const slot = slotOf(now);
  // Il cron gira a maglia larga (ogni mezz'ora) e agisce solo nei due slot: così il
  // cambio dell'ora legale non sposta gli orari italiani.
  if (!slot) return NextResponse.json({ ok: true, skipped: 'fuori slot' });

  const from = process.env.TWILIO_WHATSAPP_NUMBER_FENICE;
  const solleciteSid = process.env.SOLLECITO_VIDEO_GDO_SID;
  const supabase = getSupabaseAdmin();
  if (!from) {
    await supabase.from('event_log').insert({
      type: 'gdo_followup_config_error',
      payload: { missing: 'TWILIO_WHATSAPP_NUMBER_FENICE' } as never,
      message: '[gdo] numero mittente mancante: run saltato',
      level: 'error',
    });
    return NextResponse.json({ ok: true, sent: 0, skipped: 'config' });
  }

  // Gli slot utili sono solo quelli di oggi e ieri; qui si pesca con tre giorni di
  // margine (il fuso e i bordi di mezzanotte non devono tagliare fuori nessuno) e
  // decideGdoVideoFollowup scarta il resto con `giorniDaAgenda`.
  const da = new Date(Date.now() - 3 * 86400_000).toISOString();
  const { data } = await supabase
    .from('conversations')
    .select(`
      id, gdo_agenda_at, gdo_video_url, gdo_video_sent_at, gdo_video_watched_at,
      gdo_video_followups_sent, gdo_noemi_reminded_at, gdo_appuntamento_at, ai_started_at,
      leads(phone_e164, first_name)
    `)
    .not('gdo_agenda_at', 'is', null)
    .gte('gdo_agenda_at', da)
    .limit(500);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const convs = (data ?? []) as any[];
  const report: Record<string, unknown>[] = [];
  let sent = 0;

  for (const c of convs) {
    try {
      const phone = c.leads?.phone_e164 as string | undefined;
      if (!phone) { report.push({ id: c.id, action: 'skip', reason: 'no_phone' }); continue; }

      // Cronologia dall'arruolamento in poi (stesso pattern di bot-followups e
      // sequence-touches): il cutoff sta nella query, non dopo in JS, perché
      // `lastInboundAtMs`/`lastMessageIsInbound` — che alimentano la decisione —
      // devono guardare la coda della sola conversazione col GDO, non quella di
      // un eventuale funnel Mario precedente sullo stesso numero.
      let msgsQuery = supabase
        .from('messages')
        .select('direction, body, created_at')
        .eq('conversation_id', c.id)
        .order('created_at', { ascending: true })
        .limit(200);
      // Buffer 5': l'enroll inserisce l'apertura PRIMA di settare ai_started_at,
      // senza margine il filtro la escluderebbe.
      if (c.ai_started_at) {
        msgsQuery = msgsQuery.gte(
          'created_at',
          new Date(Date.parse(c.ai_started_at) - 5 * 60_000).toISOString(),
        );
      }
      const { data: msgs } = await msgsQuery;
      const rows = (msgs ?? []) as { direction: string; body: string; created_at: string }[];
      const inbound = rows.filter((m) => m.direction === 'in');
      const lastInboundAtMs = inbound.length ? Date.parse(inbound[inbound.length - 1].created_at) : null;
      const lastMessageIsInbound = rows.length > 0 && rows[rows.length - 1].direction === 'in';

      const agendaAt = new Date(c.gdo_agenda_at);
      const action = decideGdoVideoFollowup({
        gdoAgendaAt: c.gdo_agenda_at,
        gdoVideoSentAt: c.gdo_video_sent_at,
        gdoVideoWatchedAt: c.gdo_video_watched_at,
        followupsSent: c.gdo_video_followups_sent ?? 0,
        appointmentAt: c.gdo_appuntamento_at,
        lastInboundAtMs,
        lastMessageIsInbound,
        nowMs: now.getTime(),
        slot,
        giorniDaAgenda: romeDaysBetween(agendaAt, now),
        romeHourAgenda: romeHour(agendaAt),
      });

      if (action === 'none') { report.push({ id: c.id, action: 'none' }); continue; }

      const nome = c.leads?.first_name ?? null;
      let inviato = false;

      if (action === 'video-template') {
        const link = c.gdo_video_url as string | null;
        const envName = link ? VIDEO_TEMPLATE_ENV_BY_LINK[link] : undefined;
        const sid = envName ? process.env[envName] : undefined;
        if (!sid) {
          // Fail-closed: non si ripiega su un altro template e non si inventa un link.
          await supabase.from('event_log').insert({
            type: 'gdo_followup_template_missing',
            payload: { conversationId: c.id, link, envName } as never,
            message: `[gdo] conv ${c.id}: nessun template video per la variante, sollecito saltato`,
            level: 'error',
          });
          report.push({ id: c.id, action, skipped: 'no_template' });
          continue;
        }
        const res = await sendTemplateAndLog(
          supabase, c.id, phone, sid, 'video gdo', from,
          { 1: templateName(nome) },
          gdoVideoText(nome, link as string),
        );
        inviato = res.ok;
        if (res.ok) {
          await supabase.from('conversations')
            .update({ gdo_video_sent_at: new Date().toISOString() })
            .eq('id', c.id);
        }
      }

      if (action === 'sollecito-template') {
        if (!solleciteSid) {
          await supabase.from('event_log').insert({
            type: 'gdo_followup_template_missing',
            payload: { conversationId: c.id, envName: 'SOLLECITO_VIDEO_GDO_SID' } as never,
            message: `[gdo] conv ${c.id}: template del sollecito non configurato, sollecito saltato`,
            level: 'error',
          });
          report.push({ id: c.id, action, skipped: 'no_template' });
          continue;
        }
        const res = await sendTemplateAndLog(
          supabase, c.id, phone, solleciteSid, 'sollecito video gdo', from,
          { 1: templateName(nome) },
        );
        inviato = res.ok;
      }

      if (action === 'sollecito-libero') {
        // Il sollecito lo scrive il modello dentro il contesto della chat: se il lead
        // stava parlando d'altro, Marta risponde a quello e aggancia il video.
        // `rows` è già tagliata dall'arruolamento in poi (query sopra): niente da
        // rifiltrare qui.
        const history: MarioTurn[] = rows
          .map((m) => ({ role: m.direction === 'in' ? 'user' : 'assistant', content: m.body }));
        const result = await generateMarioReply(history, {
          personaName: 'Marta',
          contextNote: gdoContextNote({
            gdoVideoSentAt: c.gdo_video_sent_at,
            gdoVideoWatchedAt: c.gdo_video_watched_at,
            gdoNoemiRemindedAt: c.gdo_noemi_reminded_at,
            followupsSent: c.gdo_video_followups_sent ?? 0,
            videoAppenaConfermato: false,
          }),
        });
        const body = result.visibleReply?.trim();
        if (body) {
          const twilio = await sendFreeText({ to: phone, body, from });
          await supabase.from('messages').insert({
            conversation_id: c.id, direction: 'out', body,
            twilio_sid: twilio.sid, twilio_status: twilio.status,
            sender: 'bot',
          });
          await supabase.from('conversations')
            .update({ last_message_at: new Date().toISOString() })
            .eq('id', c.id);
          inviato = true;
        }
      }

      if (inviato) {
        sent++;
        await supabase.from('conversations')
          .update({ gdo_video_followups_sent: (c.gdo_video_followups_sent ?? 0) + 1 })
          .eq('id', c.id);
        await supabase.from('event_log').insert({
          type: 'gdo_video_followup_sent',
          payload: { conversationId: c.id, phone, slot, action } as never,
          message: `[gdo] ${action} inviato a ${phone} (slot ${slot})`,
          level: 'info',
        });
      }
      report.push({ id: c.id, action, inviato });
    } catch (err: unknown) {
      // Un lead che esplode non deve fermare il giro degli altri.
      const e = err as { message?: string };
      await supabase.from('event_log').insert({
        type: 'gdo_followup_error',
        payload: { conversationId: c.id } as never,
        message: `[gdo] conv ${c.id}: sollecito fallito — ${e?.message ?? 'errore ignoto'}`,
        level: 'error',
      });
      report.push({ id: c.id, action: 'error' });
    }
  }

  return NextResponse.json({ ok: true, slot, candidati: convs.length, sent, report });
}
