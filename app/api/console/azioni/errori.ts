import { NextResponse } from 'next/server';
import { ErroreAzione } from '@/lib/console/azioni';

/**
 * I rifiuti prima dell'esecuzione: 409 con il codice (piu' la nuova anteprima o il testo
 * per l'admin quando ci sono), 503 se manca il segreto dei cron.
 */
export function rispostaErroreAzione(e: ErroreAzione): Response {
  if (e.codice === 'cron_secret_mancante') {
    return NextResponse.json({ errore: e.codice, dettaglio: 'CRON_SECRET non impostato: le azioni della console non possono partire.' }, { status: 503 });
  }
  return NextResponse.json(
    {
      errore: e.codice,
      ...(e.nuovaAnteprima ? { nuovaAnteprima: e.nuovaAnteprima } : {}),
      ...(e.spiegazione ? { messaggio: e.spiegazione } : {}),
    },
    { status: 409 },
  );
}
