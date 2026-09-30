import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { richiediAdmin } from '@/lib/console/guardia';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Le ultime 100 azioni lanciate dalla console, dalla piu' recente. */
export async function GET() {
  const admin = await richiediAdmin();
  if (!admin.ok) return admin.risposta;

  const { data, error } = await getSupabaseAdmin().from('event_log')
    .select('id, created_at, level, message, payload')
    .eq('type', 'console_azione')
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) return NextResponse.json({ errore: 'lettura_fallita', dettaglio: error.message }, { status: 500 });
  return NextResponse.json({ azioni: data ?? [] });
}
