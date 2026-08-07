import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { sendOutcome } from '@/lib/bot-outcome';
import { decideFollowupAction } from '@/lib/bot-followups';
import { classifyInterrupted } from '@/lib/interrotto-note';
import type { MarioTurn } from '@/lib/mario';
import { drainMarioReplies, lastIsUnansweredInbound, isOrphanedReplyingLock, isLockStale, LOCK_TTL_MS, serveRedrive } from '@/lib/fenice-autoreply';
import { runAgendaFollowups } from '@/lib/agenda-followup';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const H = 3600_000;
const D = 24 * H;
// Oltre questa anzianità dell'ultimo inbound il lead è perso: niente redrive,
// si prosegue verso la classificazione (fix conv 1251/1462).
const REDRIVE_MAX_MS = 5 * D;
const STALE_HANDED_OFF_MS = 48 * H;
const STALE_BOOKED_MS = 24 * H;

type MsgRow = {
  direction: string;
  body: string | null;
  created_at: string;
  twilio_status: string | null;
  template_sid: string | null;
  is_template?: boolean;
};

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  if (req.headers.get('authorization') === `Bearer ${secret}`) return true;
  if (req.nextUrl.searchParams.get('secret') === secret) return true;
  return false;
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return new NextResponse('unauthorized', { status: 401 });

  const supabase = getSupabaseAdmin();
  const now = Date.now();

  const sequenceEnabled = process.env.SEQUENCE_ENABLED === '1';
  const seqSids = [
    process.env.SEQ_TEMPLATE_SID_1,
    process.env.SEQ_TEMPLATE_SID_2,
    process.env.SEQ_TEMPLATE_SID_3,
    process.env.SEQ_TEMPLATE_SID_4,
  ].filter((s): s is string => Boolean(s));

  // Conversazioni CRM-linked non chiuse, paginate (capienza 50 lead/giorno →
  // il vecchio .limit(500) non basta più).
  const convs: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await supabase
      .from('conversations')
      .select('id, ai_status, ai_lock_at, ai_started_at, crm_lead_id, bot_outcome, bot_followups_sent, gdo_agenda_at, leads(phone_e164)')
      .not('crm_lead_id', 'is', null)
      .in('ai_status', ['active', 'replying', 'handed_off', 'booked'])
      // Fermo manuale dal pannello: fuori dal giro del cron per intero — niente
      // re-drive, niente watchdog, niente classificazione. Ci sta lavorando una persona.
      .is('ai_paused_at', null)
      .order('id', { ascending: true })
      .range(from, from + 999);
    const page = (data ?? []) as any[];
    convs.push(...page);
    if (page.length < 1000) break;
  }

  const report: Record<string, unknown>[] = [];

  for (const c of convs) {
    try {
      const phone = c.leads?.phone_e164 as string | undefined;

      // 1. Carica la cronologia messaggi dall'arruolamento in poi.
      let q = supabase
        .from('messages')
        .select('direction, body, created_at, twilio_status, template_sid, is_template')
        .eq('conversation_id', c.id)
        .order('created_at', { ascending: true })
        .limit(200);
      // Buffer 5': l'enroll inserisce l'apertura PRIMA di settare ai_started_at,
      // senza margine il filtro la escluderebbe dal conteggio outbound.
      if (c.ai_started_at) {
        q = q.gte('created_at', new Date(Date.parse(c.ai_started_at) - 5 * 60_000).toISOString());
      }
      const { data: msgData } = await q;
      const rows = (msgData ?? []) as MsgRow[];
      const msgsForDecision = rows.map((r) => ({ direction: r.direction, body: r.body ?? '' }));

      // 2. Rete di sicurezza: re-drive se c'è un inbound senza risposta.
      // Solo per gli stati guidati dal bot: su handed_off/booked risponde l'umano.
      if ((c.ai_status === 'active' || c.ai_status === 'replying') && lastIsUnansweredInbound(msgsForDecision)) {
        // lastIsUnansweredInbound true ⇒ l'ultima riga è un inbound.
        const lastPendingInboundAtMs = Date.parse(rows[rows.length - 1].created_at);

        // Il drain scrive un `fenice_ai_reply` a ogni giro andato a termine, anche
        // quando il turno non produce testo visibile. È la traccia che dice "a questo
        // inbound abbiamo già risposto": senza, un turno di soli tag non lascia nessuna
        // riga outbound, lastIsUnansweredInbound resta vero e lo stesso esito riparte
        // ogni ora fino al tetto dei 5 giorni (conv 3728, 32 ripetizioni a gap 1.00h).
        const { data: drainPrecedenti } = await supabase
          .from('event_log')
          .select('created_at')
          .eq('type', 'fenice_ai_reply')
          .eq('payload->>conversationId', String(c.id))
          .gte('created_at', new Date(lastPendingInboundAtMs).toISOString())
          .limit(1);
        const ultimoDrainMs = (drainPrecedenti ?? []).length > 0
          ? Date.parse((drainPrecedenti as { created_at: string }[])[0].created_at)
          : null;

        if (serveRedrive({ ultimoInboundMs: lastPendingInboundAtMs, ultimoDrainMs, nowMs: now, maxMs: REDRIVE_MAX_MS })) {
          if (!phone) {
            report.push({ id: c.id, action: 'redrive', skipped: true, reason: 'no_from' });
            continue;
          }
          if (isLockStale(c.ai_lock_at ?? null, now)) {
            // Lucchetto abbandonato: liberalo senza toccare ai_status. Il CAS sul
            // cutoff evita di rubare il turno a un drain che l'ha appena preso.
            await supabase
              .from('conversations')
              .update({ ai_lock_at: null })
              .eq('id', c.id)
              .lt('ai_lock_at', new Date(now - LOCK_TTL_MS).toISOString());
          }
          // Reset legacy: recupera le righe rimaste appese al vecchio meccanismo,
          // quando il lucchetto era il valore 'replying' dentro ai_status.
          if (isOrphanedReplyingLock(c.ai_status, lastPendingInboundAtMs, now)) {
            await supabase
              .from('conversations')
              .update({ ai_status: 'active' })
              .eq('id', c.id)
              .eq('ai_status', 'replying');
          }
          // Il lead ha già aspettato, salta la finestra di accorpamento.
          await drainMarioReplies(supabase, c.id, phone, () => 0);
          report.push({ id: c.id, action: 'redrive' });
          continue;
        }
        // Inbound già gestito da un drain precedente, oppure più vecchio di 5 giorni
        // (lead perso, va restituito e non ri-risposto) → fallthrough verso la
        // classificazione, che ha le sue guardie.
      }

      // 2a. Lead di un GDO (modalità postino): il re-drive sopra vale — il bot resta
      // il canale della chat — ma da qui in poi no. L'appuntamento è già preso, il
      // lead non è nostro: niente watchdog, niente chiusure, niente classificazione.
      if (c.gdo_agenda_at) {
        report.push({ id: c.id, action: 'gdo_postino_skip' });
        continue;
      }

      // 2b. Lead già esitato (qualunque esito): mai riclassificare. La riga è stata
      // riaperta dal webhook: richiudila per farla uscire dal giro del cron. Il
      // re-drive sopra resta comunque valido — un lead esitato che riscrive merita
      // ancora una risposta, e al CRM lo dice la nota "il bot ha ripreso la chat".
      if (c.bot_outcome) {
        if (c.ai_status === 'active') {
          await supabase
            .from('conversations')
            .update({ ai_status: 'closed' })
            .eq('id', c.id)
            .eq('ai_status', 'active');
          report.push({ id: c.id, action: 'close_terminal', outcome: c.bot_outcome });
        }
        continue;
      }

      // Riferimento "ultima attività" per i watchdog: ultimo messaggio, o
      // ai_started_at in assenza di messaggi.
      const lastActivityAtMs = rows.length
        ? Date.parse(rows[rows.length - 1].created_at)
        : c.ai_started_at
          ? Date.parse(c.ai_started_at)
          : now;

      // 2c. Watchdog handed_off: passato all'umano ma mai chiuso col CRM.
      if (c.ai_status === 'handed_off') {
        if (!c.bot_outcome && now - lastActivityAtMs > STALE_HANDED_OFF_MS) {
          // Alert una volta sola per conversazione.
          const { data: prior } = await supabase
            .from('event_log')
            .select('id')
            .eq('type', 'stale_handed_off')
            .contains('payload', { conversationId: c.id })
            .limit(1);
          if (!prior || prior.length === 0) {
            await supabase.from('event_log').insert({
              type: 'stale_handed_off',
              payload: { conversationId: c.id } as never,
              message: `[bot-fissatore] conv ${c.id} handed_off da >48h senza esito CRM: serve chiusura manuale`,
              level: 'warn',
            });
            report.push({ id: c.id, action: 'stale_handed_off' });
          }
        }
        continue;
      }

      // 2d. Watchdog booked: appuntamento preso ma esito CRM mai registrato.
      // La data appuntamento non è ricostruibile qui: serve intervento, l'alert è il fix.
      if (c.ai_status === 'booked') {
        if (!c.bot_outcome && now - lastActivityAtMs > STALE_BOOKED_MS) {
          await supabase.from('event_log').insert({
            type: 'stale_booked_no_outcome',
            payload: { conversationId: c.id } as never,
            message: `[bot-fissatore] conv ${c.id} booked da >24h senza bot_outcome: esito CRM mai inviato`,
            level: 'error',
          });
          report.push({ id: c.id, action: 'stale_booked_no_outcome' });
        }
        continue;
      }

      // 3. Classificazione finale (fine sequenza / silenzio Track B).
      const hasInbound = rows.some((r) => r.direction === 'in');
      const lastInboundAtMs = rows.reduceRight<number | null>((acc, r) => {
        if (acc !== null) return acc;
        return r.direction === 'in' ? Date.parse(r.created_at) : null;
      }, null);

      // phone non serve qui: sendOutcome fa solo callback CRM, non invia WhatsApp.
      const action = decideFollowupAction({
        nowMs: now,
        msgs: rows,
        seqSids,
        hasInbound,
        lastInboundAtMs,
        botOutcome: c.bot_outcome,
        sequenceEnabled,
        nudgesSent: (c.bot_followups_sent as number | null) ?? 0,
        gdoPostino: c.gdo_agenda_at != null,
      });

      if (action === 'discard_dead') {
        await sendOutcome(supabase, c.id, {
          outcome: 'DA_SCARTARE',
          discardReason: 'numero inesistente',
          note: 'Nessun messaggio consegnato in 14 giorni (verifica Twilio delivery). Numero morto.',
        });
        report.push({ id: c.id, action });
      } else if (action === 'non_risposto') {
        // Quanti messaggi il lead ha DAVVERO ricevuto (delivered/read), non inviati.
        const nDelivered = rows.filter(
          (r) => r.direction === 'out' && (r.twilio_status === 'delivered' || r.twilio_status === 'read'),
        ).length;
        await sendOutcome(supabase, c.id, {
          outcome: 'NON_RISPOSTO',
          note: `Sequenza completa: ${nDelivered} messaggi consegnati in 12 giorni, mai una risposta. Da provare a voce.`,
        });
        report.push({ id: c.id, action });
      } else if (action === 'interrotto_classify') {
        const history: MarioTurn[] = rows.slice(-40).map((r) => ({
          role: r.direction === 'in' ? ('user' as const) : ('assistant' as const),
          content: r.body ?? '',
        }));
        const v = await classifyInterrupted(history);
        if (v.discard) {
          await sendOutcome(supabase, c.id, {
            outcome: 'DA_SCARTARE',
            discardReason: v.discardReason,
            note: v.note,
          });
        } else {
          await sendOutcome(supabase, c.id, { outcome: 'INTERROTTO', note: v.note });
        }
        report.push({ id: c.id, action, discard: v.discard });
      }
      // action === 'none': niente da fare
    } catch (e) {
      await supabase.from('event_log').insert({
        type: 'bot_followup_error',
        payload: { conversationId: c.id, error: e instanceof Error ? e.message : 'errore' } as never,
        message: `[bot-fissatore] errore su conv ${c.id}: ${e instanceof Error ? e.message : 'errore'}`,
        level: 'error',
      });
    }
  }

  // Follow-up agenda (singolo, idempotente) a chi ha ricevuto l'agenda e non ha preso.
  let agendaFollowup = { sent: 0, skipped: 0 };
  try {
    agendaFollowup = await runAgendaFollowups(supabase, new Date(now));
  } catch (e) {
    await supabase.from('event_log').insert({
      type: 'agenda_followup_error',
      payload: { error: e instanceof Error ? e.message : 'errore' } as never,
      message: `[bot-fissatore] errore follow-up agenda: ${e instanceof Error ? e.message : 'errore'}`,
      level: 'error',
    });
  }

  await supabase.from('event_log').insert({
    type: 'bot_followups_run',
    payload: { count: report.length } as never,
    message: `[bot-fissatore] cron backstop: ${report.length} azioni`,
    level: 'info',
  });

  return NextResponse.json({ ok: true, actions: report, agendaFollowup });
}
