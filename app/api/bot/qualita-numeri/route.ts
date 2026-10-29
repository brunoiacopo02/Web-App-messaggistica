import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { verifySignature } from '@/lib/bot-hmac';
import { giornoRoma } from '@/lib/qualita-numeri';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Una richiesta firmata vale 5 minuti: oltre e' una replica, non una domanda nuova. */
const VALIDITA_MS = 5 * 60 * 1000;

/**
 * Il CRM chiede lo stato dei numeri (PO 29/10/2026): la regola "fasce solo GDO"
 * si accende da sola quando un numero del giro delle aperture a freddo non e'
 * HIGH o e' in pausa, e si spegne quando tornano tutti HIGH.
 *
 * Sola lettura di `app_settings.qualita_numeri_stato` (lo scrive il cron
 * qualita-numeri) e `tetti_numeri`. La decisione la prende il CRM: qui si
 * restituiscono i dati come sono.
 *
 * Stessa firma HMAC di `/api/bot/intake`; il corpo e' `{"ts":"<ISO>"}` e vale
 * cinque minuti.
 */
export async function POST(req: NextRequest) {
  const secret = process.env.BOT_WEBHOOK_SECRET;
  if (!secret) return NextResponse.json({ ok: false, error: 'not_configured' }, { status: 503 });

  const raw = await req.text();
  const firma = verifySignature(raw, req.headers.get('x-bot-signature'), secret);
  if (!firma.valid) return NextResponse.json({ ok: false, error: firma.reason }, { status: 401 });

  let ts: number;
  try {
    ts = Date.parse(String((JSON.parse(raw) as { ts?: unknown }).ts));
  } catch {
    return NextResponse.json({ ok: false, error: 'bad_json' }, { status: 400 });
  }
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > VALIDITA_MS) {
    return NextResponse.json({ ok: false, error: 'stale' }, { status: 401 });
  }

  const { data, error } = await getSupabaseAdmin()
    .from('app_settings')
    .select('key, value')
    .in('key', ['qualita_numeri_stato', 'tetti_numeri']);
  if (error) return NextResponse.json({ ok: false, error: 'db' }, { status: 500 });

  const valore = (k: string) => data?.find((r) => r.key === k)?.value ?? null;
  return NextResponse.json(
    {
      ok: true,
      oggi: giornoRoma(new Date()),
      stato: valore('qualita_numeri_stato'),
      tetti: valore('tetti_numeri'),
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}
