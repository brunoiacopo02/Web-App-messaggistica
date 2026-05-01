import { NextResponse } from 'next/server';
import { getSupabaseServer } from '@/lib/supabase/server';
export const runtime = 'nodejs';

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const conversationId = parseInt(id, 10);
  const supabase = await getSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return new NextResponse('unauthorized', { status: 401 });

  const now = new Date().toISOString();
  await supabase.from('messages')
    .update({ read_at: now })
    .eq('conversation_id', conversationId)
    .eq('direction', 'in')
    .is('read_at', null);
  await supabase.from('conversations').update({ unread_count: 0 }).eq('id', conversationId);
  return NextResponse.json({ ok: true });
}
