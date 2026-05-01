import { NextResponse } from 'next/server';
import { getSupabaseServer } from '@/lib/supabase/server';
export const runtime = 'nodejs';

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const supabase = await getSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return new NextResponse('unauthorized', { status: 401 });
  await supabase.from('messages').update({ read_at: new Date().toISOString() }).eq('id', parseInt(id, 10)).is('read_at', null);
  return NextResponse.json({ ok: true });
}
