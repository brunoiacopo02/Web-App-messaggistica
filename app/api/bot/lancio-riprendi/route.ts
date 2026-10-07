import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { verifySignature } from '@/lib/bot-hmac';
import { HANDOFF_VERGINI, parseRiprendi, ripresaVergine, type ConvVergine } from '@/lib/lancio-vergini';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Il CRM chiama qui quando il TL restituisce al bot N lead del pool "lead del lancio mai
 * contattati dal bot" (lib/lancio-vergini.ts). Qui non parte nessun messaggio: la chat
 * torna alla fase di prima del blocco e il cron del follow-up la riprende al suo giro,
 * con le sue regole (finestra oraria, tetto giornaliero, template approvato).
 *
 * Stessa firma HMAC di `/api/bot/intake`. Risponde con quanti ne ha ripresi e quali no:
 * un lead che nel frattempo qualcun altro ha preso (pulsante del webinar, un GDO) non si
 * tocca.
 */
export async function POST(req: NextRequest) {
  const secret = process.env.BOT_WEBHOOK_SECRET;
  if (!secret) return NextResponse.json({ ok: false, error: 'not_configured' }, { status: 503 });

  const rawBody = await req.text();
  const check = verifySignature(rawBody, req.headers.get('x-bot-signature'), secret);
  if (!check.valid) return NextResponse.json({ ok: false, error: 'invalid_signature' }, { status: 401 });

  let json: unknown;
  try { json = JSON.parse(rawBody); } catch { return NextResponse.json({ ok: false, error: 'invalid_json' }, { status: 400 }); }

  const parsed = parseRiprendi(json);
  if (!parsed.ok) return NextResponse.json({ ok: false, error: parsed.reason }, { status: 400 });

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from('conversations')
    .select('id, crm_lead_id, handed_off_reason, lancio_info')
    .in('crm_lead_id', parsed.leadIds)
    .eq('handed_off_reason', HANDOFF_VERGINI);
  if (error) return NextResponse.json({ ok: false, error: 'db_error' }, { status: 500 });

  const rows = (data ?? []) as unknown as (ConvVergine & { crm_lead_id: string })[];
  const adesso = new Date();
  const ripresi: string[] = [];
  for (const conv of rows) {
    const update = ripresaVergine(conv, adesso);
    if (!update) continue;
    // Il filtro sul motivo anche nell'update: se tra la lettura e qui qualcun altro ha
    // preso la chat, questa riga non la sovrascrive.
    const { data: fatto } = await supabase
      .from('conversations')
      .update(update as never)
      .eq('id', conv.id)
      .eq('handed_off_reason', HANDOFF_VERGINI)
      .select('id');
    if ((fatto ?? []).length > 0) ripresi.push(conv.crm_lead_id);
  }

  const nonRipresi = parsed.leadIds.filter((id) => !ripresi.includes(id));
  await supabase.from('event_log').insert({
    type: 'lancio_vergini_ripresi',
    payload: { richiesti: parsed.leadIds.length, ripresi: ripresi.length, nonRipresi } as never,
    message: `[lancio] pool vergini: ${ripresi.length} lead ridati al bot su ${parsed.leadIds.length} richiesti`,
    level: nonRipresi.length > 0 ? 'warn' : 'info',
  });

  return NextResponse.json({ ok: true, ripresi, nonRipresi });
}
