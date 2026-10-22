import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { sendTemplateAndLog } from '@/lib/messaging';
import {
  dueReminder, slotLabel, pickReminder24Template, type ReminderKind,
  decideGdoReminder24, gdoReminderVars, gdoReminderText,
} from '@/lib/precall-reminders';
import { sendFreeText } from '@/lib/twilio';
import { templateName } from '@/lib/name';
import { FILTRO_FUORI_LANCIO } from '@/lib/lancio-fase';
import { logCronQueryError } from '@/lib/cron-query-error';
import { mittenteDiConversazione } from '@/lib/mittente';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

// Promemoria pre-call: T-24h e T-3h prima di una videocall già fissata dal bot
// (bot_outcome = 'APPUNTAMENTO'). L'appuntamento è terminale: questa route fa
// SOLO invii + event_log, non scrive mai su conversations (né bot_outcome, né
// bot_scheduled_at, né ai_status). "Già inviato" si deriva dalla presenza di
// messages.template_sid = sid promemoria sulla stessa conversazione — nessuna
// colonna nuova, stesso pattern di send-video/sequence-touches.
//
// Secondo ramo, con interruttore suo (GDO_PRECALL_24H_ENABLED): il solo T-24h per i
// lead fissati da un GDO, vedi `promemoriaGdo` in fondo.

const H = 3600_000;

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  if (req.headers.get('authorization') === `Bearer ${secret}`) return true;
  if (req.nextUrl.searchParams.get('secret') === secret) return true;
  return false;
}

type Supa = ReturnType<typeof getSupabaseAdmin>;
type EsitoRamo = { sent: number; skipped: number; config?: true };

export async function GET(req: NextRequest) {
  if (!authorized(req)) return new NextResponse('unauthorized', { status: 401 });

  // Due rami, ognuno col suo interruttore: i promemoria degli appuntamenti fissati dal
  // bot (T-24h e T-3h) e il T-24h dei lead fissati da un GDO, con dentro Noemi.
  const botAcceso = process.env.PRECALL_REMINDERS_ENABLED === '1';
  const gdoAcceso = process.env.GDO_PRECALL_24H_ENABLED === '1';

  // Kill-switch: uscita immediata, prima di toccare Supabase o Twilio.
  if (!botAcceso && !gdoAcceso) {
    return NextResponse.json({ ok: true, skipped: 'disabled' });
  }

  const supabase = getSupabaseAdmin();
  const now = Date.now();
  const bot = botAcceso ? await promemoriaBot(supabase, now) : null;
  const gdo = gdoAcceso ? await promemoriaGdo(supabase, now) : null;

  // Col solo ramo del bot acceso la risposta resta quella di sempre.
  const base = bot
    ? bot.config
      ? { ok: true, sent: 0, skipped: 'config' }
      : { ok: true, sent: bot.sent, skipped: bot.skipped }
    : { ok: true, sent: 0, skipped: 0 };
  return NextResponse.json(gdo ? { ...base, gdo } : base);
}

