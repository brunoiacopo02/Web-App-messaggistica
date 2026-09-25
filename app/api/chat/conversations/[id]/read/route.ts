import { NextResponse } from 'next/server';
import { getSupabaseServer } from '@/lib/supabase/server';
import { isConversazioneChat } from '@/lib/chat-perimetro';
export const runtime = 'nodejs';

/**
 * Segna letta una conversazione aperta dal pannello /chat.
 *
 * Il pannello era nato senza marcatura "letto" (spec 2026-07-31: chi supervisiona non
 * deve alterare lo stato di chi lavora). Ma sulle chat governate dal bot
 * (`ai_owner='mario'`, anche i GDO postino) nessun altro pannello legge
 * `unread_count` — /inbox le esclude, /fenice non lo mostra — e nessuno lo azzerava
 * mai: il webhook lo incrementa a ogni messaggio del lead e il pallino verde restava
 * acceso per sempre (9.211 chat su 14.373 al 25/09/2026). Qui il contatore è di chi
 * guarda /chat, e si azzera.
 *
 * Le chat di campagna e i GDO serviti dal solo video restano come prima: il loro
 * contatore lo governano /campagne-chat e /inbox, e aprirle da qui non lo tocca.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const conversationId = parseInt(id, 10);
  const supabase = await getSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return new NextResponse('unauthorized', { status: 401 });

  if (Number.isNaN(conversationId)) return new NextResponse('bad request', { status: 400 });
  if (!(await isConversazioneChat(supabase, conversationId))) {
    return NextResponse.json({ error: 'conversation not found' }, { status: 404 });
  }

  const { data: conv } = await supabase
    .from('conversations').select('ai_owner').eq('id', conversationId).maybeSingle();
  if ((conv as { ai_owner?: string | null } | null)?.ai_owner !== 'mario') {
    return NextResponse.json({ ok: true, marked: false });
  }

  const now = new Date().toISOString();
  const msgs = await supabase.from('messages')
    .update({ read_at: now })
    .eq('conversation_id', conversationId)
    .eq('direction', 'in')
    .is('read_at', null);
  if (msgs.error) return NextResponse.json({ error: msgs.error.message }, { status: 500 });
  const upd = await supabase.from('conversations').update({ unread_count: 0 }).eq('id', conversationId);
  if (upd.error) return NextResponse.json({ error: upd.error.message }, { status: 500 });
  return NextResponse.json({ ok: true, marked: true });
}
