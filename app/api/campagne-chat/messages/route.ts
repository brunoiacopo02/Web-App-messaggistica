import { NextResponse } from 'next/server';
import { getSupabaseServer } from '@/lib/supabase/server';
import { SendMessageSchema } from '@/lib/schemas';
import { isFeniceConversation } from '@/lib/campagne';
import { sendConversationMessage } from '@/lib/conversation-send';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  const supabase = await getSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return new NextResponse('unauthorized', { status: 401 });

  let body;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'invalid json' }, { status: 400 }); }
  const parsed = SendMessageSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'validation', details: parsed.error.flatten() }, { status: 400 });
  }
  if (!(await isFeniceConversation(supabase, parsed.data.conversation_id))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  return sendConversationMessage(parsed.data);
}
