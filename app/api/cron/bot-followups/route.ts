import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { sendOutcome } from '@/lib/bot-outcome';
import { decideFollowupAction, esitoMaiConsegnato, serveCronologia, ultimaAttivitaMs } from '@/lib/bot-followups';
import { classifyInterrupted } from '@/lib/interrotto-note';
import { buildConfermaPersaNote } from '@/lib/bot-outcome-rules';
import { buildRichiamoRestituitoNote } from '@/lib/richiamo-fasce';
import { haConfermatoIlForm, decidiSuConfermaForm } from '@/lib/conferma-form';
import type { MarioTurn } from '@/lib/mario';
import { drainMarioReplies, lastIsUnansweredInbound, isOrphanedReplyingLock, isLockStale, LOCK_TTL_MS, serveRedrive } from '@/lib/fenice-autoreply';
import { runAgendaFollowups } from '@/lib/agenda-followup';
import { lancioInCorso, lancioRestituito } from '@/lib/lancio-fase';
import { logCronQueryError } from '@/lib/cron-query-error';
import { alertUnaVolta } from '@/lib/alert-una-volta';

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
  twilio_error_code?: number | null;
};

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  if (req.headers.get('authorization') === `Bearer ${secret}`) return true;
  if (req.nextUrl.searchParams.get('secret') === secret) return true;
  return false;
}

/** Questa conversazione ha già una riga `restituzione_bloccata_conferma_form`, scritta
 *  in un run precedente? Stesso controllo di `alertUnaVolta` (tipo + conversationId nel
 *  payload), tenuto qui a parte perché va fatto PRIMA di chiamare `classifyInterrupted`
 *  — a differenza di `alertUnaVolta`, che controllo e scrittura li fa insieme, e qui la
 *  scrittura deve restare dopo l'invio del `CONTATTO_UMANO`, non prima. */
async function formGiaTrattenuto(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  conversationId: number,
): Promise<boolean> {
  const { data } = await supabase
    .from('event_log')
    .select('id')
    .eq('type', 'restituzione_bloccata_conferma_form')
    .contains('payload', { conversationId })
    .limit(1);
  return (data ?? []).length > 0;
}

/** L'ultimo "quando" registrato su questa conversazione da un `richiamo_tenuto_aperto`
 *  (la prima delle tre fasce: "sentiamoci fra 2 giorni"), o `null` se non ce n'è.
 *
 *  Serve all'INTERROTTO qui sotto. Quella fascia non manda niente al CRM e lascia la
 *  chat aperta; ma il lead ha risposto, quindi sta sul Track B (`decideTrackB`): un solo
 *  nudge free-text a 12-24h e poi, a 96h di silenzio, la restituzione come chat
 *  interrotta. Senza questa lettura il GDO riceveva un INTERROTTO generico e il giorno
 *  che il lead aveva chiesto andava perso. Il payload è quello scritto da `sendOutcome`
 *  (`lib/bot-outcome.ts`): `{ conversationId, crmLeadId, date, quando }`. Vince l'ultimo
 *  "quando" non nullo: se il lead l'ha cambiato, conta quello più recente. */
