import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { verifySignature } from '@/lib/bot-hmac';
import { parseIntakePayload } from '@/lib/bot-contract';
import { enrollLeadIntoMario } from '@/lib/fenice-enroll';
import { toE164 } from '@/lib/phone';
import { checkRateLimit } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Perché la risposta dice `accettato` (dal 29/08/2026).
 *
 * Fino a ieri questo endpoint rispondeva `200 {ok:true}` anche quando il lead non lo
 * prendeva in carico — telefono inventato, arruolamento fallito. Era voluto (il CRM non
 * ritenta e un 500 avrebbe solo fatto rumore) ma dal loro lato un lead scartato era
 * indistinguibile da uno lavorato: è la radice della disputa sui "lead fermi al bot" e
 * il motivo per cui le loro statistiche sul bot sovrastimano i lead presi in carico.
 *
 * Lo status resta 200 per la stessa ragione di prima. Cambia il corpo: `accettato:false`
 * più un `motivo`, così la loro colonna "lavorato dal bot" torna vera senza che nessuno
 * debba riconciliare a mano.
 */
type Motivo = 'telefono_non_valido' | 'arruolamento_fallito' | 'apertura_non_partita';

/**
 * Perché il soffitto sta a 600/minuto (dal 09/09/2026).
 *
 * Era 60/min, dimensionato su un intake da 200 lead al giorno. Con i GDO che scaricano
 * a raffica (picco misurato: 31 lead in un minuto il 03/09) e il CRM che passa a 30/min
 * il margine era metà, e superarlo non è un rallentamento: è una perdita. Il CRM non
 * ritenta, quindi ogni 429 era un lead che nessuno dei due lati lavorava e che non
 * compariva in nessun conteggio — la stessa famiglia di problemi dei "lead fermi al bot".
 *
 * Il limite resta perché serve contro il loop impazzito, non contro il volume vero: a
 * 600/min un blast da 30/min ha venti volte il margine che gli serve. E il 429 ora dice
 * `ritenta` con i secondi da aspettare, così anche il giorno che lo tocchiamo il lead
 * non evapora.
 */
const INTAKE_MAX_PER_MIN = Math.max(1, Number(process.env.BOT_INTAKE_MAX_PER_MIN) || 600);

