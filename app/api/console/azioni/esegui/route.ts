import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { richiediAdmin } from '@/lib/console/guardia';
import { esegui, ErroreAzione } from '@/lib/console/azioni';
import { rispostaErroreAzione } from '../errori';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/** Esegue l'azione di un'anteprima: serve il token monouso e `conferma: true` esplicito. */
export async function POST(req: Request) {
  const admin = await richiediAdmin();
  if (!admin.ok) return admin.risposta;

  let json: { token?: unknown; conferma?: unknown };
  try {
    json = (await req.json()) as typeof json;
  } catch {
    return NextResponse.json({ errore: 'corpo_non_valido' }, { status: 400 });
  }
  if (!json || json.conferma !== true) {
    return NextResponse.json({ errore: 'conferma_mancante', dettaglio: 'Serve conferma: true.' }, { status: 400 });
  }
  if (typeof json.token !== 'string' || json.token === '') {
    return NextResponse.json({ errore: 'token_mancante' }, { status: 400 });
  }

  try {
    const esito = await esegui(json.token, {
      s: getSupabaseAdmin(),
      origin: new URL(req.url).origin,
      email: admin.email,
      now: new Date(),
    });
    return NextResponse.json(esito);
  } catch (e) {
    if (e instanceof ErroreAzione) return rispostaErroreAzione(e);
    return NextResponse.json({ errore: 'esecuzione_fallita', dettaglio: (e as Error).message }, { status: 500 });
  }
}
