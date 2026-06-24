import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseServer } from '@/lib/supabase/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { generateLeadSummary } from '@/lib/mario-summary';
import type { MarioTurn } from '@/lib/mario';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function requireUser() {
  const authed = await getSupabaseServer();
  const { data: { user } } = await authed.auth.getUser();
  return user;
}

type MsgRow = { id: number; direction: 'in' | 'out'; body: string; created_at: string; is_template: boolean };

/** Carica una conversazione Mario: messaggi (dall'arruolamento) + report + riassunto in cache. */
export async function GET(req: NextRequest) {
  if (!(await requireUser())) return new NextResponse('unauthorized', { status: 401 });

  const id = Number(req.nextUrl.searchParams.get('id'));
  if (!Number.isFinite(id) || id <= 0) {
    return NextResponse.json({ ok: false, error: 'id non valido' }, { status: 400 });
  }

  const admin = getSupabaseAdmin();
  const { data: conv } = await admin
    .from('conversations')
    .select('id, ai_owner, ai_status, ai_started_at, last_message_at, created_at, ai_summary, ai_summary_at, bot_scheduled_at, leads(phone_e164, first_name, last_name, email)')
    .eq('id', id)
    .eq('ai_owner', 'mario')
    .maybeSingle();

  if (!conv) return NextResponse.json({ ok: false, error: 'conversazione non trovata' }, { status: 404 });

  const c = conv as any;
  const startedAt = c.ai_started_at as string | null;

  let q = admin
    .from('messages')
    .select('id, direction, body, created_at, is_template')
    .eq('conversation_id', id)
    .order('created_at', { ascending: true })
    .limit(500);
  if (startedAt) q = q.gte('created_at', startedAt);
  const { data: msgs } = await q;
  const messages = (msgs ?? []) as MsgRow[];

  const inbound = messages.filter((m) => m.direction === 'in').length;
  const outbound = messages.filter((m) => m.direction === 'out').length;

  return NextResponse.json({
    ok: true,
    lead: {
      phone: c.leads?.phone_e164 ?? '',
      firstName: c.leads?.first_name ?? '',
      lastName: c.leads?.last_name ?? '',
      email: c.leads?.email ?? '',
    },
    report: {
      status: c.ai_status as string | null,
      startedAt,
      lastMessageAt: c.last_message_at as string,
      scheduledAt: (c.bot_scheduled_at as string | null) ?? null,
      inbound,
      outbound,
      total: messages.length,
    },
    summary: c.ai_summary as string | null,
    summaryAt: c.ai_summary_at as string | null,
    messages,
  });
}

/** Genera (o rigenera) il riassunto AI del lead e lo salva in cache sulla conversazione. */
export async function POST(req: NextRequest) {
  if (!(await requireUser())) return new NextResponse('unauthorized', { status: 401 });

  const body = (await req.json().catch(() => ({}))) as { conversationId?: number };
  const id = Number(body.conversationId);
  if (!Number.isFinite(id) || id <= 0) {
    return NextResponse.json({ ok: false, error: 'id non valido' }, { status: 400 });
  }

  const admin = getSupabaseAdmin();
  const { data: conv } = await admin
    .from('conversations')
    .select('id, ai_owner, ai_started_at')
    .eq('id', id)
    .eq('ai_owner', 'mario')
    .maybeSingle();
  if (!conv) return NextResponse.json({ ok: false, error: 'conversazione non trovata' }, { status: 404 });

  const startedAt = (conv as { ai_started_at: string | null }).ai_started_at;
  let q = admin
    .from('messages')
    .select('direction, body, created_at')
    .eq('conversation_id', id)
    .order('created_at', { ascending: true })
    .limit(500);
  if (startedAt) q = q.gte('created_at', startedAt);
  const { data: msgs } = await q;

  const history: MarioTurn[] = ((msgs ?? []) as { direction: string; body: string }[]).map((m) => ({
    role: m.direction === 'in' ? 'user' : 'assistant',
    content: m.body,
  }));

  try {
    const summary = await generateLeadSummary(history);
    const summaryAt = new Date().toISOString();
    await admin.from('conversations')
      .update({ ai_summary: summary, ai_summary_at: summaryAt })
      .eq('id', id);
    return NextResponse.json({ ok: true, summary, summaryAt });
  } catch (err) {
    const m = err instanceof Error ? err.message : 'errore';
    return NextResponse.json({ ok: false, error: m }, { status: 500 });
  }
}