/** Promemoria T-24h e T-3h degli appuntamenti fissati dal bot (bot_outcome = 'APPUNTAMENTO'). */
async function promemoriaBot(supabase: Supa, now: number): Promise<EsitoRamo> {
  const sid24 = process.env.REMINDER_24H_TEMPLATE_SID;
  const sid3 = process.env.REMINDER_3H_TEMPLATE_SID;
  // Variante "senza domanda sul video" del promemoria T-24h (Task 6): opzionale,
  // la sua assenza non blocca il cron. Finché non è configurata si comporta
  // esattamente come oggi (pickReminder24Template ricade sempre su sid24).
  const novideoSid = process.env.REMINDER_24H_NOVIDEO_TEMPLATE_SID ?? null;

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
    return { sent: 0, skipped: 0, config: true };
  }

  // Il mittente e' quello della singola chat (`wa_number`, letto sotto, vedi
  // lib/mittente.ts): un promemoria da un altro numero arriverebbe al lead come un
  // thread nuovo. `TWILIO_WHATSAPP_NUMBER_FOLLOWUP` non si legge piu' per lo stesso
  // motivo: un numero "dei follow-up" diverso da quello della chat e' proprio il
  // thread spezzato che questa regola chiude.

  const windowStart = new Date(now - 1 * H).toISOString();
  const windowEnd = new Date(now + 30 * H).toISOString();

  // Appuntamenti fissati (terminali) la cui data cade nella finestra utile ai promemoria.
  const { data: convData, error: convErr } = await supabase
    .from('conversations')
    .select('id, bot_scheduled_at, wa_number, leads(phone_e164, first_name)')
    .eq('bot_outcome', 'APPUNTAMENTO')
    // Fermo manuale dal pannello: nessun invio automatico su una chat presa in
    // carico da una persona, promemoria pre-call compresi.
    .is('ai_paused_at', null)
    // Il lead ha chiesto di annullare o spostare: un "ti ricordo la call di domani"
    // dopo che gli abbiamo detto "me lo segno" è la cosa che ha prodotto le risposte
    // peggiori ("avevo chiesto di rimandare"). 10 casi su 23 misurati il 04/08/2026.
    .is('cancel_requested_at', null)
    // Lancio: gli appuntamenti del lancio li fissa il CRM (B3/B4), i promemoria non
    // partono da qui.
    .or(FILTRO_FUORI_LANCIO)
    .gte('bot_scheduled_at', windowStart)
    .lte('bot_scheduled_at', windowEnd);
  if (convErr) await logCronQueryError(supabase, 'precall_reminders_query_error', convErr);

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

      const res = await sendTemplateAndLog(supabase, c.id as number, phone, sid, label, mittenteDiConversazione(c), {
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

  return { sent, skipped };
}

/**
 * Promemoria del giorno prima per i lead fissati da un GDO: solo T-24h (il T-3h resta
 * del bot), con dentro la chiamata di Noemi. Mai sulle chat con bot_outcome =
 * 'APPUNTAMENTO', che hanno già i promemoria del ramo sopra. "Già inviato" sta in
 * event_log (`gdo_reminder24_sent`) per conversazione E data della call: uno
 * spostamento della call riapre il promemoria.
 */
async function promemoriaGdo(supabase: Supa, now: number): Promise<EsitoRamo> {
  const sidGdo = process.env.GDO_REMINDER_24H_TEMPLATE_SID;
  if (!sidGdo) {
    await supabase.from('event_log').insert({
      type: 'precall_reminders_config_error',
      payload: { missing: ['GDO_REMINDER_24H_TEMPLATE_SID'] } as never,
      message: '[precall] SID template promemoria GDO mancante: ramo GDO saltato',
      level: 'error',
    });
    return { sent: 0, skipped: 0, config: true };
  }

  const { data: convData, error: convErr } = await supabase
    .from('conversations')
    .select('id, gdo_agenda_at, gdo_appuntamento_at, gdo_video_sent_at, gdo_recap_sent_at, bot_outcome, ai_paused_at, cancel_requested_at, wa_number, leads(phone_e164, first_name)')
    .not('gdo_agenda_at', 'is', null)
    // Gli appuntamenti del bot hanno già i loro promemoria (ramo sopra).
    .or('bot_outcome.is.null,bot_outcome.neq.APPUNTAMENTO')
    .is('ai_paused_at', null)
    .is('cancel_requested_at', null)
    .or(FILTRO_FUORI_LANCIO)
    .gte('gdo_appuntamento_at', new Date(now - 1 * H).toISOString())
    .lte('gdo_appuntamento_at', new Date(now + 30 * H).toISOString());
  if (convErr) await logCronQueryError(supabase, 'precall_reminders_gdo_query_error', convErr);

  let sent = 0;
  let skipped = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const c of (convData ?? []) as any[]) {
    const phone = c.leads?.phone_e164 as string | undefined;
    const callMs = c.gdo_appuntamento_at ? Date.parse(c.gdo_appuntamento_at) : NaN;
    if (!phone || Number.isNaN(callMs)) {
      skipped++;
      continue;
    }
    // La chiave di "già inviato" si scrive e si cerca sempre nella stessa forma (ISO
    // UTC): due scritture dello stesso istante non sono uguali come testo.
    const appuntamentoAt = new Date(callMs).toISOString();

    const { data: giaInviati, error: giaErr } = await supabase
      .from('event_log')
      .select('id')
      .eq('type', 'gdo_reminder24_sent')
      .eq('payload->>conversationId', String(c.id))
      .eq('payload->>appuntamentoAt', appuntamentoAt)
      .limit(1);
    if (giaErr) {
      // Senza sapere se è già partito non si rischia un doppio promemoria.
      await logCronQueryError(supabase, 'precall_reminders_gdo_query_error', giaErr);
      skipped++;
      continue;
    }

    const { data: ultimoIn } = await supabase
      .from('messages')
      .select('created_at')
      .eq('conversation_id', c.id)
      .eq('direction', 'in')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    const canale = decideGdoReminder24({
      enabled: true,
      gdoAgendaAt: c.gdo_agenda_at ?? null,
      botOutcome: c.bot_outcome ?? null,
      appuntamentoAt,
      videoSentAt: c.gdo_video_sent_at ?? null,
      recapSentAt: c.gdo_recap_sent_at ?? null,
      lastInboundAtMs: ultimoIn?.created_at ? Date.parse(ultimoIn.created_at) : null,
      aiPausedAt: c.ai_paused_at ?? null,
      cancelRequestedAt: c.cancel_requested_at ?? null,
      giaInviato: (giaInviati ?? []).length > 0,
      nowMs: now,
    });
    if (!canale) {
      skipped++;
      continue;
    }

    const vars = gdoReminderVars({ nome: c.leads?.first_name ?? null, call: new Date(callMs), nowMs: now });
    const body = gdoReminderText(vars);
    const from = mittenteDiConversazione(c);
    let ok = false;

    if (canale === 'template') {
      // In messages va il testo vero, non quello del template coi segnaposto: il
      // modello rilegge la chat e deve vedere cosa ha ricevuto il lead.
      const res = await sendTemplateAndLog(supabase, c.id as number, phone, sidGdo, 'Promemoria T-24h GDO', from, vars, body);
      ok = res.ok;
    } else {
      let tw: { sid?: string; status?: string } | null = null;
      try {
        tw = await sendFreeText({ to: phone, body, from });
      } catch (err: unknown) {
        const e = err as { message?: string };
        await supabase.from('event_log').insert({
          type: 'gdo_reminder24_error',
          payload: { conversationId: c.id, appuntamentoAt, canale } as never,
          message: `[precall] conv ${c.id}: promemoria GDO in testo libero non partito — ${e?.message ?? 'errore ignoto'}`,
          level: 'error',
        });
      }
      if (tw) {
        ok = true;
        await supabase.from('messages').insert({
          conversation_id: c.id, direction: 'out', body,
          twilio_sid: tw.sid, twilio_status: tw.status,
          sender: 'bot',
        });
        await supabase.from('conversations')
          .update({ last_message_at: new Date().toISOString() })
          .eq('id', c.id);
      }
    }

    if (!ok) {
      skipped++;
      continue;
    }
    sent++;
    await supabase.from('event_log').insert({
      type: 'gdo_reminder24_sent',
      payload: { conversationId: c.id, appuntamentoAt, canale } as never,
      message: `[precall] conv ${c.id}: promemoria GDO del giorno prima (${canale})`,
      level: 'info',
    });
  }
  return { sent, skipped };
}
