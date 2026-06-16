import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseServer } from '@/lib/supabase/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { getAutoReply, setAutoReply } from '@/lib/fenice-settings';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function requireUser() {
  const authed = await getSupabaseServer();
  const { data: { user } } = await authed.auth.getUser();
  return user;
}

export async function GET() {
  if (!(await requireUser())) return new NextResponse('unauthorized', { status: 401 });
  const on = await getAutoReply(getSupabaseAdmin());
  return NextResponse.json({ on });
}

export async function POST(req: NextRequest) {
  if (!(await requireUser())) return new NextResponse('unauthorized', { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { on?: boolean };
  await setAutoReply(getSupabaseAdmin(), body.on === true);
  return NextResponse.json({ ok: true, on: body.on === true });
}
