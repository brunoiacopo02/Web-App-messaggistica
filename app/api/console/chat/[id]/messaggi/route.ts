import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { richiediAdmin } from '@/lib/console/guardia';
import { isConversazioneChat } from '@/lib/chat-perimetro';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX = 500;
const COLONNE = 'id, direction, body, created_at, is_template, twilio_status, twilio_error_code, sender';

/**
 * Messaggi di una chat per la console. Senza `dopo`: gli ULTIMI 500, in ordine crescente (la rotta
 * di /chat restituisce i primi 500, e in una chat lunga non si vedrebbero mai gli ultimi). Con
 * `?dopo=<id messaggio>`: solo quelli con id maggiore, crescenti, per il polling.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const admin = await richiediAdmin();
  if (!admin.ok) return admin.risposta;

  const { id } = await ctx.params;
  if (!/^\d+$/.test(id)) return NextResponse.json({ error: 'id_non_valido' }, { status: 400 });
  const dopoParam = new URL(req.url).searchParams.get('dopo');
  if (dopoParam != null && !/^\d+$/.test(dopoParam)) return NextResponse.json({ error: 'dopo_non_valido' }, { status: 400 });
  const convId = Number(id);

  const s = getSupabaseAdmin();
  if (!(await isConversazioneChat(s, convId))) return NextResponse.json({ error: 'chat_non_trovata' }, { status: 404 });

  const base = s.from('messages').select(COLONNE).eq('conversation_id', convId);
  const { data, error } =
    dopoParam != null
      ? await base.gt('id', Number(dopoParam)).order('id', { ascending: true }).limit(MAX)
      : await base.order('created_at', { ascending: false }).order('id', { ascending: false }).limit(MAX);
  if (error) return NextResponse.json({ error: 'lettura_fallita', dettaglio: error.message }, { status: 500 });

  const righe = data ?? [];
  return NextResponse.json({ messaggi: dopoParam != null ? righe : [...righe].reverse() });
}