async function quandoRichiamoTenutoAperto(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  conversationId: number,
): Promise<string | null> {
  const { data } = await supabase
    .from('event_log')
    .select('payload, created_at')
    .eq('type', 'richiamo_tenuto_aperto')
    .contains('payload', { conversationId })
    .order('created_at', { ascending: false })
    .limit(20);
  for (const r of (data ?? []) as { payload: { quando?: unknown } | null }[]) {
    const q = r.payload?.quando;
    if (typeof q === 'string' && q.trim()) return q.trim();
  }
  return null;
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
    const { data, error } = await supabase
      .from('conversations')
      .select('id, ai_status, ai_lock_at, ai_started_at, created_at, last_message_at, last_inbound_at, crm_lead_id, bot_outcome, bot_followups_sent, gdo_agenda_at, lancio_slug, lancio_fase, leads(phone_e164)')
      .not('crm_lead_id', 'is', null)
      .in('ai_status', ['active', 'replying', 'handed_off', 'booked'])
      // Fermo manuale dal pannello: fuori dal giro del cron per intero — niente
      // re-drive, niente watchdog, niente classificazione. Ci sta lavorando una persona.
      .is('ai_paused_at', null)
      .order('id', { ascending: true })
      .range(from, from + 999);
    // `data: null` da una query fallita e zero candidati si somigliano troppo: qui
    // il cron smetterebbe di esitare e di rispondere senza dirlo a nessuno.
    if (error) { await logCronQueryError(supabase, 'bot_followups_query_error', error); break; }
    const page = (data ?? []) as any[];
    convs.push(...page);
    if (page.length < 1000) break;
  }

  const report: Record<string, unknown>[] = [];

  for (const c of convs) {
    try {
      const phone = c.leads?.phone_e164 as string | undefined;

      // 1. Carica la cronologia messaggi dall'arruolamento in poi — ma solo per chi
      // può davvero produrre un'azione. Farlo per tutte le righe del giro è ciò che
      // dal 02/09/2026 ha ucciso il cron a 300s (vedi serveCronologia).
      const serve = serveCronologia(c, now);
      let rows: MsgRow[] = [];
      if (serve) {
        let q = supabase
          .from('messages')
          .select('direction, body, created_at, twilio_status, template_sid, is_template, twilio_error_code')
          .eq('conversation_id', c.id)
          .order('created_at', { ascending: true })
          .limit(200);
        // Buffer 5': l'enroll inserisce l'apertura PRIMA di settare ai_started_at,
        // senza margine il filtro la escluderebbe dal conteggio outbound.
        if (c.ai_started_at) {
          q = q.gte('created_at', new Date(Date.parse(c.ai_started_at) - 5 * 60_000).toISOString());
        }
        const { data: msgData } = await q;
        rows = (msgData ?? []) as MsgRow[];
      }
      const msgsForDecision = rows.map((r) => ({ direction: r.direction, body: r.body ?? '' }));

      // 2. Rete di sicurezza: re-drive se c'è un inbound senza risposta.
      // Solo per gli stati guidati dal bot: su handed_off/booked risponde l'umano.
      // `lancioRestituito` è il veto del ruling C8: quel lead è tornato al GDO e il bot
      // non gli scrive più, qualunque cosa dica `ai_status` (vedi lib/lancio-fase.ts).
      if ((c.ai_status === 'active' || c.ai_status === 'replying') && !lancioRestituito(c) && lastIsUnansweredInbound(msgsForDecision)) {
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

      // 2a-bis. Lancio Web Dev AI in corso: come per il postino, niente watchdog né
      // classificazioni. Il re-drive sopra resta — il turno lo fa lib/lancio-turno —
      // e la chat torna a Mario solo con una fase terminale (chiuso/restituito).
      if (lancioInCorso(c)) {
        report.push({ id: c.id, action: 'lancio_skip', fase: c.lancio_fase });
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
        : ultimaAttivitaMs(c, now);

      // 2c. Watchdog handed_off: passato all'umano ma mai chiuso col CRM.
      if (c.ai_status === 'handed_off') {
        if (!c.bot_outcome && now - lastActivityAtMs > STALE_HANDED_OFF_MS) {
          const scritto = await alertUnaVolta(supabase, {
            type: 'stale_handed_off',
            conversationId: c.id,
            message: `[bot-fissatore] conv ${c.id} handed_off da >48h senza esito CRM: serve chiusura manuale`,
            level: 'warn',
          });
          if (scritto) report.push({ id: c.id, action: 'stale_handed_off' });
        }
        continue;
      }

      // 2d. Watchdog booked: appuntamento preso ma esito CRM mai registrato.
      // La data appuntamento non è ricostruibile qui: serve intervento, l'alert è il fix.
      if (c.ai_status === 'booked') {
        // Una volta sola: senza guardia il cron orario ha scritto 100 righe uguali
        // per la sola conv 3401, e un alert che si ripete non lo legge più nessuno.
        if (!c.bot_outcome && now - lastActivityAtMs > STALE_BOOKED_MS) {
          const scritto = await alertUnaVolta(supabase, {
            type: 'stale_booked_no_outcome',
            conversationId: c.id,
            message: `[bot-fissatore] conv ${c.id} booked da >24h senza bot_outcome: esito CRM mai inviato`,
            level: 'error',
          });
          if (scritto) report.push({ id: c.id, action: 'stale_booked_no_outcome' });
        }
        continue;
      }

      // 3. Classificazione finale (fine sequenza / silenzio Track B).
      // Senza cronologia non si classifica: `serveCronologia` ha già stabilito che qui
      // nessun esito può scattare. Esplicito, per non farlo diventare un 'none' muto
      // che nasconderebbe un buco del pre-filtro.
      if (!serve) continue;

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
        // Oggi ridondante (il blocco 2a-bis ha gia' fatto `continue`), e resta: la
        // guardia del modulo puro non deve dipendere dall'ordine dei blocchi qui.
        lancio: lancioInCorso(c),
      });

      if (action === 'mai_consegnato') {
        // WhatsApp non ha consegnato niente: quasi sempre il numero non ha WhatsApp
        // (63024), non è inesistente. Decisione PO 25/09/2026: mai scartarlo, torna a
        // un GDO da chiamare a voce. Era un DA_SCARTARE "numero inesistente" con una
        // nota che parlava di 14 giorni, quando la soglia vera è 48h (fast-fail) o 4
        // giorni (fine sequenza). Vedi `esitoMaiConsegnato`.
        await sendOutcome(supabase, c.id, esitoMaiConsegnato(rows));
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
        // Il lead aveva confermato di aver compilato il form di prenotazione: quello è
        // un appuntamento già preso, non una chat morta. Fino al 22/09/2026 qui
        // partivano DUE cose — la segnalazione E la restituzione — e la seconda
        // rimandava a un GDO, come lead freddo da ricominciare, qualcuno che aveva già
        // scelto giorno e ora (54 lead così, 53 solo a settembre).
        //
        // La prova la dà `haConfermatoIlForm`, deterministica, non `v.confermato`, che
        // è un modello: su questa decisione non si può sbagliare a caso. `v.confermato`
        // resta come seconda rete — copre le conferme dette a parole ("ho prenotato per
        // giovedì") che la regex non vede.
        //
        // La guardia sotto (`decidiSuConfermaForm`) va calcolata PRIMA di chiamare
        // `classifyInterrupted`: trattenere la conversazione non tocca né `ai_status` né
        // `bot_outcome`, quindi senza guardia resterebbe idonea allo stesso ramo a ogni
        // giro del cron — e richiamerebbe una chiamata a pagamento a Claude senza
        // limite, per sempre, invece che una volta sola per conversazione.
        const confermaForm = haConfermatoIlForm(rows);
        const giaTrattenuta = confermaForm ? await formGiaTrattenuto(supabase, c.id) : false;
        const azioneForm = decidiSuConfermaForm({ confermaForm, giaTrattenuta });

        if (azioneForm === 'salta') {
          // Già segnalata e trattenuta in un run precedente: niente classificatore,
          // niente nuova riga, niente nuovo CONTATTO_UMANO.
          report.push({ id: c.id, action, trattenuto: true, giaSegnalato: true });
          continue;
        }

        const history: MarioTurn[] = rows.slice(-40).map((r) => ({
          role: r.direction === 'in' ? ('user' as const) : ('assistant' as const),
          content: r.body ?? '',
        }));
        const v = await classifyInterrupted(history);

        // L'esito dell'invio del CONTATTO_UMANO, per la riga di guardia qui sotto: la
        // riga si scrive comunque (è lei che impedisce di richiamare il classificatore a
        // ogni giro), ma deve dire la verità su cosa è arrivato al CRM.
        let invioContatto: { esito: 'inviato' | 'fallito' | 'senza_lead'; errore?: string } = { esito: 'senza_lead' };
        if ((azioneForm === 'segnala_e_trattieni' || v.confermato) && c.crm_lead_id) {
          const ultimoDelLead = [...rows].reverse().find((r) => r.direction === 'in')?.body ?? undefined;
          const r = await sendOutcome(supabase, c.id, {
            outcome: 'CONTATTO_UMANO',
            note: ultimoDelLead,
            // Il nome esatto conta: e' l'unico punto del contratto in cui un valore
            // diverso cambia il comportamento dall'altra parte. Con questo il CRM marca
            // la card con "Aveva detto si'" e mette il lead in cima alla lista di chi lo
            // ha in mano; con qualsiasi altro finisce in 'altro', la marcatura non
            // scatta e il lead torna invisibile come prima (loro messaggio del 29/08).
            motivoContattoUmano: 'conferma_senza_appuntamento',
            notaContattoUmano: buildConfermaPersaNote({ leadWords: ultimoDelLead, stage: v.note }),
          });
          invioContatto = r.sent
            ? { esito: 'inviato' }
            : { esito: 'fallito', errore: r.error ?? (r.status ? `http_${r.status}` : 'errore') };
        }

        // E qui la differenza: chi ha confermato NON viene restituito né scartato. La
        // conversazione resta aperta, così se riscrive il bot può ancora fissare, e il
        // lead resta dov'è invece di ripartire da zero nella pipeline di un GDO. La riga
        // di guardia si scrive DOPO l'invio del CONTATTO_UMANO (non prima): è quella che
        // il run successivo legge per non richiamare più il classificatore.
        //
        // `esito` dice cosa è successo al CONTATTO_UMANO: `inviato`, `fallito` (il CRM
        // l'ha rifiutato o non ha risposto: c'è `errore`) o `senza_lead` (nessun
        // crm_lead_id, quindi niente da mandare). La riga si scrive in tutti e tre i casi
        // e non solo sul successo: scriverla solo sull'`inviato` farebbe richiamare
        // `classifyInterrupted` (a pagamento) a ogni giro su un invio che fallisce sempre.
        // Chi verifica le trattenute filtra `payload->>esito=eq.inviato`; le altre due
        // sono le segnalazioni da recuperare a mano, e non si riprovano da sole.
        if (azioneForm === 'segnala_e_trattieni') {
          await supabase.from('event_log').insert({
            type: 'restituzione_bloccata_conferma_form',
            payload: { conversationId: c.id, crmLeadId: c.crm_lead_id, ...invioContatto } as never,
            message: `[bot-fissatore] conv ${c.id}: conferma del form presente, restituzione bloccata (segnalazione ${invioContatto.esito})`,
            level: invioContatto.esito === 'inviato' ? 'warn' : 'error',
          });
          report.push({ id: c.id, action, trattenuto: true, segnalazione: invioContatto.esito });
          continue;
        }

        if (v.discard) {
          await sendOutcome(supabase, c.id, {
            outcome: 'DA_SCARTARE',
            discardReason: v.discardReason,
            note: v.note,
          });
        } else {
          // Un lead che aveva chiesto "sentiamoci fra N giorni" (fascia `tieni_aperta`)
          // e poi è sparito arriva qui: il GDO deve sapere QUANDO voleva essere
          // risentito, non ricevere una chat interrotta qualsiasi. Senza un "quando"
          // registrato la nota resta quella del classificatore, come prima.
          const quando = await quandoRichiamoTenutoAperto(supabase, c.id);
          const note = quando ? `${buildRichiamoRestituitoNote({ quando })} ${v.note}` : v.note;
          await sendOutcome(supabase, c.id, { outcome: 'INTERROTTO', note });
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
  // Sospeso dal PO il 24/09/2026 per la qualita' dei numeri: riparte solo con '1'.
  let agendaFollowup = { sent: 0, skipped: 0 };
  if (process.env.AGENDA_FOLLOWUP_ENABLED === '1') {
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
  }

  await supabase.from('event_log').insert({
    type: 'bot_followups_run',
    payload: { count: report.length } as never,
    message: `[bot-fissatore] cron backstop: ${report.length} azioni`,
    level: 'info',
  });

  return NextResponse.json({ ok: true, actions: report, agendaFollowup });
}
