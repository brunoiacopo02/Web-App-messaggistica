/**
 * I SID che il presidio UTILITY lascia passare anche se Meta li ha classificati MARKETING.
 * Oltre a UTILITY_ONLY_ALLOW:
 * - i due template a pulsanti della sera del webinar ("Chiamami subito / Fissiamo domani"
 *   e la versione diurna): partono SOLO dentro la finestra di 24 ore, come risposta al lead
 *   che ha appena premuto il pulsante della live (PO 30/09: la scelta e' il cuore della serata);
 * - il follow-up del lancio (PO 06/10/2026): Meta ha approvato il v4 come MARKETING su tutti
 *   e tre gli account e Bruno lo manda lo stesso, a 1.000 al giorno spalmati 9-18:30.
 *   Variabile a parte perche' UTILITY_ONLY_ALLOW e' sensitive e non si rilegge per aggiungerci un SID.
 */
export function sidSbloccati(): string[] {
  const sbloccati = (process.env.UTILITY_ONLY_ALLOW ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const k of ['LANCIO_SCELTA_NOTTE_TEMPLATE_SID', 'LANCIO_SCELTA_GIORNO_TEMPLATE_SID', 'LANCIO_FOLLOWUP_MARKETING_SID']) {
    const v = (process.env[k] ?? '').trim();
    if (v) sbloccati.push(v);
  }
  return sbloccati;
}
