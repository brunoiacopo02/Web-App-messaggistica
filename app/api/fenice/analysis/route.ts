import { NextResponse } from 'next/server';
import { getSupabaseServer } from '@/lib/supabase/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function requireUser() {
  const authed = await getSupabaseServer();
  const { data: { user } } = await authed.auth.getUser();
  return user;
}

export async function GET() {
  if (!(await requireUser())) return new NextResponse('unauthorized', { status: 401 });

  const admin = getSupabaseAdmin();
  const { data } = await admin
    .from('lead_analysis_reports')
    .select('generated_at, payload')
    .order('generated_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  return NextResponse.json({
    ok: true,
    generatedAt: data?.generated_at ?? null,
    report: (data?.payload as any) ?? null,
  });
}
