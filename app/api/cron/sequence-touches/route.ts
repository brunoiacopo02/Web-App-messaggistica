import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import {
  decideTrackA,
  decideTrackB,
  pickNudgeText,
  pickNudgeTextScheda,
  usaNudgeScheda,
  firstOutboundAtMs,
  lastOutboundAtMs,
  toRomeIso,
  APERTURA_DIFFERITA_MAX_H,
  NUDGE1_MAX_H,
  SEQUENCE_END_DAYS,
  TOUCH_OFFSETS_DAYS,
  type MsgLite,
} from '@/lib/sequence';
import { inviaNotaAlCrm } from '@/lib/bot-outcome';
import { sendFreeText } from '@/lib/twilio';
import { inviaAperturaMario, sendSequenceTemplate } from '@/lib/apertura-mario-invio';
import { stopDalCrmPerLead } from '@/lib/stop-crm';
import {
  personaForConversation,
  PERSONA_NAME,
  OPENING_ENV_KEYS,
} from '@/lib/persona';
import { templateName } from '@/lib/name';
import { FILTRO_FUORI_LANCIO } from '@/lib/lancio-fase';
import { logCronQueryError } from '@/lib/cron-query-error';
import { mittenteDiConversazione } from '@/lib/mittente';
import { formatRomeDateTime } from '@/lib/rome-time';
import { caricaContesto, decidiInvio, sidPerConversazione } from '@/lib/sollecito-parcheggio';
import { caricaTouchAb, idoneaTouchAb, sidTouchPerPersona } from '@/lib/touch-ab';
import { isCrmFunnelBlackFriday } from '@/lib/black-friday';
import { isChatDatabase } from '@/lib/database-bot';

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

