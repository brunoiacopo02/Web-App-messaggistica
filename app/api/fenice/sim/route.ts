import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseServer } from '@/lib/supabase/server';
import { generateMarioReply, type MarioTurn } from '@/lib/mario';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const supabase = await getSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return new NextResponse('unauthorized', { status: 401 });

  let body: { history?: MarioTurn[] } = {};
  try {
    body = (await req.json()) as { history?: MarioTurn[] };
  } catch {
    return NextResponse.json({ ok: false, error: 'JSON non valido' }, { status: 400 });
  }

  const history = Array.isArray(body.history) ? body.history : [];
  // sanity: solo turni user/assistant con content stringa
  const clean = history
    .filter((t) => (t?.role === 'user' || t?.role === 'assistant') && typeof t?.content === 'string')
    .map((t) => ({ role: t.role, content: t.content }));

  try {
    const result = await generateMarioReply(clean);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'errore Claude';
    return NextResponse.json({ ok: false, error: msg }, { status: 502 });
  }
}
