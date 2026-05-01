import { NextResponse } from 'next/server';
import { getSupabaseServer } from '@/lib/supabase/server';
import { CampaignSchema } from '@/lib/schemas';

export const runtime = 'nodejs';

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const supabase = await getSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return new NextResponse('unauthorized', { status: 401 });
  const body = await req.json().catch(() => ({}));
  const parsed = CampaignSchema.partial().safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: 'validation', details: parsed.error.flatten() }, { status: 400 });
  const { data, error } = await supabase
    .from('campaigns').update(parsed.data).eq('id', parseInt(id, 10)).select('*').single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ data });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const supabase = await getSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return new NextResponse('unauthorized', { status: 401 });
  // Soft delete: active=false (preserva storico messaggi)
  const { error } = await supabase.from('campaigns').update({ active: false }).eq('id', parseInt(id, 10));
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
