import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { configRecupero, eseguiRecupero } from '@/lib/recupero-aperture';
import { depsRecupero } from '@/lib/recupero-aperture-deps';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/**
 * Recupero delle aperture mai partite (PO 06/11/2026): le chat arruolate prima del
 * 06/11 07:00 UTC a cui il bot non ha mai scritto, aperte a piccoli lotti in
 * 09:30-20:30 Roma. SPENTO finche' `RECUPERO_APERTURE_GIORNALIERE` e' assente o 0.
 * Le regole stanno in lib/recupero-aperture.ts.
 *
 * Il cron in vercel.json e' in UTC e largo (06-19): la finestra la decide il codice.
 */
function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get('authorization') === `Bearer ${secret}`;
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return new NextResponse('unauthorized', { status: 401 });
  const cfg = configRecupero();
  // Spento: nessuna query, nessun log.
  if (cfg.tetto <= 0) return NextResponse.json({ ok: true, disabled: true });
  const adesso = new Date();
  const report = await eseguiRecupero(cfg, depsRecupero(getSupabaseAdmin(), cfg, adesso), adesso.getTime());
  return NextResponse.json({ ok: true, ...report });
}
