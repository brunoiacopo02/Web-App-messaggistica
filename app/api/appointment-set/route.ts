import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { verifySignature } from '@/lib/bot-hmac';
import { parseAppointmentSetPayload } from '@/lib/bot-contract';
import { runAppointmentSet } from '@/lib/appointment-set';
import { checkRateLimit } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Il CRM ci chiama a ogni appuntamento fissato o spostato per darci data e ora. Prima
// del 07/08 questo endpoint non esisteva e le loro chiamate morivano in un 404 di
// Vercel, in silenzio: la colonna gdo_appuntamento_at e' nata vuota a luglio proprio
// per questo (vedi la migration 20260801000001_gdo_video_followup.sql).
//
// Non abbiamo la loro specifica scritta, e le chiamate finite in 404 non hanno lasciato
// traccia: il parser accetta gli alias plausibili dei nomi dei campi e ogni corpo non
// riconosciuto finisce intero nell'event_log. Il primo giorno di traffico vero vale piu'
// di un documento.
//
// Stessa firma HMAC di /api/send-agenda.

const MESSAGGIO: Record<string, string> = {
  lead_mancante: "Manca l'identificativo del lead. Accettiamo leadId, lead_id, crmLeadId o crm_lead_id.",
  data_mancante: "Manca la data dell'appuntamento. Accettiamo appointmentAt, appuntamentoAt, scheduledAt, date o at.",
  data_senza_offset: "La data deve essere ISO 8601 con offset di fuso, es. 2026-08-07T18:00:00+02:00. Senza offset non sappiamo se l'ora e' italiana o UTC, e non vogliamo indovinare.",
  bad_request: 'Corpo della richiesta non valido: atteso un oggetto JSON.',
};

export async function POST(req: NextRequest) {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  const rl = checkRateLimit(`appuntamento:${ip}`, 120, 60_000);
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

  const parsed = parseAppointmentSetPayload(json);
  const supabase = getSupabaseAdmin();

  if (!parsed.ok) {
    // Il corpo grezzo e' la cosa piu' preziosa che abbiamo finche' non conosciamo il
    // loro schema: senza questa riga un campo con un nome diverso resterebbe invisibile
    // esattamente come lo sono state le chiamate finite in 404.
    await supabase.from('event_log').insert({
      type: 'appuntamento_payload_ignoto',
      payload: { reason: parsed.reason, body: rawBody.slice(0, 2000) } as never,
      message: `[crm] payload di /api/appointment-set non riconosciuto (${parsed.reason})`,
      level: 'warn',
    });
    return NextResponse.json(
      { ok: false, error: parsed.reason, message: MESSAGGIO[parsed.reason] },
      { status: 400 },
    );
  }

  try {
    return NextResponse.json(await runAppointmentSet(supabase, parsed.value));
  } catch (e) {
    const error = e instanceof Error ? e.message : 'errore';
    await supabase.from('event_log').insert({
      type: 'appuntamento_errore',
      payload: { crmLeadId: parsed.value.leadId, error } as never,
      message: `[crm] registrazione della data fallita per il lead ${parsed.value.leadId}: ${error}`,
      level: 'error',
    });
    return NextResponse.json({ ok: false, error }, { status: 500 });
  }
}
