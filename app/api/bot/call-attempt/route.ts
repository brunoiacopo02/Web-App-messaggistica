import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { verifySignature } from '@/lib/bot-hmac';
import { parseCallAttempt, tentativoGestito } from '@/lib/call-attempt';
import { puoScrivere, type StatoConversazione } from '@/lib/recupero-nr';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Supa = ReturnType<typeof getSupabaseAdmin>;

/**
 * Il CRM chiama qui quando una Conferma prova a telefonare a un lead e non lo trova.
 * Questo endpoint decide SE scrivere su WhatsApp — l'invio vero non c'è ancora (vedi
 * `inviaRecuperoNr` sotto): risponde sempre `inviato:false`, con un motivo.
 *
 * Stessa firma HMAC di `/api/bot/intake`. Come loro, si risponde sempre 200 tranne che
 * su firma/config/parse: il CRM non ritenta, e un 500 nostro perderebbe il lead senza
 * lasciare traccia da nessuna parte.
 */
// Niente rate limit qui, a differenza degli altri endpoint /api/bot/*: un 429 sarebbe
// un quinto codice di risposta oltre ai tre ammessi (firma/config/parse), e su un
// evento di mancata risposta che il CRM non ritenta si perderebbe senza lasciare
// traccia — lo stesso danno che il vincolo "sempre 200" esiste per evitare. La difesa
// contro il traffico non autenticato è già la firma HMAC, verificata prima di tutto.
export async function POST(req: NextRequest) {
  const secret = process.env.BOT_WEBHOOK_SECRET;
  if (!secret) return NextResponse.json({ ok: false, error: 'not_configured' }, { status: 503 });

  const rawBody = await req.text();
  const check = verifySignature(rawBody, req.headers.get('x-bot-signature'), secret);
  if (!check.valid) return NextResponse.json({ ok: false, error: 'invalid_signature' }, { status: 401 });

  let json: unknown;
  try { json = JSON.parse(rawBody); } catch { return NextResponse.json({ ok: false, error: 'invalid_json' }, { status: 400 }); }

  const parsed = parseCallAttempt(json);
  if (!parsed.ok) return NextResponse.json({ ok: false, error: parsed.reason }, { status: 400 });
  const evento = parsed.value;

  const supabase = getSupabaseAdmin();

  const conv = await trovaConversazione(supabase, evento.leadId);
  if (!conv) return NextResponse.json({ ok: true, inviato: false, motivo: 'lead_sconosciuto' });

  const stato = await costruisciStato(supabase, conv, evento.tentativo);

  // Il tentativo 2 (e ogni altro non gestito) è un evento valido che non produce un
  // messaggio: si registra la ricezione nella risposta, senza toccare event_log — non
  // è una decisione presa sulla conversazione, è semplicemente fuori dal perimetro.
  if (!tentativoGestito(evento.tentativo)) {
    return NextResponse.json({ ok: true, inviato: false, motivo: 'tentativo_non_gestito' });
  }

  const verdetto = puoScrivere(stato, evento, Date.now());
  if (!verdetto.ok) {
    await supabase.from('event_log').insert({
      type: 'recupero_nr_saltato',
      payload: { conversationId: conv.id, crmLeadId: evento.leadId, tentativo: evento.tentativo, motivo: verdetto.motivo } as never,
      message: `[crm] recupero non-risposta saltato per il lead ${evento.leadId} (tentativo ${evento.tentativo}): ${verdetto.motivo}`,
      level: 'info',
    });
    return NextResponse.json({ ok: true, inviato: false, motivo: verdetto.motivo });
  }

  await inviaRecuperoNr(supabase, { conversationId: conv.id, crmLeadId: evento.leadId, tentativo: evento.tentativo });
  return NextResponse.json({ ok: true, inviato: false, motivo: 'invio_non_ancora_attivo' });
}

type ConversazioneTrovata = Pick<
  StatoConversazione,
  'ai_owner' | 'ai_status' | 'bot_outcome' | 'bot_scheduled_at' | 'cancel_requested_at'
> & { id: number };

/** L'ultima conversazione per questo lead CRM, o null se non l'abbiamo mai avuta. */
async function trovaConversazione(supabase: Supa, leadId: string): Promise<ConversazioneTrovata | null> {
  const { data } = await supabase
    .from('conversations')
    .select('id, ai_owner, ai_status, bot_outcome, bot_scheduled_at, cancel_requested_at')
    .eq('crm_lead_id', leadId)
    .order('id', { ascending: false })
    .limit(1);
  return ((data ?? []) as unknown as ConversazioneTrovata[])[0] ?? null;
}

/**
 * Completa `StatoConversazione` con le due cose che `puoScrivere` non può vedere da
 * `conversations`: l'ultimo messaggio in arrivo dal lead, e se un recupero per QUESTO
 * tentativo è già partito (dedup: il CRM può richiamarci sullo stesso tentativo).
 */
async function costruisciStato(supabase: Supa, conv: ConversazioneTrovata, tentativo: number): Promise<StatoConversazione> {
  const { data: inbound } = await supabase
    .from('messages')
    .select('created_at')
    .eq('conversation_id', conv.id)
    .eq('direction', 'in')
    .order('created_at', { ascending: false })
    .limit(1);
  const ultimoInboundAt = ((inbound ?? []) as unknown as { created_at: string }[])[0]?.created_at ?? null;

  const { data: giaInviato } = await supabase
    .from('event_log')
    .select('id')
    .eq('type', 'recupero_nr_inviato')
    .eq('payload->>conversationId', String(conv.id))
    .eq('payload->>tentativo', String(tentativo))
    .limit(1);
  const giaInviatoTentativo = ((giaInviato ?? []) as unknown as { id: number }[]).length > 0;

  return {
    ai_owner: conv.ai_owner,
    ai_status: conv.ai_status,
    bot_outcome: conv.bot_outcome,
    bot_scheduled_at: conv.bot_scheduled_at,
    cancel_requested_at: conv.cancel_requested_at,
    ultimoInboundAt,
    giaInviatoTentativo,
  };
}

/**
 * PUNTO DI INNESTO — qui arriva solo dopo che `puoScrivere` ha detto sì. Per ora si
 * limita a registrare che il recupero sarebbe partito: l'invio vero su WhatsApp (il
 * template approvato, il numero, la scrittura del messaggio) lo aggiunge il task
 * successivo, sostituendo il corpo di questa funzione. Il resto del route non cambia.
 */
async function inviaRecuperoNr(
  supabase: Supa,
  ctx: { conversationId: number; crmLeadId: string; tentativo: number },
): Promise<void> {
  await supabase.from('event_log').insert({
    type: 'recupero_nr_da_inviare',
    payload: { conversationId: ctx.conversationId, crmLeadId: ctx.crmLeadId, tentativo: ctx.tentativo } as never,
    message: `[crm] recupero non-risposta pronto per il lead ${ctx.crmLeadId} (tentativo ${ctx.tentativo}) — invio non ancora attivo`,
    level: 'info',
  });
}
