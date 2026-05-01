import { NextResponse } from 'next/server';
import { getSupabaseServer } from '@/lib/supabase/server';
import { CampaignSchema } from '@/lib/schemas';

export const runtime = 'nodejs';

export async function GET() {
  const supabase = await getSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return new NextResponse('unauthorized', { status: 401 });
  const { data, error } = await supabase
    .from('campaigns').select('*').order('created_at', { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ data });
}

export async function POST(req: Request) {
  const supabase = await getSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return new NextResponse('unauthorized', { status: 401 });
  const body = await req.json().catch(() => ({}));
  const parsed = CampaignSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: 'validation', details: parsed.error.flatten() }, { status: 400 });
  const { data, error } = await supabase.from('campaigns').insert(parsed.data).select('*').single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ data });
}
