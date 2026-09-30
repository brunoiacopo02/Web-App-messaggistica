import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { richiediAdmin } from '@/lib/console/guardia';
import { leggiAvvisi } from '@/lib/console/avvisi-db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET() {
  const admin = await richiediAdmin();
  if (!admin.ok) return admin.risposta;

  const now = new Date();
  try {
    const avvisi = await leggiAvvisi(getSupabaseAdmin(), now);
    return NextResponse.json({ avvisi, generatoAt: now.toISOString() });
  } catch (e) {
    return NextResponse.json({ error: 'lettura_fallita', dettaglio: (e as Error).message }, { status: 500 });
  }
}

const Corpo = z.object({
  id: z.string().min(1).max(100),
  firma: z.string().min(1).max(200),
  nota: z.string().max(500).optional(),
});

/** "Segna risolto": l'avviso resta nascosto finche' la sua firma (id, conteggio, ultimo evento) non cambia. */
export async function POST(req: Request) {
  const admin = await richiediAdmin();
  if (!admin.ok) return admin.risposta;

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ error: 'corpo_non_valido' }, { status: 400 });
  }
  const p = Corpo.safeParse(json);
  if (!p.success) {
    return NextResponse.json({ error: 'corpo_non_valido', dettaglio: 'servono id e firma; la nota al massimo 500 caratteri' }, { status: 400 });
  }

  const { error } = await getSupabaseAdmin().from('event_log').insert({
    type: 'console_avviso_risolto',
    level: 'info',
    message: `Avviso ${p.data.id} segnato come risolto da ${admin.email}`,
    payload: { id: p.data.id, firma: p.data.firma, nota: p.data.nota ?? null, by: admin.email } as never,
  });
  if (error) return NextResponse.json({ error: 'scrittura_fallita', dettaglio: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
