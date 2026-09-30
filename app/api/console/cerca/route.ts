import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { richiediAdmin } from '@/lib/console/guardia';
import { cercaChat } from '@/lib/console/viste-db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_Q = 100;

/** Ricerca chat della palette (Ctrl+K): nome o telefono, nel perimetro Fenice, al massimo 10 righe. */
export async function GET(req: NextRequest) {
  const admin = await richiediAdmin();
  if (!admin.ok) return admin.risposta;

  const q = (req.nextUrl.searchParams.get('q') ?? '').trim();
  if (q === '' || q.length > MAX_Q) return NextResponse.json({ error: 'q_non_valida' }, { status: 400 });

  try {
    const righe = await cercaChat(getSupabaseAdmin(), q, new Date());
    return NextResponse.json({ righe });
  } catch (e) {
    return NextResponse.json({ error: 'lettura_fallita', dettaglio: (e as Error).message }, { status: 500 });
  }
}
