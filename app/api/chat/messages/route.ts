import { NextResponse } from 'next/server';
import { getSupabaseServer } from '@/lib/supabase/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { SendMessageSchema } from '@/lib/schemas';
import { sendConversationMessage } from '@/lib/conversation-send';
import { isConversazioneChat } from '@/lib/chat-perimetro';

export const runtime = 'nodejs';

/**
 * Invio manuale da /chat: è il canale con cui una persona raddrizza il tiro dopo
 * aver fermato il bot.
 *
 * Si può scrivere SOLO a bot fermo (`ai_paused_at` valorizzato). Senza questa
 * guardia due voci scriverebbero insieme sulla stessa chat: il lead riceverebbe la
 * risposta dell'operatore e quella del modello mescolate, e il modello leggerebbe
 * il messaggio umano come suo nel turno dopo.
 */
export async function POST(req: Request) {
  const supabase = await getSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return new NextResponse('unauthorized', { status: 401 });

  let raw;
  try { raw = await req.json(); } catch { return NextResponse.json({ error: 'invalid json' }, { status: 400 }); }
  const parsed = SendMessageSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: 'validation', details: parsed.error.flatten() }, { status: 400 });
  }
  const id = parsed.data.conversation_id;

  if (!(await isConversazioneChat(supabase, id))) {
    return NextResponse.json({ error: 'conversation not found' }, { status: 404 });
  }

  const admin = getSupabaseAdmin();
  const { data: conv } = await admin
    .from('conversations')
    .select('ai_paused_at')
    .eq('id', id)
    .single();
  if (!conv?.ai_paused_at) {
    return NextResponse.json({ error: 'bot_attivo' }, { status: 409 });
  }

  return sendConversationMessage(parsed.data);
}
