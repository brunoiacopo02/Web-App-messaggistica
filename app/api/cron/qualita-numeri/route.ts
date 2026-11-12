import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { eseguiControlloQualita } from '@/lib/qualita-numeri';
import { controllaStopTouchAb } from '@/lib/touch-ab';
import { aggiornaSospensioniSollecitiNr } from '@/lib/solleciti-nr-sospesi';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Controllo della qualita' dei numeri (PO 29/10/2026): legge il rating Meta dei
 * numeri del bot, ferma per 3 giorni un numero del giro sceso sotto HIGH, lo fa
 * ripartire quando torna HIGH, rimette il 3199 nel giro a 30 dopo 4 giorni HIGH
 * di fila e a regime dopo altri 4.
 * Le regole stanno in lib/qualita-numeri.ts. `QUALITA_NUMERI_AUTO=off` = solo lettura.
 */
function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get('authorization') === `Bearer ${secret}`;
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return new NextResponse('unauthorized', { status: 401 });
  const supabase = getSupabaseAdmin();
  const esito = await eseguiControlloQualita(supabase);
  // A/B del touch (PO 07/11/2026): lo stop a scatto scatta alla lettura, non al primo invio.
  if (esito.ok) await controllaStopTouchAb(supabase);
  // Solleciti dopo i "non risponde" delle Conferme sospesi su un numero (PO 12/11/2026):
  // si riaccendono da soli dopo 7 giorni HIGH di fila. Dopo lo storico di oggi; non lancia.
  const solleciti = esito.ok ? await aggiornaSospensioniSollecitiNr(supabase) : { riaccesi: [] };
  return NextResponse.json({ ...esito, sollecitiNrRiaccesi: solleciti.riaccesi }, { status: esito.ok ? 200 : 500 });
}
