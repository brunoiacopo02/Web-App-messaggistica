import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { verifySignature } from '@/lib/bot-hmac';
import { parseSendAgendaPayload } from '@/lib/bot-contract';
import { runSendAgenda } from '@/lib/send-agenda-gdo';
import { checkRateLimit } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// L'attesa della consegna è di 8s: il default basterebbe, il margine è per la coda.
export const maxDuration = 30;

// Il CRM chiama questo endpoint quando un GDO, al telefono col lead, preme "Agenda".
// Il bot fa da postino: manda il link per prenotare e poi il video (alla prima
// risposta del lead), ma il lead resta del GDO — vedi lib/send-agenda-gdo.ts.
//
// Sostituisce il vecchio flusso ActiveCampaign su questo stesso path (auth a bearer
// token e template legacy, fermo dal 19/06): il percorso vecchio non consegnava più,
// ed è il motivo per cui questo endpoint esiste.
//
// Risposta: sempre 200 con `esito` fra consegnato | inviato | fallito quando la
// richiesta è valida. Gli stati HTTP restano per i soli errori di protocollo, così il
// client del CRM non deve leggere un 4xx per capire che il telefono del lead è spento.

const MESSAGGIO: Record<string, string> = {
  consegnato: 'Messaggio consegnato al lead.',
  inviato: 'Messaggio inviato ma non ancora consegnato (telefono spento o offline): non reinviare, arriverà appena il lead torna online.',
  fallito: 'Invio fallito: puoi ritentare.',
};

export async function POST(req: NextRequest) {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  const rl = checkRateLimit(`sendagenda:${ip}`, 120, 60_000);
  if (!rl.ok) return new NextResponse('rate limit', { status: 429 });

  const secret = process.env.BOT_WEBHOOK_SECRET;
  if (!secret) return NextResponse.json({ ok: false, error: 'not_configured' }, { status: 503 });

  const rawBody = await req.text();
  const check = verifySignature(rawBody, req.headers.get('x-bot-signature'), secret);
  if (!check.valid) return NextResponse.json({ ok: false, error: 'invalid_signature' }, { status: 401 });

  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid_json' }, { status: 400 });
  }

  const parsed = parseSendAgendaPayload(json);
  if (!parsed.ok) {
    const status = parsed.reason === 'forbidden' ? 403 : 400;
    return NextResponse.json({ ok: false, error: parsed.reason }, { status });
  }

  const supabase = getSupabaseAdmin();
  try {
    const res = await runSendAgenda(supabase, parsed.value);
    return NextResponse.json({
      ok: res.ok,
      esito: res.esito,
      message: MESSAGGIO[res.esito],
      deduplicato: res.deduplicato ?? false,
      conversationId: res.conversationId,
      sid: res.sid,
      error: res.error,
    });
  } catch (e) {
    const error = e instanceof Error ? e.message : 'errore';
    await supabase.from('event_log').insert({
      type: 'gdo_agenda_error',
      payload: { crmLeadId: parsed.value.leadId, error } as never,
      message: `[gdo] invio agenda fallito per il lead ${parsed.value.leadId}: ${error}`,
      level: 'error',
    });
    // Il GDO è al telefono: un esito esplicito vale più di un 500 da interpretare.
    return NextResponse.json({ ok: false, esito: 'fallito', message: MESSAGGIO.fallito, error });
  }
}
