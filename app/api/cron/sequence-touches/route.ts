import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import {
  decideTrackA,
  decideTrackB,
  pickNudgeText,
  firstOutboundAtMs,
  lastOutboundAtMs,
  toRomeIso,
  NUDGE1_MAX_H,
  SEQUENCE_END_DAYS,
  type MsgLite,
} from '@/lib/sequence';
import { sendOutcome } from '@/lib/bot-outcome';
import { sendTemplate, sendFreeText, getTemplateBody } from '@/lib/twilio';
import { feniceOpening } from '@/lib/fenice-opening';
import {
  personaForConversation,
  normalizeFunnel,
  variantIndexFor,
  openingEnvKey,
  openingBody,
  PERSONA_NAME,
} from '@/lib/persona';
import { firstNameOf, templateName } from '@/lib/name';

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
  // Variante Marta (posizionale come i legacy). Possono mancare finché il nuovo
  // flusso è spento: il config-error a inizio run resta SOLO sui legacy.
  const martaSeqSidByIndex = [1, 2, 3, 4].map((i) => process.env[`MARTA_SEQ_TEMPLATE_SID_${i}`]);
  const martaReengageSid = process.env.MARTA_REENGAGE_TEMPLATE_SID;
  // Tutti i SID "Marta" (aperture A/B + sequenza + riaggancio): servono a derivare
  // la persona di una conversazione dal primo template outbound.
  const martaOpeningSids = ['C1', 'C2', 'T1', 'T2', 'J1', 'J2'].map(
    (k) => process.env[`OPENING_SID_${k}`],
  );
  const martaSids = new Set(
    [...martaOpeningSids, ...martaSeqSidByIndex, martaReengageSid].filter((s): s is string => !!s),
  );
  const missingSeqIdx = [1, 2, 3, 4].filter((i) => !seqSidByIndex[i - 1]);
  // Il CONTEGGIO dei touch considera entrambe le varianti (legacy + Marta).
  const seqSids = [...seqSidByIndex, ...martaSeqSidByIndex].filter((s): s is string => !!s);
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
  const openingLogged = new Set<string>();
  const logOpeningConfigError = async (key: string) => {
    if (openingLogged.has(key)) return;
    openingLogged.add(key);
    await supabase.from('event_log').insert({
      type: 'opening_config_error',
      payload: { missing: [key] } as never,
      message: `[sequenza] env apertura mancante: ${key} — fallback all'apertura legacy`,
      level: 'error',
    });
  };
  const newOpeningEnabled = process.env.NEW_OPENING_ENABLED === '1';

  // Tutte le conv CRM attive, con paginazione (>1000 possibili a regime 50/g).
  const convs: any[] = [];
  for (let fromRow = 0; ; fromRow += 1000) {
    const { data } = await supabase
      .from('conversations')
      .select('id, ai_status, ai_started_at, crm_lead_id, crm_funnel, bot_outcome, bot_followups_sent, leads(phone_e164, first_name)')
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

      // Persona della conversazione (dal primo template outbound): le conv aperte
      // da Mario restano Mario, quelle aperte con i template Marta restano Marta.
      const persona = personaForConversation(msgs, martaSids);

      const hasInbound = msgs.some((m) => m.direction === 'in');

      if (!hasInbound) {
        // ── Track A: mai risposto ─────────────────────────────────────────
        trackA++;
        const action = decideTrackA({ nowMs: now, msgs, seqSids, sequenceEnabled: true });

        if (action.kind === 'send_opening') {
          if (!openingFrom) {
            await logConfigError('TWILIO_WHATSAPP_NUMBER_FENICE');
            skipped++;
            continue;
          }
          if (newOpeningEnabled) {
            // Nuove aperture per-funnel A/B (persona Marta), stessa selezione dell'enroll.
            const funnel = normalizeFunnel(c.crm_funnel as string | null | undefined);
            const variant = variantIndexFor(c.id);
            const envKey = openingEnvKey(funnel, variant);
            const newSid = process.env[envKey];
            if (newSid) {
              sent++;
              await sendSequenceTemplate(
                supabase, c.id, phone, newSid, `Apertura ${envKey}`, openingFrom,
                { '1': templateName(firstName) },
                openingBody(funnel, variant, firstName),
              );
              continue;
            }
            // SID mancante → una volta per run l'errore, poi fallback all'apertura legacy.
            await logOpeningConfigError(envKey);
          }
          if (!openingSid) {
            await logConfigError('FENICE_OPENING_TEMPLATE_SID');
            skipped++;
            continue;
          }
          const cleanName = firstNameOf(firstName);
          const variables: Record<string, string> = cleanName ? { '3': cleanName } : {};
          sent++;
          await sendSequenceTemplate(
            supabase, c.id, phone, openingSid, 'Fenice apertura', openingFrom, variables, feniceOpening(firstName),
          );
        } else if (action.kind === 'send_touch') {
          const sid =
            persona === 'marta'
              ? martaSeqSidByIndex[action.touchIndex - 1]
              : seqSidByIndex[action.touchIndex - 1];
          if (!sid) {
            // Legacy: config error già loggato a inizio run. Marta: log una volta per run.
            if (persona === 'marta') {
              await logConfigError(`MARTA_SEQ_TEMPLATE_SID_${action.touchIndex}`);
            }
            skipped++;
            continue;
          }
          sent++;
          const touchRes = await sendSequenceTemplate(
            supabase, c.id, phone, sid, `Sequenza touch ${action.touchIndex}`, followupFrom, { '1': templateName(firstName) },
          );
          // Dopo il primo follow-up riuscito: RICHIAMO interim (una volta sola,
          // perché il touch 1 parte una volta sola) con data = fine sequenza, così
          // il CRM vede il lead "in lavorazione estesa" con la data del termine.
          if (touchRes.ok && action.touchIndex === 1) {
            const t0 = firstOutboundAtMs(msgs);
            if (t0 !== null) {
              await sendOutcome(supabase, c.id, {
                outcome: 'RICHIAMO',
                date: toRomeIso(t0 + SEQUENCE_END_DAYS * 24 * H),
                note: 'Sequenza WhatsApp estesa in corso: tentativi automatici fino a questa data, poi esito definitivo.',
              }, { interim: true });
            }
          }
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
        const body = pickNudgeText(c.id, firstName, PERSONA_NAME[persona]);
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
        const rSid = persona === 'marta' ? martaReengageSid : reengageSid;
        if (!rSid) {
          await logConfigError(persona === 'marta' ? 'MARTA_REENGAGE_TEMPLATE_SID' : 'REENGAGE_TEMPLATE_SID');
          skipped++;
          continue;
        }
        sent++;
        const res = await sendSequenceTemplate(
          supabase, c.id, phone, rSid, `Riaggancio ${action.nudgeIndex}`, followupFrom, { '1': templateName(firstName) },
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
