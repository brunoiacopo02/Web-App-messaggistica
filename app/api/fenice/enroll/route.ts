import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseServer } from '@/lib/supabase/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { toE164 } from '@/lib/phone';
import { enrollLeadIntoMario } from '@/lib/fenice-enroll';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const authed = await getSupabaseServer();
  const { data: { user } } = await authed.auth.getUser();
  if (!user) return new NextResponse('unauthorized', { status: 401 });

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const phone = toE164((body.phone ?? null) as string | null);
  if (!phone) return NextResponse.json({ ok: false, error: 'telefono non valido' }, { status: 400 });

  const firstName = (body.firstName ?? body.first_name) as string | undefined;

  try {
    const res = await enrollLeadIntoMario(getSupabaseAdmin(), { phone, firstName });
    return NextResponse.json({ ok: res.ok, conversationId: res.conversationId, sid: res.sid, error: res.error });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : 'errore' }, { status: 500 });
  }
}
