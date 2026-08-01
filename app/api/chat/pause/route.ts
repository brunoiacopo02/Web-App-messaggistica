import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getSupabaseServer } from '@/lib/supabase/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { isConversazioneChat } from '@/lib/chat-perimetro';

export const runtime = 'nodejs';

const Body = z.object({
  conversation_id: z.coerce.number().int().positive(),
  paused: z.boolean(),
});

/**
 * Fermo manuale del bot su una conversazione: un umano prende (o restituisce) le
 * redini della chat dal pannello /chat.
 *
 * Il fermo vive su `ai_paused_at` e non su `ai_status` perché il `finally` di
 * `drainMarioReplies` riscrive lo stato a fine turno: un fermo messo lì veniva
 * cancellato da un drain già in volo e il bot ripartiva (conv 3748, 1/08/2026).
 * `ai_lock_at` non si tocca: se un turno è in corso lo rilascia lui, e il suo
 * rilascio ora rispetta la pausa.
 */
export async function POST(req: Request) {
  const supabase = await getSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return new NextResponse('unauthorized', { status: 401 });

  let raw;
  try { raw = await req.json(); } catch { return NextResponse.json({ error: 'invalid json' }, { status: 400 }); }
  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: 'validation', details: parsed.error.flatten() }, { status: 400 });
  }
  const { conversation_id: id, paused } = parsed.data;

  // Stesso perimetro della pagina: da /chat si governano solo le chat del mondo Fenice.
  if (!(await isConversazioneChat(supabase, id))) {
    return NextResponse.json({ error: 'conversation not found' }, { status: 404 });
  }

  const admin = getSupabaseAdmin();
  const pausedAt = paused ? new Date().toISOString() : null;
  const { error } = await admin
    .from('conversations')
    .update({ ai_paused_at: pausedAt })
    .eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await admin.from('event_log').insert({
    type: paused ? 'bot_paused' : 'bot_resumed',
    payload: { conversationId: id, by: user.email ?? user.id } as never,
    message: paused
      ? `[chat] bot fermato sulla conv ${id} da ${user.email ?? user.id}`
      : `[chat] bot riattivato sulla conv ${id} da ${user.email ?? user.id}`,
    level: 'warn',
  });

  return NextResponse.json({ ok: true, paused, paused_at: pausedAt });
}
