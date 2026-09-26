import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { richiediAdmin } from '@/lib/console/guardia';
import { contaViste } from '@/lib/console/viste-db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const admin = await richiediAdmin();
  if (!admin.ok) return admin.risposta;

  const now = new Date();
  try {
    const conteggi = await contaViste(getSupabaseAdmin(), now);
    return NextResponse.json({ conteggi, generatoAt: now.toISOString() });
  } catch (e) {
    return NextResponse.json({ error: 'lettura_fallita', dettaglio: (e as Error).message }, { status: 500 });
  }
}
