import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import {
  decideTrackA,
  decideTrackB,
  pickNudgeText,
  lastOutboundAtMs,
  NUDGE1_MAX_H,
  type MsgLite,
} from '@/lib/sequence';
import { sendTemplate, sendFreeText, getTemplateBody } from '@/lib/twilio';
import { feniceOpening } from '@/lib/fenice-opening';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

type Supa = ReturnType<typeof getSupabaseAdmin>;

const H = 3600_000;
// Anti-doppione Track B: nessun nudge se l'ultimo out è più recente di 20h.
// (Per Track A il gap è già dentro decideTrackA.)
const MIN_GAP_OUT_MS = 20 * H;

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  if (req.headers.get('authorization') === `Bearer ${secret}`) return true;
  if (req.nextUrl.searchParams.get('secret') === secret) return true;
  return false;
}

/**
 * Come sendTemplateAndLog, ma con gestione del frequency cap Meta (63049):
 * in quel caso NON inserisce nessun messaggio (il touch non è consumato e
 * verrà ritentato al run successivo) e logga `sequence_freq_capped`.
 */
async function sendSequenceTemplate(
  supabase: Supa,
  conversationId: number,
  phone: string,
  templateSid: string,
  label: string,
  from: string | undefined,
  variables: Record<string, string>,
  bodyOverride?: string,
): Promise<{ ok: boolean; capped?: boolean; error?: string }> {
  const tplBody = bodyOverride ?? (await getTemplateBody(templateSid)) ?? `[template] ${label}`;
  try {
    const sent = await sendTemplate({ to: phone, contentSid: templateSid, variables, from });
    await supabase.from('messages').insert({
      conversation_id: conversationId,
      direction: 'out',
      body: tplBody,
      twilio_sid: sent.sid,
      twilio_status: sent.status,
      template_sid: templateSid,
      is_template: true,
    });
    await supabase
      .from('conversations')
      .update({ last_message_at: new Date().toISOString() })
      .eq('id', conversationId);
    return { ok: true };
  } catch (err: unknown) {
    const e = err as { message?: string; code?: number };
    if (e?.code === 63049) {
      await supabase.from('event_log').insert({
        type: 'sequence_freq_capped',
        payload: { conversationId, templateSid } as never,
        message: `[sequenza] frequency cap Meta su conv ${conversationId}: touch non consumato, ritento al prossimo run`,
        level: 'info',
      });
      return { ok: false, capped: true };
    }
    await supabase.from('messages').insert({
      conversation_id: conversationId,
      direction: 'out',
      body: tplBody,
      twilio_status: 'failed',
      twilio_error_code: e?.code ?? null,
      template_sid: templateSid,
      is_template: true,
    });
    return { ok: false, error: e?.message ?? 'unknown' };
  }
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return new NextResponse('unauthorized', { status: 401 });

  // Kill-switch: questa route fa SOLO invii, la classificazione resta a bot-followups.
  if (process.env.SEQUENCE_ENABLED !== '1') {
    return NextResponse.json({ ok: true, disabled: true });
  }

  const supabase = getSupabaseAdmin();
  const now = Date.now();

  const followupFrom =
    process.env.TWILIO_WHATSAPP_NUMBER_FOLLOWUP ?? process.env.TWILIO_WHATSAPP_NUMBER_FENICE;
  const openingFrom = process.env.TWILIO_WHATSAPP_NUMBER_FENICE;
  const openingSid = process.env.FENICE_OPENING_TEMPLATE_SID;
  const reengageSid = process.env.REENGAGE_TEMPLATE_SID;
  const maxPerRun = Math.max(1, Number(process.env.SEQUENCE_MAX_PER_RUN) || 25);

  // SID sequenza Track A: env SEQ_TEMPLATE_SID_1..4 (posizionali sui touch 1..4).
  const seqSidByIndex = [1, 2, 3, 4].map((i) => process.env[`SEQ_TEMPLATE_SID_${i}`]);
  const missingSeqIdx = [1, 2, 3, 4].filter((i) => !seqSidByIndex[i - 1]);
  const seqSids = seqSidByIndex.filter((s): s is string => !!s);
  if (missingSeqIdx.length) {
    // Una volta per run: i send_touch degli indici mancanti verranno saltati.
    await supabase.from('event_log').insert({
      type: 'sequence_config_error',
      payload: { missing: missingSeqIdx.map((i) => `SEQ_TEMPLATE_SID_${i}`) } as never,
      message: `[sequenza] SID template mancanti: ${missingSeqIdx.map((i) => `SEQ_TEMPLATE_SID_${i}`).join(', ')}`,
      level: 'error',
    });
  }
  const configLogged = new Set<string>();
  const logConfigError = async (key: string) => {
    if (configLogged.has(key)) return;
    configLogged.add(key);
    await supabase.from('event_log').insert({
      type: 'sequence_config_error',
      payload: { missing: [key] } as never,
      message: `[sequenza] env mancante: ${key}`,
      level: 'error',
    });
  };

  // Tutte le conv CRM attive, con paginazione (>1000 possibili a regime 50/g).
  const convs: any[] = [];
  for (let fromRow = 0; ; fromRow += 1000) {
    const { data } = await supabase
      .from('conversations')
      .select('id, ai_status, ai_started_at, crm_lead_id, bot_outcome, bot_followups_sent, leads(phone_e164, first_name)')
      .not('crm_lead_id', 'is', null)
      .in('ai_status', ['active'])
      .range(fromRow, fromRow + 999);
    const batch = data ?? [];
    convs.push(...batch);
    if (batch.length < 1000) break;
  }

  let sent = 0;
  let skipped = 0;
  let trackA = 0;
  let trackB = 0;

  for (const c of convs as any[]) {
    if (sent >= maxPerRun) break;
    try {
      const phone = c.leads?.phone_e164 as string | undefined;
      const firstName = (c.leads?.first_name as string | null | undefined) ?? null;
      if (!phone) {
        skipped++;
        continue;
      }
      // Conv con esito già inviato al CRM (es. riaperte dal webhook): mai toccare.
      if (c.bot_outcome != null) {
        skipped++;
        continue;
      }

      // Cronologia dall'arruolamento in poi (stesso pattern di bot-followups).
      let q = supabase
        .from('messages')
        .select('direction, twilio_status, template_sid, created_at, is_template')
        .eq('conversation_id', c.id)
        .order('created_at', { ascending: true })
        .limit(200);
      // Buffer 5': l'enroll inserisce l'apertura PRIMA di settare ai_started_at,
      // senza margine il filtro la escluderebbe (→ re-invio apertura).
      if (c.ai_started_at) {
        q = q.gte('created_at', new Date(Date.parse(c.ai_started_at) - 5 * 60_000).toISOString());
      }
      const { data: msgData } = await q;
      const msgs = (msgData ?? []) as MsgLite[];

      const hasInbound = msgs.some((m) => m.direction === 'in');

      if (!hasInbound) {
        // ── Track A: mai risposto ─────────────────────────────────────────
        trackA++;
        const action = decideTrackA({ nowMs: now, msgs, seqSids, sequenceEnabled: true });

        if (action.kind === 'send_opening') {
          if (!openingSid || !openingFrom) {
            await logConfigError(!openingSid ? 'FENICE_OPENING_TEMPLATE_SID' : 'TWILIO_WHATSAPP_NUMBER_FENICE');
            skipped++;
            continue;
          }
          const variables: Record<string, string> = firstName ? { '3': firstName } : {};
          sent++;
          await sendSequenceTemplate(
            supabase, c.id, phone, openingSid, 'Fenice apertura', openingFrom, variables, feniceOpening(firstName),
          );
        } else if (action.kind === 'send_touch') {
          const sid = seqSidByIndex[action.touchIndex - 1];
          if (!sid) {
            // Config error già loggato a inizio run: salta questo indice.
            skipped++;
            continue;
          }
          sent++;
          await sendSequenceTemplate(
            supabase, c.id, phone, sid, `Sequenza touch ${action.touchIndex}`, followupFrom, { '1': firstName ?? 'ciao' },
          );
        } else {
          // discard_dead / non_risposto li gestisce bot-followups; wait = niente.
          skipped++;
        }
        continue;
      }

      // ── Track B: ha risposto poi silenzio ───────────────────────────────
      trackB++;
      const lastInboundAtMs = msgs.reduce<number>(
        (acc, m) => (m.direction === 'in' ? Math.max(acc, Date.parse(m.created_at)) : acc),
        0,
      );
      const action = decideTrackB({
        nowMs: now,
        lastInboundAtMs,
        nudgesSent: (c.bot_followups_sent as number | null) ?? 0,
        sequenceEnabled: true,
      });

      if (action.kind !== 'nudge_free' && action.kind !== 'nudge_template') {
        // classify lo fa bot-followups; wait = niente.
        skipped++;
        continue;
      }

      // Anti-doppione: con nudgesSent=1 e silenzio in [48,96) il percorso normale
      // è indistinguibile da un recupero appena fatto → nessun nudge se l'ultimo
      // out è più recente di 20h.
      const lastOut = lastOutboundAtMs(msgs);
      if (lastOut !== null && now - lastOut < MIN_GAP_OUT_MS) {
        skipped++;
        continue;
      }

      if (action.kind === 'nudge_free') {
        // Ricontrolla la finestra 24h WhatsApp: fuori finestra niente free text.
        if (now - lastInboundAtMs >= NUDGE1_MAX_H * H) {
          skipped++;
          continue;
        }
        const body = pickNudgeText(c.id, firstName);
        sent++;
        const res = await sendFreeText({ to: phone, body, from: followupFrom });
        await supabase.from('messages').insert({
          conversation_id: c.id,
          direction: 'out',
          body,
          twilio_sid: res.sid,
          twilio_status: res.status,
          is_template: false,
        });
        await supabase
          .from('conversations')
          .update({
            last_message_at: new Date().toISOString(),
            bot_followups_sent: (((c.bot_followups_sent as number | null) ?? 0) + 1),
          })
          .eq('id', c.id);
      } else {
        if (!reengageSid) {
          await logConfigError('REENGAGE_TEMPLATE_SID');
          skipped++;
          continue;
        }
        sent++;
        const res = await sendSequenceTemplate(
          supabase, c.id, phone, reengageSid, `Riaggancio ${action.nudgeIndex}`, followupFrom, { '1': firstName ?? 'ciao' },
        );
        // Contatore nudge SOLO a invio riuscito (63049/errori → si ritenta).
        if (res.ok) {
          await supabase
            .from('conversations')
            .update({ bot_followups_sent: (((c.bot_followups_sent as number | null) ?? 0) + 1) })
            .eq('id', c.id);
        }
      }
    } catch (e) {
      await supabase.from('event_log').insert({
        type: 'sequence_touch_error',
        payload: { conversationId: c.id, error: e instanceof Error ? e.message : 'errore' } as never,
        message: `[sequenza] errore su conv ${c.id}: ${e instanceof Error ? e.message : 'errore'}`,
        level: 'error',
      });
    }
  }

  await supabase.from('event_log').insert({
    type: 'sequence_run',
    payload: { sent, skipped, trackA, trackB } as never,
    message: `[sequenza] run: ${sent} invii, ${skipped} skip (A=${trackA}, B=${trackB})`,
    level: 'info',
  });

  return NextResponse.json({ ok: true, sent, skipped, trackA, trackB });
}
