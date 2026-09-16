/**
 * L'ora "vera" di un turno del lancio. Tutte le regole di finestra (blast, assistenza,
 * post-pitch, ore proponibili) derivano da `lancio_evento_at` e da QUESTO istante: la
 * prova generale del B6 sposta l'orologio da qui, con `LANCIO_FAKE_NOW` (ISO con offset).
 *
 * In produzione la finta vale solo se `LANCIO_FAKE_NOW_ARMED` è uguale a `CRON_SECRET`:
 * una env dimenticata dopo una prova non può spostare l'ora a 3.000 lead la sera del 5.
 * Il cron del blast ha il suo `?now=` (già dietro l'auth del cron) e non passa da qui.
 *
 * Solo i turni del lancio la usano: Mario continua a leggere `new Date()`.
 */
export function adessoLancio(env: Partial<NodeJS.ProcessEnv> = process.env): Date {
  const raw = env.LANCIO_FAKE_NOW?.trim();
  if (!raw) return new Date();
  const inProduzione = env.NODE_ENV === 'production';
  const armata = !!env.CRON_SECRET && env.LANCIO_FAKE_NOW_ARMED === env.CRON_SECRET;
  if (inProduzione && !armata) return new Date();
  const t = Date.parse(raw);
  // Una finta illeggibile non ferma il turno: si va con l'ora vera. Sbagliare in questa
  // direzione costa una prova generale da rifare; nell'altra, un turno che non parte.
  return Number.isNaN(t) ? new Date() : new Date(t);
}
