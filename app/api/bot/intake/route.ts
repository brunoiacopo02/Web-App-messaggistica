import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { verifySignature } from '@/lib/bot-hmac';
import { parseIntakePayload } from '@/lib/bot-contract';
import { enrollLeadIntoMario } from '@/lib/fenice-enroll';
import { toE164 } from '@/lib/phone';
import { checkRateLimit } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  const rl = checkRateLimit(`botintake:${ip}`, 60, 60_000);
  if (!rl.ok) return new NextResponse('rate limit', { status: 429 });

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
    return NextResponse.json({ ok: true, skipped: 'invalid_phone' });
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
    return NextResponse.json({ ok: true });
  } catch (e) {
    await supabase.from('event_log').insert({
      type: 'bot_intake_error',
      payload: { crmLeadId: p.leadId, error: e instanceof Error ? e.message : 'errore' } as never,
      message: `[bot-fissatore] intake fallito lead ${p.leadId}`,
      level: 'error',
    });
    // Best-effort: il CRM non ritenta. Rispondiamo 200 per non far figurare l'endpoint down.
    return NextResponse.json({ ok: true, error: 'enroll_failed' });
  }
}
