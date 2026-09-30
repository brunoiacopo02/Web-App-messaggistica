import { NextResponse } from 'next/server';
import { ErroreAzione } from '@/lib/console/azioni';

/** I rifiuti prima dell'esecuzione: 409 con il codice (e la nuova anteprima se c'e'), 503 se manca il segreto dei cron. */
export function rispostaErroreAzione(e: ErroreAzione): Response {
  if (e.codice === 'cron_secret_mancante') {
    return NextResponse.json({ errore: e.codice, dettaglio: 'CRON_SECRET non impostato: le azioni sui cron non possono partire.' }, { status: 503 });
  }
  return NextResponse.json(
    e.nuovaAnteprima ? { errore: e.codice, nuovaAnteprima: e.nuovaAnteprima } : { errore: e.codice },
    { status: 409 },
  );
}
