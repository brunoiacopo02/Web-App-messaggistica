import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { sendOutcome, type SendOutcomeArgs } from '@/lib/bot-outcome';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Recupero manuale: re-invia un esito al CRM per una conversazione, passando da
 * sendOutcome (quindi con tutte le guardie: lock APPUNTAMENTO, validazione date,
 * gestione 403). Serve per i casi tipo conv 3061 (booked senza callback) o i
 * backfill concordati col team CRM. Protetto da CRON_SECRET.
 *
 * POST { conversationId: number, outcome, date?, note?, discardReason? }
 */
export async function POST(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return new NextResponse('unauthorized', { status: 401 });
  }

  let body: { conversationId?: number } & Partial<SendOutcomeArgs>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'bad_json' }, { status: 400 });
  }
  if (typeof body.conversationId !== 'number' || !body.outcome) {
    return NextResponse.json({ ok: false, error: 'conversationId e outcome obbligatori' }, { status: 400 });
  }

  const supabase = getSupabaseAdmin();
  const res = await sendOutcome(supabase, body.conversationId, {
    outcome: body.outcome,
    date: body.date,
    note: body.note,
    discardReason: body.discardReason,
  });

  await supabase.from('event_log').insert({
    type: 'admin_resend_outcome',
    payload: { conversationId: body.conversationId, outcome: body.outcome, result: res } as never,
    message: `[admin] resend-outcome conv ${body.conversationId}: ${body.outcome} → ${res.sent ? 'ok' : res.error ?? res.status}`,
    level: res.sent ? 'info' : 'error',
  });

  return NextResponse.json({ ok: res.sent, ...res });
}
