import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { richiediAdmin } from '@/lib/console/guardia';
import { FINESTRA_LOG_MS, LIMITE_LOG, leggiFiltriLog, type RigaLog, type RispostaLog } from '@/lib/console/log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Oltre questo tempo la lettura si abbandona: con il filtro per chat `event_log` si scandisce per JSON. */
const TETTO_MS = 8000;

/**
 * Una pagina di `event_log` per la console: al massimo 100 righe, dalla più recente, a cursore
 * su `created_at` (`prima=` esclusivo). Filtri: `tipo` (esatto), `livello`, `conv` (id chat nel
 * payload). La lettura ha sempre una finestra di 7 giorni sotto il cursore: se la pagina non si
 * riempie, `prossimo` è l'inizio della finestra e la pagina dopo guarda i 7 giorni precedenti.
 */
export async function GET(req: Request) {
  const admin = await richiediAdmin();
  if (!admin.ok) return admin.risposta;

  const filtri = leggiFiltriLog(new URL(req.url).searchParams);
  if (!filtri) return NextResponse.json({ errore: 'filtri_non_validi' }, { status: 400 });

  const fine = filtri.prima ? new Date(filtri.prima) : new Date();
  const finestraDa = new Date(fine.getTime() - FINESTRA_LOG_MS).toISOString();

  let q = getSupabaseAdmin()
    .from('event_log')
    .select('id, type, level, message, created_at, payload')
    .gte('created_at', finestraDa);
  if (filtri.prima) q = q.lt('created_at', filtri.prima);
  if (filtri.tipo) q = q.eq('type', filtri.tipo);
  if (filtri.livello) q = q.eq('level', filtri.livello);
  if (filtri.conv !== null) q = q.eq('payload->>conversationId', String(filtri.conv));

  try {
    const { data, error } = await q
      .order('created_at', { ascending: false })
      .limit(LIMITE_LOG)
      .abortSignal(AbortSignal.timeout(TETTO_MS));
    if (error) {
      const lenta = /abort/i.test(`${error.message ?? ''} ${(error as { name?: string }).name ?? ''}`);
      return NextResponse.json(
        { errore: lenta ? 'lettura_lenta' : 'lettura_fallita', dettaglio: error.message },
        { status: lenta ? 504 : 500 },
      );
    }
    const righe = (data ?? []) as RigaLog[];
    const piena = righe.length === LIMITE_LOG;
    const corpo: RispostaLog = { righe, prossimo: piena ? righe[righe.length - 1].created_at : finestraDa, finestraDa, piena };
    return NextResponse.json(corpo);
  } catch (e) {
    return NextResponse.json({ errore: 'lettura_lenta', dettaglio: e instanceof Error ? e.message : String(e) }, { status: 504 });
  }
}
