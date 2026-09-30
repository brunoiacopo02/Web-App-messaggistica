import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { richiediAdmin } from '@/lib/console/guardia';
import { anteprima, ErroreAzione } from '@/lib/console/azioni';
import { ID_AZIONI } from '@/lib/console/azioni-tipi';
import { rispostaErroreAzione } from '../errori';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// La prova a vuoto degli arretrati legge tutta la coda: puo' durare quanto il giro vero.
export const maxDuration = 300;

const Corpo = z.object({ azione: z.enum(ID_AZIONI), params: z.unknown().optional() });

/**
 * Prova a vuoto: dice cosa succederebbe e restituisce il token firmato per confermare.
 * Non manda niente ai lead né al CRM, ma non è a scrittura zero: la prova di `agenda-delivery`
 * in `arretrati` lascia comunque la sua riga di riepilogo in event_log.
 */
export async function POST(req: Request) {
  const admin = await richiediAdmin();
  if (!admin.ok) return admin.risposta;

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ errore: 'corpo_non_valido' }, { status: 400 });
  }
  const c = Corpo.safeParse(json);
  if (!c.success) return NextResponse.json({ errore: 'azione_sconosciuta' }, { status: 400 });

  try {
    const a = await anteprima(c.data.azione, c.data.params ?? {}, {
      s: getSupabaseAdmin(),
      origin: new URL(req.url).origin,
      email: admin.email,
      now: new Date(),
    });
    return NextResponse.json(a);
  } catch (e) {
    if (e instanceof z.ZodError) {
      return NextResponse.json({ errore: 'parametri_non_validi', dettaglio: e.issues.map((i) => i.message).join('; ') }, { status: 400 });
    }
    if (e instanceof ErroreAzione) return rispostaErroreAzione(e);
    return NextResponse.json({ errore: 'anteprima_fallita', dettaglio: (e as Error).message }, { status: 502 });
  }
}