export async function GET(req: NextRequest) {
  if (!authorized(req)) return new NextResponse('unauthorized', { status: 401 });

  // Kill-switch: questa route fa SOLO invii, la classificazione resta a bot-followups.
  // Due interruttori dal 06/11/2026. SEQUENCE_ENABLED governa follow-up, nudge e
  // sollecito (spento dal 02/11, voluto). Le aperture differite — il primo messaggio ai
  // lead arrivati fra le 23 e le 07 — hanno il loro (APERTURA_DIFFERITA_ENABLED, assente =
  // accese): legate al primo, dal 03/11 al 06/11 139 lead notturni non sono mai stati aperti.
  const sequenzaAccesa = process.env.SEQUENCE_ENABLED === '1';
  const apertureDifferite = process.env.APERTURA_DIFFERITA_ENABLED !== '0';

  const supabase = getSupabaseAdmin();
  const now = Date.now();
  // A/B del touch su un solo numero (PO 07/11/2026, lib/touch-ab.ts): indipendente da
  // SEQUENCE_ENABLED, che resta spento (niente nudge). null = spento o fermato.
  const touchAb = await caricaTouchAb(supabase, now);
  if (!sequenzaAccesa && !apertureDifferite && !touchAb) {
    return NextResponse.json({ ok: true, disabled: true });
  }

  // Il mittente — dell'apertura differita, dei touch e dei nudge — e' quello della
  // singola chat (`wa_number`, scelto all'arruolamento, vedi lib/mittente.ts).
  // `TWILIO_WHATSAPP_NUMBER_FOLLOWUP` non si legge piu': un numero "dei follow-up"
  // diverso da quello dell'apertura e' proprio il thread spezzato che questa regola
  // chiude, e sull'apertura differita avrebbe ignorato la scelta dell'intake.
  const maxPerRun = Math.max(1, Number(process.env.SEQUENCE_MAX_PER_RUN) || 25);

  // SID sequenza Track A: env SEQ_TEMPLATE_SID_1..4 (posizionali sui touch 1..4).
  const seqSidByIndex = [1, 2, 3, 4].map((i) => process.env[`SEQ_TEMPLATE_SID_${i}`]);
  // Variante Marta (posizionale come i legacy). Possono mancare finché il nuovo
  // flusso è spento: il config-error a inizio run resta SOLO sui legacy.
  const martaSeqSidByIndex = [1, 2, 3, 4].map((i) => process.env[`MARTA_SEQ_TEMPLATE_SID_${i}`]);
  const martaReengageSid = process.env.MARTA_REENGAGE_TEMPLATE_SID;
  // Tutti i SID "Marta" (aperture A/B + sequenza + riaggancio): servono a derivare
  // la persona di una conversazione dal primo template outbound.
  const martaOpeningSids = OPENING_ENV_KEYS.map((k) => process.env[k]);
  const martaSids = new Set(
    [...martaOpeningSids, ...martaSeqSidByIndex, martaReengageSid].filter((s): s is string => !!s),
  );
  // Servono solo i SID dei touch ancora previsti (oggi: il primo). I 2/3/4 restano
  // in env e nel conteggio, ma la loro assenza non è più un errore di configurazione.
  const missingSeqIdx = TOUCH_OFFSETS_DAYS.map((_, i) => i + 1).filter((i) => !seqSidByIndex[i - 1]);
  // Il CONTEGGIO dei touch considera entrambe le varianti (legacy + Marta) e tutti
  // gli indici storici: chi ha già preso un touch 2 o 3 non deve ricominciare da capo.
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
  // Sollecito prima del parcheggio (PO 29/10/2026): null = spento, tutto come prima.
  const sollecito = sequenzaAccesa ? await caricaContesto(supabase, now) : null;
  const sollecitoSaltati: Record<string, number> = {};
  let sollecitiInviati = 0;

  // Tutte le conv CRM attive, con paginazione (>1000 possibili a regime 50/g).
  const convs: any[] = [];
  const baseConv = () => supabase
      .from('conversations')
      .select('id, ai_status, ai_started_at, crm_lead_id, crm_funnel, bot_outcome, bot_followups_sent, wa_number, professione, scheda_inviata_at, leads(phone_e164, first_name)')
      .not('crm_lead_id', 'is', null)
      .in('ai_status', ['active'])
      // Lead dei GDO (modalità postino): hanno già l'appuntamento, la sequenza di
      // riaggancio non li riguarda — e il riaggancio arriverebbe dal nostro bot su un
      // lead che sta lavorando un commerciale.
      .is('gdo_agenda_at', null)
      // Fermo manuale dal pannello: la chat è in mano a una persona, nessun touch
      // automatico le arriva addosso.
      .is('ai_paused_at', null)
      // Lancio Web Dev AI: niente aperture, touch o nudge. Il benvenuto differito lo
      // manda /api/cron/lancio-aperture, il resto è silenzio fino al 5/10 (spec §5.1).
      .or(FILTRO_FUORI_LANCIO);
  for (let fromRow = 0; ; fromRow += 1000) {
    let qConv = baseConv();
    // Sequenza spenta: restano solo le aperture differite, cioe' le chat arruolate da
    // meno di APERTURA_DIFFERITA_MAX_H. Le altre non avrebbero niente da ricevere.
    if (!sequenzaAccesa) {
      qConv = qConv.gte('ai_started_at', new Date(now - APERTURA_DIFFERITA_MAX_H * H).toISOString());
    }
    const { data, error } = await qConv.order('id', { ascending: true }).range(fromRow, fromRow + 999);
    // Una query fallita torna `data: null`: senza questa riga il run finisce con
    // "0 invii" e nessuno se ne accorge.
    if (error) { await logCronQueryError(supabase, 'sequence_touches_query_error', error); break; }
    const batch = data ?? [];
    convs.push(...batch);
    if (batch.length < 1000) break;
  }
  // Sequenza spenta e A/B acceso: in piu' le chat del numero del test arruolate nelle
  // ultime 48h (il touch parte fra 20h e 30h dall'apertura).
  if (!sequenzaAccesa && touchAb) {
    const visti = new Set(convs.map((c) => c.id));
    const { data, error } = await baseConv()
      .in('wa_number', [`whatsapp:${touchAb.config.numero}`, touchAb.config.numero])
      .gte('ai_started_at', new Date(now - 48 * H).toISOString())
      .order('id', { ascending: true })
      .limit(1000);
    if (error) await logCronQueryError(supabase, 'sequence_touches_query_error', error);
    for (const c of data ?? []) if (!visti.has(c.id)) convs.push(c);
  }
  let touchAbInviati = 0;

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
      // Lead di database (PO 10/11/2026): un solo messaggio a persona. Niente apertura
      // differita, touch, sollecito o nudge: chi non risponde resta dov'e'.
      if (isChatDatabase(c.crm_funnel)) {
        skipped++;
        continue;
      }
      // Undefined solo senza il primario in env: sull'apertura si segnala sotto, sui
      // touch e sui nudge `sendTemplate`/`sendFreeText` ripiegano come sempre.
      const from = mittenteDiConversazione(c);

      // Lo stop che arriva dal CRM: presentato alla call, cliente, o scartato da una
      // persona per un motivo che dalla chat non si vede. Un template di sequenza a un
      // cliente è il messaggio peggiore che possiamo mandare, ed è anche il più facile
      // da mandare per sbaglio: qui il bot scrive senza che nessuno abbia detto niente.
      const stopCrm = await stopDalCrmPerLead(supabase, c.crm_lead_id ?? null);
      if (stopCrm) {
        await supabase.from('event_log').insert({
          type: 'bot_fermo_stato_crm',
          payload: { conversationId: c.id, crmLeadId: c.crm_lead_id ?? null, motivo: stopCrm, dove: 'sequenza' } as never,
          message: `[sequenza] conv ${c.id}: nessun touch, il CRM dice ${stopCrm}`,
          level: 'info',
        });
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
        // Black Friday (PO 07/11/2026): le chat BF mai risposte le apre SOLO il cron
        // bf-aperture col template BF approvato. Qui niente apertura (nemmeno neutra),
        // niente touch e niente "apertura mai partita": in stand-by restano al bot.
        if (isCrmFunnelBlackFriday(c.crm_funnel)) { skipped++; continue; }
        // Il touch "Ti ho scritto ieri" e' MARKETING a chi non ha mai risposto: sospeso
        // dal PO il 24/09/2026 per la qualita' dei numeri. Riparte solo con '1'.
        const action = decideTrackA({
          nowMs: now, msgs, seqSids, sequenceEnabled: sequenzaAccesa,
          touchEnabled: sequenzaAccesa && process.env.SEQUENCE_TOUCH_ENABLED === '1',
          apertureDifferite,
          // Senza `ai_started_at` l'eta' della chat non si sa: nessuna apertura (mai un
          // "ciao" differito di giorni). In pratica l'enroll lo scrive sempre.
          arruolatoAtMs: c.ai_started_at ? Date.parse(c.ai_started_at) : now - APERTURA_DIFFERITA_MAX_H * H,
        });

        // A/B del touch: le chat del numero del test le gestisce solo questo blocco
        // (niente touch di sequenza ne' sollecito sopra). L'apertura differita resta sotto.
        if (touchAb && action.kind !== 'send_opening' && touchAb.nelTest(c)) {
          if (idoneaTouchAb(msgs, now)) await touchAb.segnaAssegnata(c, 'sequenza');
          const d = touchAb.braccio(c.id) === 'touch' && touchAb.puoInviare
            ? decidiInvio({ nowMs: now, msgs, sids: seqSids })
            : null;
          const sid = d?.invia ? sidTouchPerPersona(persona) : undefined;
          if (!d?.invia || !sid || !(await touchAb.templateOk(sid))) {
            if (d?.invia && !sid) await logConfigError(persona === 'marta' ? 'MARTA_SEQ_TEMPLATE_SID_1' : 'SEQ_TEMPLATE_SID_1');
            skipped++;
            continue;
          }
          sent++;
          const res = await sendSequenceTemplate(
            supabase, c.id, phone, sid, 'Touch A/B ti ho scritto ieri', from, { '1': templateName(firstName) },
          );
          const t0 = firstOutboundAtMs(msgs) ?? now;
          const payload = {
            conversationId: c.id, crmLeadId: c.crm_lead_id ?? null, numero: touchAb.config.numero, sid, persona,
            oreDallApertura: Math.round(((now - t0) / H) * 10) / 10,
            aperturaLetta: msgs.some((m) => m.direction === 'out' && m.twilio_status === 'read'),
          };
          if (res.ok) {
            touchAbInviati++;
            await supabase.from('event_log').insert({
              type: 'touch_ab_inviato', level: 'info', payload: payload as never,
              message: `[touch-ab] conv ${c.id}: touch inviato ${payload.oreDallApertura}h dopo l'apertura`,
            });
          } else if (!res.capped) {
            await supabase.from('event_log').insert({
              type: 'touch_ab_invio_fallito', level: 'warn', payload: { ...payload, error: res.error ?? null } as never,
              message: `[touch-ab] conv ${c.id}: touch non partito (${res.error ?? 'errore'})`,
            });
          }
          continue;
        }

        if (action.kind === 'send_opening') {
          if (!from) {
            await logConfigError('TWILIO_WHATSAPP_NUMBER_FENICE');
            skipped++;
            continue;
          }
          const r = await inviaAperturaMario(supabase, {
            conversationId: c.id, phone, firstName, funnel: c.crm_funnel as string | null | undefined, from,
            logConfigError, logOpeningConfigError,
          });
          if (r.tentato) sent++;
          else skipped++;
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
            supabase, c.id, phone, sid, `Sequenza touch ${action.touchIndex}`, from, { '1': templateName(firstName) },
          );
          // Dopo il primo follow-up riuscito: una NOTA al CRM (una volta sola, perché
          // il touch 1 parte una volta sola) che dice fino a quando la sequenza va
          // avanti. Dal 02/10/2026 la chiusura (SEQUENCE_END_DAYS = 1) coincide con
          // l'offset del touch 1 e in `decideTrackA` viene prima: il touch, e con lui
          // questa nota, non parte più. Il blocco resta per quando la chiusura risalisse. Fino al 22/09/2026 era un RICHIAMO interim con `date = t0 + 4
          // giorni`: una `recallDate` con i secondi della macchina addosso, che finiva
          // nei "Richiami" di un GDO appena il lead passava a un umano (es. richiamo
          // alle 09:02:49 per una persona mai sentita — 396 lead così). Serve
          // visibilità, non un appuntamento telefonico.
          //
          // TRAPPOLA per chi in futuro "semplifica" questo blocco: NON sostituire
          // `inviaNotaAlCrm` con `sendOutcome(supabase, c.id, { outcome: 'NOTA', note })`
          // — sembra la scelta più naturale (è già importato nel resto del file) ma è
          // sbagliata. Su una conversazione senza esito ancora (il nostro caso: qui
          // `bot_outcome` è sempre null) `resolveOutcomeAction` ritorna
          // `{ kind: 'normal' }`, e nel ramo "normal" `sendOutcome`, dopo un POST
          // riuscito, PERSISTE: scrive `bot_outcome: 'NOTA'` e chiude
          // `ai_status: 'closed'` sulla conversazione. Questo stesso cron filtra le sue
          // candidate proprio su quei due campi (`ai_status in ('active')` nella query
          // in cima alla route, `bot_outcome != null` nello skip poco sotto): al run
          // successivo la conversazione sparirebbe, e i touch 2/3/4 non partirebbero
          // MAI PIÙ per nessun lead che arriva a questo punto — una rottura silenziosa
          // e permanente di tutta la sequenza, non un dettaglio. `inviaNotaAlCrm` manda
          // la stessa nota al CRM senza toccare né `ai_status` né `bot_outcome`. Il
          // test che inchioda questo comportamento (e diventa rosso se `sendOutcome`
          // smette di persistere una NOTA "normale") sta in `lib/bot-outcome.test.ts`,
          // describe "sendOutcome — NOTA su lead senza esito NON è un ping innocuo".
          if (touchRes.ok && action.touchIndex === 1) {
            const t0 = firstOutboundAtMs(msgs);
            const secret = process.env.BOT_WEBHOOK_SECRET;
            const crmLeadId = c.crm_lead_id as string | null;
            if (t0 !== null && secret && crmLeadId) {
              const fine = toRomeIso(t0 + SEQUENCE_END_DAYS * 24 * H);
              const esitoNota = await inviaNotaAlCrm(
                supabase,
                c.id,
                crmLeadId,
                'Sequenza WhatsApp estesa in corso: tentativi automatici fino al ' +
                  `${formatRomeDateTime(fine)}, poi esito definitivo. Non è un richiamo: ` +
                  'non c\'è niente da chiamare a quell\'ora.',
                undefined,
                secret,
              );
              // `inviaNotaAlCrm` scrive su event_log solo sul successo (`bot_note_sent`)
              // o su un body non valido: una risposta non-ok del CRM o un'eccezione di
              // rete tornano `sent: false` senza lasciare nessuna traccia propria. Il
              // blocco spara una volta sola per conversazione (`touchIndex === 1`, mai
              // ripetuto ai run successivi), quindi senza questo log un fallimento qui
              // sparirebbe per sempre — nessun retry, nessuna visibilità. Stessa forma
              // di `nota_secondo_recapito_non_inviata` in `fenice-autoreply.ts`.
              if (!esitoNota.sent) {
                await supabase.from('event_log').insert({
                  type: 'sequence_nota_estesa_non_inviata',
                  payload: { conversationId: c.id, crmLeadId, error: esitoNota.error ?? null, status: esitoNota.status ?? null } as never,
                  message: `[sequenza] conv ${c.id}: nota "lavorazione estesa" non inviata al CRM (${esitoNota.error ?? esitoNota.status ?? 'errore sconosciuto'})`,
                  level: 'warn',
                });
              }
            }
          }
        } else if (sequenzaAccesa && sollecito && persona === 'marta' && (action.kind === 'wait' || action.kind === 'non_risposto')) {
          // Sollecito prima del parcheggio: un solo template, dallo stesso numero
          // dell'apertura, 20-30h dopo, in fascia. Il NON_RISPOSTO lo aspetta
          // (bot-followups, `decidiChiusura`).
          const d = decidiInvio({ nowMs: now, msgs, sids: sollecito.sids });
          if (!d.invia) { skipped++; continue; }
          const idoneo = await sollecito.idoneo(from);
          if (!idoneo.ok) {
            sollecitoSaltati[idoneo.motivo] = (sollecitoSaltati[idoneo.motivo] ?? 0) + 1;
            skipped++;
            continue;
          }
          const sid = sidPerConversazione(sollecito.sids, c.id as number) as string;
          sent++;
          const res = await sendSequenceTemplate(
            supabase, c.id, phone, sid, 'Sollecito prima del parcheggio', from, { '1': templateName(firstName) },
          );
          const t0 = firstOutboundAtMs(msgs) ?? now;
          const payload = {
            conversationId: c.id,
            crmLeadId: c.crm_lead_id ?? null,
            numero: from ?? null,
            sid,
            oreDallApertura: Math.round(((now - t0) / H) * 10) / 10,
            aperturaLetta: msgs.some((m) => m.direction === 'out' && m.twilio_status === 'read'),
          };
          if (res.ok) {
            sollecito.contaInvio(from as string);
            sollecitiInviati++;
            await supabase.from('event_log').insert({
              type: 'sollecito_inviato', level: 'info', payload: payload as never,
              message: `[sollecito] conv ${c.id}: sollecito inviato da ${from} ${payload.oreDallApertura}h dopo l'apertura`,
            });
          } else if (!res.capped) {
            await supabase.from('event_log').insert({
              type: 'sollecito_fallito', level: 'warn', payload: { ...payload, error: res.error ?? null } as never,
              message: `[sollecito] conv ${c.id}: sollecito non partito (${res.error ?? 'errore'})`,
            });
          }
        } else {
          // discard_dead / non_risposto li gestisce bot-followups; wait = niente.
          skipped++;
        }
        continue;
      }

      // ── Track B: ha risposto poi silenzio ───────────────────────────────
      trackB++;
      // Il nudge e' un follow-up: con la sequenza spenta non parte.
      if (!sequenzaAccesa) {
        skipped++;
        continue;
      }
      const lastInboundAtMs = msgs.reduce<number>(
        (acc, m) => (m.direction === 'in' ? Math.max(acc, Date.parse(m.created_at)) : acc),
        0,
      );
      const action = decideTrackB({
        nowMs: now,
        lastInboundAtMs,
        nudgesSent: (c.bot_followups_sent as number | null) ?? 0,
        sequenceEnabled: sequenzaAccesa,
      });

      if (action.kind !== 'nudge_free') {
        // classify lo fa bot-followups; wait = niente. I template di riaggancio
        // non esistono più: fuori dalla finestra 24h non si insegue.
        skipped++;
        continue;
      }

      // Anti-doppione: mai un nudge sopra un out recente.
      const lastOut = lastOutboundAtMs(msgs);
      if (lastOut !== null && now - lastOut < MIN_GAP_OUT_MS) {
        skipped++;
        continue;
      }

      // Ricontrolla la finestra 24h WhatsApp: fuori finestra niente free text.
      if (now - lastInboundAtMs >= NUDGE1_MAX_H * H) {
        skipped++;
        continue;
      }
      const slugScheda = usaNudgeScheda(c as { scheda_inviata_at: string | null; bot_outcome: string | null; professione: string | null });
      const body = slugScheda ? pickNudgeTextScheda(firstName, slugScheda) : pickNudgeText(c.id, firstName, PERSONA_NAME[persona]);
      sent++;
      const res = await sendFreeText({ to: phone, body, from });
      await supabase.from('messages').insert({
        conversation_id: c.id,
        direction: 'out',
        body,
        twilio_sid: res.sid,
        twilio_status: res.status,
        is_template: false,
        sender: 'automazione',
      });
      await supabase
        .from('conversations')
        .update({
          last_message_at: new Date().toISOString(),
          bot_followups_sent: (((c.bot_followups_sent as number | null) ?? 0) + 1),
        })
        .eq('id', c.id);
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
    payload: { sent, skipped, trackA, trackB, sequenzaAccesa, apertureDifferite, ...(touchAb ? { touchAb: { numero: touchAb.config.numero, puoInviare: touchAb.puoInviare, inviati: touchAbInviati } } : {}), ...(sollecito ? { sollecitiInviati, sollecitoSaltati } : {}) } as never,
    message: `[sequenza] run: ${sent} invii, ${skipped} skip (A=${trackA}, B=${trackB})`,
    level: 'info',
  });

  return NextResponse.json({ ok: true, sent, skipped, trackA, trackB });
}