export async function POST(req: NextRequest) {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  const rl = checkRateLimit(`botintake:${ip}`, INTAKE_MAX_PER_MIN, 60_000);
  if (!rl.ok) {
    const dopoSecondi = Math.max(1, Math.ceil((rl.resetAt - Date.now()) / 1000));
    // Un rifiuto per rate limit va lasciato per iscritto. Finora non lo era, e la
    // domanda del CRM ("quando scatta, rispondete 429 o non rispondete?") non aveva
    // modo di trovare risposta nei dati: da noi non restava traccia, da loro un rifiuto
    // muto sarebbe indistinguibile da un timeout. Se questa riga non compare, il tetto
    // non è scattato — e il problema è altrove.
    await getSupabaseAdmin().from('event_log').insert({
      type: 'bot_intake_rate_limited',
      payload: { ip, dopoSecondi, tetto: INTAKE_MAX_PER_MIN } as never,
      message: `[bot-fissatore] intake rifiutato per rate limit (${INTAKE_MAX_PER_MIN}/min), ritenta tra ${dopoSecondi}s`,
      level: 'warn',
    });
    return NextResponse.json(
      { ok: false, error: 'rate_limited', accettato: false, ritenta: true, dopoSecondi },
      { status: 429, headers: { 'retry-after': String(dopoSecondi) } },
    );
  }

  const secret = process.env.BOT_WEBHOOK_SECRET;
  if (!secret) return NextResponse.json({ ok: false, error: 'not_configured' }, { status: 503 });

  const rawBody = await req.text();
  const check = verifySignature(rawBody, req.headers.get('x-bot-signature'), secret);
  if (!check.valid) return NextResponse.json({ ok: false, error: 'invalid_signature' }, { status: 401 });

  let json: unknown;
  try { json = JSON.parse(rawBody); } catch { return NextResponse.json({ ok: false, error: 'invalid_json' }, { status: 400 }); }

  const parsed = parseIntakePayload(json);
  if (!parsed.ok) {
    const status = parsed.reason === 'forbidden' ? 403 : 400;
    return NextResponse.json({ ok: false, error: parsed.reason }, { status });
  }
  const p = parsed.value;

  const supabase = getSupabaseAdmin();
  const phone = toE164(p.phone);
  if (!phone) {
    await supabase.from('event_log').insert({
      type: 'bot_intake_skipped',
      payload: { crmLeadId: p.leadId, phone: p.phone } as never,
      message: `[bot-fissatore] phone non normalizzabile per lead ${p.leadId}: ${p.phone}`,
      level: 'warn',
    });
    return NextResponse.json({
      ok: true, skipped: 'invalid_phone', accettato: false, motivo: 'telefono_non_valido' satisfies Motivo,
    });
  }

  try {
    const res = await enrollLeadIntoMario(supabase, {
      phone,
      firstName: p.name,
      email: p.email,
      crmLeadId: p.leadId,
      crmFunnel: p.funnel,
    });
    await supabase.from('event_log').insert({
      type: 'bot_intake',
      payload: { crmLeadId: p.leadId, conversationId: res.conversationId, ok: res.ok } as never,
      message: `[bot-fissatore] intake lead ${p.leadId} → conv ${res.conversationId}`,
      level: 'info',
    });

    // Ritento dello stesso leadId (429 o timeout del loro AbortSignal a 5s): l'apertura
    // era già partita al primo giro. Il lead è preso in carico — `accettato:true` — ma
    // `duplicato:true` dice che questo giro non ha aggiunto niente, così il ritento è
    // sicuro da fare e non gonfia i loro conteggi.
    if (res.duplicato) {
      return NextResponse.json({
        ok: true, accettato: true, duplicato: true,
        conversationId: res.conversationId, leadIdCorrente: p.leadId,
      });
    }

    // La stessa persona sotto un `leadId` nuovo. Noi deduplichiamo per numero — una
    // persona ha una chat sola — quindi da qui in poi i nostri esiti viaggiano sotto
    // QUESTO leadId, e i giri precedenti restano dove sono. È la cosa che il 29/08 ha
    // spiegato i 30 lead "fermi al bot" che il bot aveva invece lavorato: l'esito era
    // partito sotto l'id di prima.
    const precedenti = await leadIdPrecedenti(supabase, res.conversationId, p.leadId);
    const daiLoro = p.previousLeadIds ?? [];
    const noti = [...new Set([...precedenti, ...daiLoro.map((l) => l.leadId)])]
      .filter((id) => id !== p.leadId);
    if (noti.length > 0 || p.personKey) {
      await supabase.from('event_log').insert({
        type: 'bot_intake_persona_ricorrente',
        payload: {
          crmLeadId: p.leadId, conversationId: res.conversationId,
          personKey: p.personKey, leadIdPrecedenti: noti,
          esitiPrecedenti: daiLoro.map((l) => ({ leadId: l.leadId, status: l.status, outcome: l.outcome })),
        } as never,
        message: noti.length > 0
          ? `[bot-fissatore] lead ${p.leadId}: stessa persona di ${noti.length} lead precedenti, conv ${res.conversationId}`
          : `[bot-fissatore] lead ${p.leadId}: prima comparsa della persona ${p.personKey}`,
        level: 'info',
      });
    }

    // L'apertura non partita è il caso che dal 24 al 28 agosto ha lasciato 27 lead senza
    // nemmeno un messaggio, mentre dal lato CRM risultavano consegnati. Un lead
    // arruolato ma muto non è un lead preso in carico, e va detto qui.
    if (!res.ok) {
      return NextResponse.json({
        ok: true, accettato: false, motivo: 'apertura_non_partita' satisfies Motivo,
        conversationId: res.conversationId, error: res.error,
      });
    }

    return NextResponse.json({
      ok: true,
      accettato: true,
      conversationId: res.conversationId,
      // Sotto quale id risponderemo: se la persona era già nostra, è questo il nuovo.
      leadIdCorrente: p.leadId,
      ...(noti.length > 0 ? { personaGiaVista: true, leadIdPrecedenti: noti } : {}),
      // Fuori dalla fascia 08:30–20:30 il lead è preso in carico ma l'apertura parte al
      // primo run in fascia: dirlo evita che risulti "senza attività" per qualche ora.
      ...(res.deferred ? { apertura: 'differita' } : {}),
    });
  } catch (e) {
    await supabase.from('event_log').insert({
      type: 'bot_intake_error',
      payload: { crmLeadId: p.leadId, error: e instanceof Error ? e.message : 'errore' } as never,
      message: `[bot-fissatore] intake fallito lead ${p.leadId}`,
      level: 'error',
    });
    // Best-effort: il CRM non ritenta. Rispondiamo 200 per non far figurare l'endpoint
    // down, ma `accettato: false` dice che questo lead non l'abbiamo preso.
    return NextResponse.json({
      ok: true, error: 'enroll_failed', accettato: false, motivo: 'arruolamento_fallito' satisfies Motivo,
    });
  }
}

/**
 * Gli altri `leadId` con cui questa stessa chat ci è già stata mandata. Si legge dal
 * nostro log di intake, non dal payload: il CRM manda `previousLeadIds` dal 29/08 e sui
 * giri precedenti non c'è: senza questa lettura, i duplicati vecchi resterebbero muti.
 */
async function leadIdPrecedenti(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  conversationId: number,
  leadIdCorrente: string,
): Promise<string[]> {
  const { data } = await supabase
    .from('event_log')
    .select('payload')
    .eq('type', 'bot_intake')
    .eq('payload->>conversationId', String(conversationId))
    .order('created_at', { ascending: false })
    .limit(20);
  const rows = (data ?? []) as { payload: { crmLeadId?: string } | null }[];
  return [...new Set(rows.map((r) => r.payload?.crmLeadId).filter((id): id is string => !!id && id !== leadIdCorrente))];
}
