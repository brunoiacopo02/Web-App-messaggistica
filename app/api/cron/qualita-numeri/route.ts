import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { eseguiControlloQualita } from '@/lib/qualita-numeri';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Controllo della qualita' dei numeri (PO 29/10/2026): legge il rating Meta dei
 * numeri del bot, ferma per 3 giorni un numero del giro sceso sotto HIGH, lo fa
 * ripartire quando torna HIGH, rimette il 3199 nel giro a 30 dopo 7 giorni HIGH.
 * Le regole stanno in lib/qualita-numeri.ts. `QUALITA_NUMERI_AUTO=off` = solo lettura.
 */
function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get('authorization') === `Bearer ${secret}`;
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return new NextResponse('unauthorized', { status: 401 });
  const esito = await eseguiControlloQualita(getSupabaseAdmin());
  return NextResponse.json(esito, { status: esito.ok ? 200 : 500 });
}
