import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { richiediAdmin } from '@/lib/console/guardia';
import { leggiRegia } from '@/lib/console/regia-db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const admin = await richiediAdmin();
  if (!admin.ok) return admin.risposta;

  try {
    return NextResponse.json(await leggiRegia(getSupabaseAdmin(), new Date()));
  } catch (e) {
    return NextResponse.json({ error: 'lettura_fallita', dettaglio: (e as Error).message }, { status: 500 });
  }
}
