import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { richiediAdmin } from '@/lib/console/guardia';
import { paginaChat } from '@/lib/console/viste-db';
import { isVista } from '@/lib/console/viste';
import { LANCIO_FASI } from '@/lib/lancio-fase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const admin = await richiediAdmin();
  if (!admin.ok) return admin.risposta;

  const url = new URL(req.url);
  const vista = url.searchParams.get('vista');
  if (!isVista(vista)) return NextResponse.json({ error: 'vista_non_valida' }, { status: 400 });

  const faseParam = url.searchParams.get('fase');
  const fase = faseParam && (LANCIO_FASI as readonly string[]).includes(faseParam) ? faseParam : undefined;
  const soloNonLette = url.searchParams.get('solo') === 'non_lette';
  const q = url.searchParams.get('q') ?? undefined;
  const cursore = url.searchParams.get('cursore') ?? undefined;

  try {
    const res = await paginaChat(getSupabaseAdmin(), { vista, fase, soloNonLette, q, cursore, now: new Date() });
    return NextResponse.json(res);
  } catch (e) {
    return NextResponse.json({ error: 'lettura_fallita', dettaglio: (e as Error).message }, { status: 500 });
  }
}
